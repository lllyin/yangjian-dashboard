import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { calculateAccountReturns, parseTradesMarkdown, type ParsedTrade } from "yangjian/calculation";

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
}

interface TradeRecord {
  date: string; // YYYYMMDD
  tradeNo: number;
  action: "买入" | "卖出";
  symbol: string;
  name: string;
  price: number;
}

interface PeriodSummary {
  label: string; // e.g. "2026-W26", "2026-06", "2026"
  pnl: number;
  pnlRate: number;
  basisAsset: number;
  endAsset: number;
  days: DailyRecord[];
  trades?: TradeRecord[]; // Only for weekly summaries
  hasRebuiltData?: boolean; // 区间内是否包含 rebuilt 重建数据
}

// Helper to load configurations
function loadConfig(): Config {
  // dist/src/server.js → ../../src/config.json
  const configPath = path.join(__dirname, "../../src/config.json");
  if (!fs.existsSync(configPath)) {
    throw new Error(`Config file not found at ${configPath}`);
  }
  return JSON.parse(fs.readFileSync(configPath, "utf8")) as Config;
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
          name: trade.name,
          price: trade.tradePrice,
        });
      }
    } catch (e) {
      // Ignore parsing errors
      console.error(`Error parsing trades for ${dateName}:`, e);
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
          
          // Select latest session
          const latestSession = sessions
            .filter((s: any) => typeof s === "object" && s !== null && s.time)
            .sort((a: any, b: any) => String(b.time).localeCompare(String(a.time)))[0];

          if (latestSession && latestSession.summary) {
            totalAsset = latestSession.summary.totalAsset ?? 0;
            pnl = latestSession.summary.todayNetWorthPnl ?? (totalAsset - prevClose);
            pnlRate = latestSession.summary.todayNetWorthPnlRate ?? (prevClose === 0 ? 0 : pnl / prevClose);
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

  const config = loadConfig();
  const summaries: PeriodSummary[] = [];
  const sortedWeeks = Object.keys(groups).sort();

  for (let idx = 0; idx < sortedWeeks.length; idx++) {
    const weekName = sortedWeeks[idx];
    const days = groups[weekName].sort((a, b) => a.date.localeCompare(b.date));
    const firstDay = days[0].date;
    const lastDay = days[days.length - 1].date;

    let pnl = days.reduce((sum, d) => sum + d.pnl, 0);
    let basisAsset = 0;
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
      endAsset: Math.round(endAsset * 100) / 100,
      days,
      trades,
      hasRebuiltData: days.some((d) => d.source === "rebuilt"),
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

  const config = loadConfig();
  const summaries: PeriodSummary[] = [];
  const sortedMonths = Object.keys(groups).sort();

  for (let idx = 0; idx < sortedMonths.length; idx++) {
    const monthName = sortedMonths[idx];
    const days = groups[monthName].sort((a, b) => a.date.localeCompare(b.date));
    const firstDay = days[0].date;
    const lastDay = days[days.length - 1].date;

    let pnl = days.reduce((sum, d) => sum + d.pnl, 0);
    let basisAsset = 0;
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
      endAsset: Math.round(endAsset * 100) / 100,
      days,
      hasRebuiltData: days.some((d) => d.source === "rebuilt"),
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

  const config = loadConfig();
  const summaries: PeriodSummary[] = [];
  const sortedYears = Object.keys(groups).sort();

  for (let idx = 0; idx < sortedYears.length; idx++) {
    const yearName = sortedYears[idx];
    const days = groups[yearName].sort((a, b) => a.date.localeCompare(b.date));
    const firstDay = days[0].date;
    const lastDay = days[days.length - 1].date;

    let pnl = days.reduce((sum, d) => sum + d.pnl, 0);
    let basisAsset = 0;
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
      endAsset: Math.round(endAsset * 100) / 100,
      days,
      hasRebuiltData: days.some((d) => d.source === "rebuilt"),
    });
  }

  return summaries;
}


const PORT = Number(process.env.PORT) || 3000;

const server = http.createServer((req, res) => {
  const url = req.url || "/";

  // API Endpoint
  if (url === "/api/data") {
    try {
      const config = loadConfig();
      const records = scanJournalData(resolveYangjianRoot());
      const weekly = computeWeekly(records);
      const monthly = computeMonthly(records);
      const yearly = computeYearly(records);

      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ weekly, monthly, yearly, theme: config.theme }));
    } catch (err: any) {
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // Static files hosting - serve from src/ directly
  const dashboardSourceDir = path.join(__dirname, "../../src");
  const cleanUrl = url.split("?")[0];
  let filePath = path.join(dashboardSourceDir, cleanUrl === "/" ? "index.html" : cleanUrl.slice(1));

  // Basic security check: prevent directory traversal
  if (!filePath.startsWith(dashboardSourceDir)) {
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

    // 为 index.html 注入 app.js 时间戳，实现缓存破坏
    if (filePath.endsWith("index.html")) {
      const html = fs.readFileSync(filePath, "utf8");
      const htmlWithHash = html.replace("app.js", `app.js?t=${Date.now()}`);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(htmlWithHash);
      return;
    }

    let contentType = "text/html";
    if (filePath.endsWith(".css")) contentType = "text/css";
    if (filePath.endsWith(".js")) contentType = "application/javascript";
    if (filePath.endsWith(".json")) contentType = "application/json";

    res.writeHead(200, { "Content-Type": contentType + "; charset=utf-8" });
    fs.createReadStream(filePath).pipe(res);
  });
});

server.listen(PORT, () => {
  console.log(`========================================`);
  console.log(`Yangjian Dashboard is running!`);
  console.log(`Open http://localhost:${PORT} in your browser`);
  console.log(`========================================`);
});
