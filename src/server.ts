import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import {
  calculateAccountReturns,
  calculateMarketReturns,
  DEFAULT_HOLIDAY_CALENDAR_DIR,
  findTradingDateOnOrBefore,
  parseTradesMarkdown,
  type MarketBenchmarkReturn,
} from "yangjian/calculation";

const DASHBOARD_SOURCE_DIR = path.join(__dirname, "../../src");
const DASHBOARD_CONFIG_PATH = path.join(DASHBOARD_SOURCE_DIR, "config.json");

interface Config {
  startWeek?: string;
  theme?: {
    upColor: string;
    upGlow: string;
    upTextGlow: string;
    downColor: string;
    downGlow: string;
    downTextGlow: string;
  };
}

function resolveYangjianRoot(): string {
  const fromEnv = process.env.YANGJIAN_ROOT;
  if (fromEnv) {
    return fromEnv;
  }
  throw new Error(
    "YANGJIAN_ROOT is not set. Please create a .env file with:\n  YANGJIAN_ROOT=/path/to/your/yangjian"
  );
}

interface DailyRecord {
  date: string; // YYYYMMDD
  weekName: string; // e.g. 2026-W26
  totalAsset: number;
  pnl: number;
  pnlRate: number;
  source: "snapshot" | "rebuilt" | "close"; // 数据来源标识
  updatedAt?: string;
  intraday?: IntradayPoint[];
}

interface IntradayPoint {
  time: string; // HH:mm
  updatedAt?: string;
  totalAsset: number;
  pnl: number;
  pnlRate: number;
}

interface TradeRecord {
  date: string; // YYYYMMDD
  tradeNo: number;
  action: "买入" | "卖出";
  symbol: string;
  name: string;
  price: number | null;
}

interface PeriodSummary {
  label: string; // e.g. "2026-W26", "2026-06", "2026"
  pnl: number;
  pnlRate: number;
  basisAsset: number;
  netDeposits: number;
  endAsset: number;
  benchmarks: MarketBenchmarkReturn[];
  days: DailyRecord[];
  trades?: TradeRecord[]; // Only for weekly summaries
  hasRebuiltData?: boolean; // 区间内是否包含 rebuilt 重建数据
  updatedAt?: string;
}

interface TodayMarketSummary {
  date: string;
  weekLabel: string;
  benchmarks: MarketBenchmarkReturn[];
}

interface DashboardPayload {
  todayMarket: TodayMarketSummary;
  weekly: PeriodSummary[];
  monthly: PeriodSummary[];
  yearly: PeriodSummary[];
  theme?: Config["theme"];
}

interface DashboardDataCache {
  sourceFingerprint: string;
  fullJson: string;
  publicJson: string;
}

interface SourceFingerprintMemo {
  checkedAt: number;
  value: string;
}

function calculatePeriodBenchmarks(startDate: string, endDate: string): MarketBenchmarkReturn[] {
  try {
    return calculateMarketReturns({
      journalDir: path.join(resolveYangjianRoot(), "journal"),
      startDate,
      endDate,
    }).benchmarks;
  } catch (error) {
    console.warn(`[market returns] calculation failed for ${startDate}-${endDate}`);
    return [];
  }
}

function calculateTodayMarket(): TodayMarketSummary {
  const today = todayYmdInShanghai();
  const date = findTradingDateOnOrBefore(today, DEFAULT_HOLIDAY_CALENDAR_DIR);
  return {
    date,
    weekLabel: isoWeekLabel(today),
    benchmarks: calculatePeriodBenchmarks(date, date),
  };
}

function todayYmdInShanghai(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}${value.month}${value.day}`;
}

function isoWeekLabel(value: string): string {
  const date = new Date(Date.UTC(
    Number(value.slice(0, 4)),
    Number(value.slice(4, 6)) - 1,
    Number(value.slice(6, 8)),
  ));
  const weekday = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - weekday);
  const isoYear = date.getUTCFullYear();
  const yearStart = new Date(Date.UTC(isoYear, 0, 1));
  const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${isoYear}-W${String(week).padStart(2, "0")}`;
}

// Helper to load configurations
function loadConfig(): Config {
  if (!fs.existsSync(DASHBOARD_CONFIG_PATH)) {
    throw new Error("Dashboard config file not found");
  }
  return JSON.parse(fs.readFileSync(DASHBOARD_CONFIG_PATH, "utf8")) as Config;
}

// Helpers for money parsing
function parseMoney(value: string): number {
  const cleaned = value.replace(/[,+元%\s]/g, "");
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseTableMoney(content: string, label: string): number | null {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^\\|\\s*${escaped}\\s*\\|\\s*([^|]+?)\\s*\\|`, "m");
  const raw = content.match(pattern)?.[1];
  return raw ? parseMoney(raw) : null;
}

function normalizeTradeName(name: string): string {
  return name
    .replace(/^[\/\s]+/, "")
    .replace(/[（(]\s*[）)]/g, "")
    .trim();
}

function getLatestUpdatedAt(days: DailyRecord[]): string | undefined {
  return days
    .map((d) => d.updatedAt)
    .filter((value): value is string => Boolean(value))
    .sort((a, b) => b.localeCompare(a))[0];
}

function formatSessionTime(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (/^\d{4}$/.test(raw)) {
    return `${raw.slice(0, 2)}:${raw.slice(2, 4)}`;
  }
  if (/^\d{2}:\d{2}$/.test(raw)) {
    return raw;
  }
  return raw;
}

// Parse trades from trades/*.md files for a given week
function parseTradesForWeek(yangjianRoot: string, weekName: string): TradeRecord[] {
  const tradesDir = path.join(yangjianRoot, "trades");
  if (!fs.existsSync(tradesDir)) {
    return [];
  }

  // Get date range for this week from journal directory
  const weekDir = path.join(yangjianRoot, "journal", weekName);
  if (!fs.existsSync(weekDir)) {
    return [];
  }

  const dateNames = fs.readdirSync(weekDir).filter((name) => {
    return /^\d{8}$/.test(name) && fs.statSync(path.join(weekDir, name)).isDirectory();
  });

  const trades: TradeRecord[] = [];

  for (const dateName of dateNames) {
    const tradesFilePath = path.join(tradesDir, `${dateName}.md`);
    if (!fs.existsSync(tradesFilePath)) {
      continue;
    }

    try {
      const content = fs.readFileSync(tradesFilePath, "utf8");
      const parsedTrades = parseTradesMarkdown(content);
      
      for (const trade of parsedTrades) {
        trades.push({
          date: dateName,
          tradeNo: trade.tradeNo,
          action: trade.action,
          symbol: trade.symbol,
          name: normalizeTradeName(trade.name),
          price: trade.tradePrice,
        });
      }
    } catch (e) {
      // Ignore parsing errors
      console.error(`[trades] parsing failed for ${dateName}`);
    }
  }

  // Sort by date and trade number
  return trades.sort((a, b) => {
    const dateCmp = a.date.localeCompare(b.date);
    return dateCmp !== 0 ? dateCmp : a.tradeNo - b.tradeNo;
  });
}

// Core parsing logic
function scanJournalData(yangjianRoot: string): DailyRecord[] {
  const journalDir = path.join(yangjianRoot, "journal");
  if (!fs.existsSync(journalDir)) {
    return [];
  }

  const records: DailyRecord[] = [];

  let startWeek = "2026-W20";
  try {
    const config = loadConfig();
    if (config.startWeek) {
      startWeek = config.startWeek;
    }
  } catch (e) {
    // Ignore
  }

  const weekNames = fs.readdirSync(journalDir).filter((name) => {
    return fs.statSync(path.join(journalDir, name)).isDirectory() && name.includes("-W") && name >= startWeek;
  });

  for (const weekName of weekNames) {
    const weekDir = path.join(journalDir, weekName);
    const dateNames = fs.readdirSync(weekDir).filter((name) => {
      return /^\d{8}$/.test(name) && fs.statSync(path.join(weekDir, name)).isDirectory();
    });

    for (const dateName of dateNames) {
      const dayDir = path.join(weekDir, dateName);
      const snapshotPath = path.join(dayDir, "account-snapshots.json");
      const rebuiltPath = path.join(dayDir, "account-snapshots.rebuilt.json");
      const closePath = path.join(dayDir, "close.md");

      let totalAsset = 0;
      let pnl = 0;
      let pnlRate = 0;
      let parsedSuccessfully = false;
      let source: DailyRecord["source"] = "close";
      let updatedAt: string | undefined;
      let intraday: IntradayPoint[] = [];

      // 1. Try account-snapshots.json first, then fall back to rebuilt.json
      const snapshotFile = fs.existsSync(snapshotPath)
        ? snapshotPath
        : fs.existsSync(rebuiltPath) ? rebuiltPath : null;
      if (snapshotFile) {
        source = snapshotFile === snapshotPath ? "snapshot" : "rebuilt";
        try {
          const snapshot = JSON.parse(fs.readFileSync(snapshotFile, "utf8"));
          const prevClose = snapshot.prevCloseTotalAsset ?? 0;
          const sessions = Array.isArray(snapshot.sessions) ? snapshot.sessions : [];
          intraday = sessions
            .filter((s: any) => typeof s === "object" && s !== null && s.time && s.summary)
            .map((s: any) => {
              const sessionTotalAsset = s.summary.totalAsset ?? 0;
              const sessionPnl = s.summary.todayNetWorthPnl ?? (sessionTotalAsset - prevClose);
              const sessionPnlRate = s.summary.todayNetWorthPnlRate ?? (prevClose === 0 ? 0 : sessionPnl / prevClose);

              return {
                time: formatSessionTime(s.time),
                updatedAt: s.updatedAt,
                totalAsset: Math.round(sessionTotalAsset * 100) / 100,
                pnl: Math.round(sessionPnl * 100) / 100,
                pnlRate: Math.round(sessionPnlRate * 10000) / 10000,
              };
            })
            .sort((a: IntradayPoint, b: IntradayPoint) => a.time.localeCompare(b.time));
          
          // Select latest session
          const latestSession = sessions
            .filter((s: any) => typeof s === "object" && s !== null && s.time)
            .sort((a: any, b: any) => String(b.time).localeCompare(String(a.time)))[0];

          if (latestSession && latestSession.summary) {
            totalAsset = latestSession.summary.totalAsset ?? 0;
            pnl = latestSession.summary.todayNetWorthPnl ?? (totalAsset - prevClose);
            pnlRate = latestSession.summary.todayNetWorthPnlRate ?? (prevClose === 0 ? 0 : pnl / prevClose);
            updatedAt = latestSession.updatedAt;
            parsedSuccessfully = true;
          }
        } catch (e) {
          // Fallback to close.md if JSON parsing fails
        }
      }

      // 2. Fallback to close.md
      if (!parsedSuccessfully && fs.existsSync(closePath)) {
        try {
          const content = fs.readFileSync(closePath, "utf8");
          const assetVal = parseTableMoney(content, "总资产");
          if (assetVal !== null) {
            totalAsset = assetVal;
            
            // Extract 今日盈亏 from table
            const pnlMatch = content.match(/\|\s*今日盈亏\s*\|\s*([+-]?[\d,.]+)\s*元?\s*\/\s*([+-]?[\d,.]+)%\s*\|/);
            if (pnlMatch) {
              pnl = parseMoney(pnlMatch[1]);
              pnlRate = parseMoney(pnlMatch[2]) / 100;
            } else {
              pnl = 0;
              pnlRate = 0;
            }
            parsedSuccessfully = true;
          }
        } catch (e) {
          // Ignore
        }
      }

      if (parsedSuccessfully) {
        records.push({
          date: dateName,
          weekName,
          totalAsset: Math.round(totalAsset * 100) / 100,
          pnl: Math.round(pnl * 100) / 100,
          pnlRate: Math.round(pnlRate * 10000) / 10000,
          source,
          updatedAt,
          intraday,
        });
      }
    }
  }

  // Sort chronologically
  return records.sort((a, b) => a.date.localeCompare(b.date));
}

// Compute Weekly Summaries
function computeWeekly(records: DailyRecord[]): PeriodSummary[] {
  const groups: Record<string, DailyRecord[]> = {};
  for (const r of records) {
    if (!groups[r.weekName]) groups[r.weekName] = [];
    groups[r.weekName].push(r);
  }

  const summaries: PeriodSummary[] = [];
  const sortedWeeks = Object.keys(groups).sort();

  for (let idx = 0; idx < sortedWeeks.length; idx++) {
    const weekName = sortedWeeks[idx];
    const days = groups[weekName].sort((a, b) => a.date.localeCompare(b.date));
    const firstDay = days[0].date;
    const lastDay = days[days.length - 1].date;

    let pnl = days.reduce((sum, d) => sum + d.pnl, 0);
    let basisAsset = 0;
    let netDeposits = 0;
    let endAsset = 0;
    let pnlRate = 0;

    try {
      const res = calculateAccountReturns({
        journalDir: path.join(resolveYangjianRoot(), "journal"),
        startDate: firstDay,
        endDate: lastDay,
        targetReturnRate: 0.03,
      });
      pnl = res.pnl;
      pnlRate = res.returnRate;
      basisAsset = res.basisAsset;
      netDeposits = res.netDeposits ?? 0;
      endAsset = res.endAsset;
    } catch (e) {
      if (idx > 0) {
        const prevWeekDays = groups[sortedWeeks[idx - 1]];
        basisAsset = prevWeekDays[prevWeekDays.length - 1].totalAsset;
      } else {
        basisAsset = days[0].totalAsset - days[0].pnl;
      }
      endAsset = days[days.length - 1].totalAsset;
      pnlRate = basisAsset === 0 ? 0 : pnl / basisAsset;
    }

    // Parse trades for this week
    const trades = parseTradesForWeek(resolveYangjianRoot(), weekName);

    summaries.push({
      label: weekName,
      pnl: Math.round(pnl * 100) / 100,
      pnlRate: Math.round(pnlRate * 10000) / 10000,
      basisAsset: Math.round(basisAsset * 100) / 100,
      netDeposits: Math.round(netDeposits * 100) / 100,
      endAsset: Math.round(endAsset * 100) / 100,
      benchmarks: calculatePeriodBenchmarks(firstDay, lastDay),
      days,
      trades,
      hasRebuiltData: days.some((d) => d.source === "rebuilt"),
      updatedAt: getLatestUpdatedAt(days),
    });
  }

  return summaries;
}

// Compute Monthly Summaries
function computeMonthly(records: DailyRecord[]): PeriodSummary[] {
  const groups: Record<string, DailyRecord[]> = {};
  for (const r of records) {
    const month = `${r.date.slice(0, 4)}-${r.date.slice(4, 6)}`; // e.g. 2026-06
    if (!groups[month]) groups[month] = [];
    groups[month].push(r);
  }

  const summaries: PeriodSummary[] = [];
  const sortedMonths = Object.keys(groups).sort();

  for (let idx = 0; idx < sortedMonths.length; idx++) {
    const monthName = sortedMonths[idx];
    const days = groups[monthName].sort((a, b) => a.date.localeCompare(b.date));
    const firstDay = days[0].date;
    const lastDay = days[days.length - 1].date;

    let pnl = days.reduce((sum, d) => sum + d.pnl, 0);
    let basisAsset = 0;
    let netDeposits = 0;
    let endAsset = 0;
    let pnlRate = 0;

    try {
      const res = calculateAccountReturns({
        journalDir: path.join(resolveYangjianRoot(), "journal"),
        startDate: firstDay,
        endDate: lastDay,
        targetReturnRate: 0.03,
      });
      pnl = res.pnl;
      pnlRate = res.returnRate;
      basisAsset = res.basisAsset;
      netDeposits = res.netDeposits ?? 0;
      endAsset = res.endAsset;
    } catch (e) {
      if (idx > 0) {
        const prevMonthDays = groups[sortedMonths[idx - 1]];
        basisAsset = prevMonthDays[prevMonthDays.length - 1].totalAsset;
      } else {
        basisAsset = days[0].totalAsset - days[0].pnl;
      }
      endAsset = days[days.length - 1].totalAsset;
      pnlRate = basisAsset === 0 ? 0 : pnl / basisAsset;
    }

    summaries.push({
      label: monthName,
      pnl: Math.round(pnl * 100) / 100,
      pnlRate: Math.round(pnlRate * 10000) / 10000,
      basisAsset: Math.round(basisAsset * 100) / 100,
      netDeposits: Math.round(netDeposits * 100) / 100,
      endAsset: Math.round(endAsset * 100) / 100,
      benchmarks: calculatePeriodBenchmarks(firstDay, lastDay),
      days,
      hasRebuiltData: days.some((d) => d.source === "rebuilt"),
      updatedAt: getLatestUpdatedAt(days),
    });
  }

  return summaries;
}

// Compute Yearly Summaries
function computeYearly(records: DailyRecord[]): PeriodSummary[] {
  const groups: Record<string, DailyRecord[]> = {};
  for (const r of records) {
    const year = r.date.slice(0, 4); // e.g. 2026
    if (!groups[year]) groups[year] = [];
    groups[year].push(r);
  }

  const summaries: PeriodSummary[] = [];
  const sortedYears = Object.keys(groups).sort();

  for (let idx = 0; idx < sortedYears.length; idx++) {
    const yearName = sortedYears[idx];
    const days = groups[yearName].sort((a, b) => a.date.localeCompare(b.date));
    const firstDay = days[0].date;
    const lastDay = days[days.length - 1].date;

    let pnl = days.reduce((sum, d) => sum + d.pnl, 0);
    let basisAsset = 0;
    let netDeposits = 0;
    let endAsset = 0;
    let pnlRate = 0;

    try {
      const res = calculateAccountReturns({
        journalDir: path.join(resolveYangjianRoot(), "journal"),
        startDate: firstDay,
        endDate: lastDay,
        targetReturnRate: 0.03,
      });
      pnl = res.pnl;
      pnlRate = res.returnRate;
      basisAsset = res.basisAsset;
      netDeposits = res.netDeposits ?? 0;
      endAsset = res.endAsset;
    } catch (e) {
      if (idx > 0) {
        const prevYearDays = groups[sortedYears[idx - 1]];
        basisAsset = prevYearDays[prevYearDays.length - 1].totalAsset;
      } else {
        basisAsset = days[0].totalAsset - days[0].pnl;
      }
      endAsset = days[days.length - 1].totalAsset;
      pnlRate = basisAsset === 0 ? 0 : pnl / basisAsset;
    }

    summaries.push({
      label: yearName,
      pnl: Math.round(pnl * 100) / 100,
      pnlRate: Math.round(pnlRate * 10000) / 10000,
      basisAsset: Math.round(basisAsset * 100) / 100,
      netDeposits: Math.round(netDeposits * 100) / 100,
      endAsset: Math.round(endAsset * 100) / 100,
      benchmarks: calculatePeriodBenchmarks(firstDay, lastDay),
      days,
      hasRebuiltData: days.some((d) => d.source === "rebuilt"),
      updatedAt: getLatestUpdatedAt(days),
    });
  }

  return summaries;
}


// ============================================================
// 安全策略
// - /api/public: 公开安全数据（保留交易明细，隐藏买入卖出价格）
// - /api/data:   完整数据（含 trades），需 ?auth_token=xxx 认证
// - 错误信息脱敏，不暴露内部路径
// - 仅监听 127.0.0.1，由 Nginx 做访问控制
// ============================================================

const PORT = Number(process.env.PORT) || 3000;
const AUTH_TOKEN = process.env.AUTH_TOKEN || "";
const HOST = process.env.DASHBOARD_HOST || "127.0.0.1";
const SOURCE_CHECK_INTERVAL_MS = parseBoundedInteger(
  process.env.DATA_SOURCE_CHECK_INTERVAL_MS,
  1_000,
  250,
  60_000,
);
const EXPOSE_CACHE_STATUS = process.env.DASHBOARD_CACHE_DEBUG === "1";
const STATIC_ASSET_VERSION = crypto
  .createHash("sha256")
  .update(fs.readFileSync(path.join(DASHBOARD_SOURCE_DIR, "app.js")))
  .update(fs.readFileSync(path.join(DASHBOARD_SOURCE_DIR, "style.css")))
  .digest("hex")
  .slice(0, 12);

/** 从 PeriodSummary 数组中掩码 trades 的价格，保留交易明细 */
function maskTradePrices(periods: PeriodSummary[]): PeriodSummary[] {
  return periods.map((p) => ({
    ...p,
    trades: p.trades?.map((t) => ({ ...t, price: null })),
  }));
}

function parseBoundedInteger(
  rawValue: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number(rawValue);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    return fallback;
  }
  return parsed;
}

function updateFingerprintWithFile(
  hash: crypto.Hash,
  filePath: string,
  publicLabel: string,
): void {
  if (!fs.existsSync(filePath)) {
    hash.update(`missing:${publicLabel}\0`);
    return;
  }

  const stat = fs.statSync(filePath, { bigint: true });
  hash.update(
    `file:${publicLabel}:${stat.size.toString()}:${stat.mtimeNs.toString()}\0`,
  );
}

/**
 * 将目录内文件的相对路径和元数据加入指纹。
 * 不读取文件内容、不跟随符号链接，也不把机器绝对路径写入缓存或响应。
 */
function updateFingerprintWithTree(
  hash: crypto.Hash,
  rootDir: string,
  publicLabel: string,
): void {
  if (!fs.existsSync(rootDir)) {
    hash.update(`missing-tree:${publicLabel}\0`);
    return;
  }

  const visit = (currentDir: string, relativeDir: string): void => {
    const entries = fs
      .readdirSync(currentDir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      const absolutePath = path.join(currentDir, entry.name);
      const relativePath = relativeDir
        ? `${relativeDir}/${entry.name}`
        : entry.name;

      if (entry.isDirectory()) {
        visit(absolutePath, relativePath);
        continue;
      }

      if (entry.isFile()) {
        const stat = fs.statSync(absolutePath, { bigint: true });
        hash.update(
          `file:${publicLabel}/${relativePath}:${stat.size.toString()}:${stat.mtimeNs.toString()}\0`,
        );
        continue;
      }

      // 数据目录不应依赖符号链接；仅记录链接自身元数据，避免遍历到项目外部。
      const stat = fs.lstatSync(absolutePath, { bigint: true });
      hash.update(
        `other:${publicLabel}/${relativePath}:${stat.size.toString()}:${stat.mtimeNs.toString()}\0`,
      );
    }
  };

  visit(rootDir, "");
}

let dashboardDataCache: DashboardDataCache | null = null;
let sourceFingerprintMemo: SourceFingerprintMemo | null = null;

function calculateSourceFingerprint(): string {
  const now = Date.now();
  if (
    sourceFingerprintMemo
    && now - sourceFingerprintMemo.checkedAt < SOURCE_CHECK_INTERVAL_MS
  ) {
    return sourceFingerprintMemo.value;
  }

  const yangjianRoot = resolveYangjianRoot();
  const hash = crypto.createHash("sha256");
  hash.update(`dashboard-data-v1\0day:${todayYmdInShanghai()}\0`);
  updateFingerprintWithFile(hash, DASHBOARD_CONFIG_PATH, "dashboard-config");
  updateFingerprintWithTree(hash, path.join(yangjianRoot, "journal"), "journal");
  updateFingerprintWithTree(hash, path.join(yangjianRoot, "trades"), "trades");
  updateFingerprintWithFile(
    hash,
    path.join(yangjianRoot, "account", "cash_flow.md"),
    "account-cash-flow",
  );
  updateFingerprintWithTree(hash, DEFAULT_HOLIDAY_CALENDAR_DIR, "holiday-calendar");

  const value = hash.digest("hex");
  sourceFingerprintMemo = { checkedAt: now, value };
  return value;
}

function buildDashboardPayload(): DashboardPayload {
  const config = loadConfig();
  const records = scanJournalData(resolveYangjianRoot());
  return {
    todayMarket: calculateTodayMarket(),
    weekly: computeWeekly(records),
    monthly: computeMonthly(records),
    yearly: computeYearly(records),
    theme: config.theme,
  };
}

function getDashboardDataCache(): { cache: DashboardDataCache; hit: boolean } {
  const sourceFingerprint = calculateSourceFingerprint();
  if (
    dashboardDataCache
    && dashboardDataCache.sourceFingerprint === sourceFingerprint
  ) {
    return { cache: dashboardDataCache, hit: true };
  }

  const fullPayload = buildDashboardPayload();
  const publicPayload: DashboardPayload = {
    ...fullPayload,
    weekly: maskTradePrices(fullPayload.weekly),
    monthly: maskTradePrices(fullPayload.monthly),
    yearly: maskTradePrices(fullPayload.yearly),
  };

  const cache: DashboardDataCache = {
    sourceFingerprint,
    fullJson: JSON.stringify(fullPayload),
    publicJson: JSON.stringify(publicPayload),
  };
  dashboardDataCache = cache;
  return { cache, hit: false };
}

function sendDashboardJson(
  res: http.ServerResponse,
  json: string,
  cacheHit: boolean,
): void {
  const headers: http.OutgoingHttpHeaders = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
  };
  if (EXPOSE_CACHE_STATUS) {
    headers["X-Data-Cache"] = cacheHit ? "HIT" : "MISS";
  }
  res.writeHead(200, headers);
  res.end(json);
}

function sendApiError(
  res: http.ServerResponse,
  statusCode: number,
  message: string,
): void {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify({ error: message }));
}

/** 检查请求是否持有有效 token */
function isAuthorizedToken(req: http.IncomingMessage): boolean {
  if (!AUTH_TOKEN) return false;
  const url = new URL(req.url || "/", "http://localhost");
  const authorization = req.headers.authorization || "";
  const bearerToken = authorization.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() || "";
  const candidate = bearerToken || url.searchParams.get("auth_token") || "";
  const expectedDigest = crypto.createHash("sha256").update(AUTH_TOKEN).digest();
  const candidateDigest = crypto.createHash("sha256").update(candidate).digest();
  return crypto.timingSafeEqual(expectedDigest, candidateDigest);
}

const CALENDAR_ICON_COLORS: Record<string, { header: string; dots: string }> = {
  red: { header: "#cf5659", dots: "#f3aab9" },
  blue: { header: "#4f7edb", dots: "#a8c4f6" },
  green: { header: "#3f9a67", dots: "#9ddfbb" },
  purple: { header: "#7861cf", dots: "#c5b8fb" },
  gray: { header: "#64748b", dots: "#cbd5e1" },
};

function parseCalendarIconDate(value: string | null): Date {
  const raw = String(value || "").trim();
  const compact = raw.replace(/\D/g, "");
  if (/^\d{8}$/.test(compact)) {
    const year = Number(compact.slice(0, 4));
    const month = Number(compact.slice(4, 6));
    const day = Number(compact.slice(6, 8));
    const parsed = new Date(year, month - 1, day);
    if (
      parsed.getFullYear() === year &&
      parsed.getMonth() === month - 1 &&
      parsed.getDate() === day
    ) {
      return parsed;
    }
  }
  return new Date();
}

function renderCalendarIconSvg(date: Date, colorName: string, locale: string, showWeekday: boolean): string {
  const color = CALENDAR_ICON_COLORS[colorName] || CALENDAR_ICON_COLORS.red;
  const monthNamesCn = ["一月", "二月", "三月", "四月", "五月", "六月", "七月", "八月", "九月", "十月", "十一月", "十二月"];
  const weekdayNamesCn = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];
  const monthNamesEn = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const weekdayNamesEn = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const isEnglish = locale === "en";
  const monthLabel = isEnglish ? monthNamesEn[date.getMonth()] : monthNamesCn[date.getMonth()];
  const weekdayLabel = isEnglish ? weekdayNamesEn[date.getDay()] : weekdayNamesCn[date.getDay()];
  const dayLabel = String(date.getDate());
  const monthFontSize = isEnglish ? 108 : 100;
  const weekdayFontSize = isEnglish ? 58 : 64;
  const dayY = showWeekday ? 400 : 430;
  const weekdayText = showWeekday
    ? `<text x="256" y="480" fill="#66757f" font-family="-apple-system, BlinkMacSystemFont, 'Noto Sans', 'Noto Sans CJK SC', 'Microsoft YaHei', sans-serif, 'Segoe UI', Roboto, 'Helvetica Neue', Arial" font-size="${weekdayFontSize}px" text-anchor="middle">${weekdayLabel}</text>`
    : "";

  return `<svg xmlns="http://www.w3.org/2000/svg" aria-label="Calendar" role="img" viewBox="0 0 512 512" width="100%" height="100%">
  <path d="m512,455c0,32 -25,57 -57,57l-398,0c-32,0 -57,-25 -57,-57l0,-327c0,-31 25,-57 57,-57l398,0c32,0 57,26 57,57l0,327z" fill="#efefef"/>
  <path d="m484,0l-47,0l-409,0c-15,0 -28,13 -28,28l0,157l512,0l0,-157c0,-15 -13,-28 -28,-28z" fill="${color.header}"/>
  <g fill="${color.dots}">
    <circle cx="462" cy="136" r="14"/>
    <circle cx="462" cy="94" r="14"/>
    <circle cx="419" cy="136" r="14"/>
    <circle cx="419" cy="94" r="14"/>
    <circle cx="376" cy="136" r="14"/>
    <circle cx="376" cy="94" r="14"/>
  </g>
  <text x="32" y="142" fill="#fff" font-family="-apple-system, BlinkMacSystemFont, 'Noto Sans', 'Noto Sans CJK SC', 'Microsoft YaHei', sans-serif, 'Segoe UI', Roboto, 'Helvetica Neue', Arial" font-size="${monthFontSize}px">${monthLabel}</text>
  <text x="256" y="${dayY}" fill="#66757f" font-family="-apple-system, BlinkMacSystemFont, 'Noto Sans', 'Noto Sans CJK SC', 'Microsoft YaHei', sans-serif, 'Segoe UI', Roboto, 'Helvetica Neue', Arial" font-size="256px" text-anchor="middle">${dayLabel}</text>
  ${weekdayText}
</svg>`;
}

const server = http.createServer((req, res) => {
  const parsedUrl = new URL(req.url || "/", "http://localhost");
  const pathname = parsedUrl.pathname;

  // ---- /api/icon/calendar: 参数化日历 SVG 图标 ----
  if (pathname === "/api/icon/calendar") {
    const date = parseCalendarIconDate(parsedUrl.searchParams.get("date"));
    const color = parsedUrl.searchParams.get("color") || "red";
    const locale = parsedUrl.searchParams.get("locale") === "en" ? "en" : "cn";
    const showWeekday = !["0", "false"].includes(parsedUrl.searchParams.get("weekday") || "");
    const hasFixedDate = Boolean(parsedUrl.searchParams.get("date"));

    res.writeHead(200, {
      "Content-Type": "image/svg+xml; charset=utf-8",
      "Cache-Control": hasFixedDate ? "public, max-age=31536000, immutable" : "no-cache",
    });
    res.end(renderCalendarIconSvg(date, color, locale, showWeekday));
    return;
  }

  // ---- /api/public: 公开安全数据（保留交易明细，隐藏买入卖出价格） ----
  if (pathname === "/api/public") {
    try {
      const { cache, hit } = getDashboardDataCache();
      sendDashboardJson(res, cache.publicJson, hit);
    } catch {
      sendApiError(res, 500, "内部错误");
    }
    return;
  }

  // ---- /api/data: 完整数据，需 token 认证 ----
  if (pathname === "/api/data") {
    if (!isAuthorizedToken(req)) {
      sendApiError(res, 403, "需要认证");
      return;
    }
    try {
      const { cache, hit } = getDashboardDataCache();
      sendDashboardJson(res, cache.fullJson, hit);
    } catch {
      sendApiError(res, 500, "内部错误");
    }
    return;
  }

  // ---- 静态文件 ----
  const cleanUrl = pathname === "/" ? "index.html" : pathname.slice(1);
  const filePath = path.resolve(DASHBOARD_SOURCE_DIR, cleanUrl);

  // 防止目录穿越及相同前缀目录绕过（例如 src-private）。
  if (
    filePath !== DASHBOARD_SOURCE_DIR
    && !filePath.startsWith(`${DASHBOARD_SOURCE_DIR}${path.sep}`)
  ) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

 fs.exists(filePath, (exists) => {
   if (!exists) {
     res.writeHead(404);
     res.end("Not Found");
     return;
   }

    // HTML 每次重新校验；静态资源内容不变时复用同一个版本号。
    if (filePath.endsWith("index.html")) {
      const html = fs.readFileSync(filePath, "utf8");
      const htmlWithHash = html
        .replace("style.css", `style.css?t=${STATIC_ASSET_VERSION}`)
        .replace("app.js", `app.js?t=${STATIC_ASSET_VERSION}`);
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-cache",
      });
      res.end(htmlWithHash);
      return;
    }

    let contentType = "text/html";
    if (filePath.endsWith(".css")) contentType = "text/css";
    if (filePath.endsWith(".js")) contentType = "application/javascript";
    if (filePath.endsWith(".json")) contentType = "application/json";

    const isVersionedAsset = (
      (filePath.endsWith(".css") || filePath.endsWith(".js"))
      && parsedUrl.searchParams.get("t") === STATIC_ASSET_VERSION
    );
    res.writeHead(200, {
      "Content-Type": contentType + "; charset=utf-8",
      "Cache-Control": isVersionedAsset
        ? "public, max-age=31536000, immutable"
        : "no-cache",
    });
    fs.createReadStream(filePath).pipe(res);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`========================================`);
  console.log(`Yangjian Dashboard is running!`);
  console.log(`Listening on http://${HOST}:${PORT} (本地)`);
  console.log(`公网访问请使用 Nginx 反代`);
  console.log(`========================================`);
});
