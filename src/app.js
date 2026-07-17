// Frontend Application Logic for Yangjian Dashboard
let apiData = null; // Store weekly, monthly, yearly data
let activePeriod = "weekly"; // "weekly" | "monthly" | "yearly"
let chartInstance = null; // Store Chart.js instance
let trendChartInstance = null; // Store persistent trend Chart.js instance
let modalTrendChartInstance = null; // Store modal trend Chart.js instance
let modalCloseTimer = null;

// Elements
const segmentButtons = document.querySelectorAll(".segment-btn");
const periodSelector = document.getElementById("period-selector");
const periodDateRange = document.getElementById("period-date-range");
const kpiPnl = document.getElementById("kpi-pnl");
const kpiRate = document.getElementById("kpi-rate");
const kpiBasisAsset = document.getElementById("kpi-basis-asset");
const kpiEndAsset = document.getElementById("kpi-end-asset");
const kpiNetDeposits = document.getElementById("kpi-net-deposits");
const detailsTbody = document.getElementById("details-tbody");
const tradesSection = document.getElementById("trades-section");
const tradesContainer = document.getElementById("trades-container");
const refreshButton = document.getElementById("refresh-data");
const dataUpdatedAt = document.getElementById("data-updated-at");
const trendHeader = document.getElementById("trend-header");
const trendSubtitle = document.getElementById("trend-subtitle");
const trendEmpty = document.getElementById("trend-empty");
const trendChartContainer = document.getElementById("trend-chart-container");
const intradayModal = document.getElementById("intraday-modal");
const intradayModalClose = document.getElementById("intraday-modal-close");
const modalTrendTitle = document.getElementById("intraday-modal-title");
const modalTrendSubtitle = document.getElementById("modal-trend-subtitle");
const modalTrendEmpty = document.getElementById("modal-trend-empty");
const modalTrendChartContainer = document.getElementById("modal-trend-chart-container");
const toast = document.getElementById("toast");
const toastMessage = document.getElementById("toast-message");
let toastTimer = null;

// Initialize application
document.addEventListener("DOMContentLoaded", () => {
  fetchDashboardData();
  setupSegmentControls();
  setupIntradayModal();
  periodSelector.addEventListener("change", handlePeriodChange);
  refreshButton.addEventListener("click", () => fetchDashboardData({ notify: true }));
});

// Fetch data from local backend server
async function fetchDashboardData({ notify = false } = {}) {
  const selectedPeriod = periodSelector.value;
  const refreshStartedAt = performance.now();
  let loadedSuccessfully = false;
  refreshButton.disabled = true;
  refreshButton.classList.add("is-refreshing");
  refreshButton.setAttribute("aria-busy", "true");

  try {
    const authToken = new URLSearchParams(window.location.search).get("auth_token") || "";
    const apiUrl = authToken
      ? `/api/data?auth_token=${encodeURIComponent(authToken)}`
      : "/api/public";

    let response = await fetch(apiUrl, { cache: "no-store" });
    if (response.status === 403 && authToken) {
      response = await fetch("/api/public", { cache: "no-store" });
    }
    apiData = await response.json();
    if (apiData.error) {
      alert(`数据加载失败: ${apiData.error}`);
      return;
    }
    // Apply dynamic theme from configuration
    if (apiData.theme) {
      const theme = apiData.theme;
      if (theme.upColor) document.documentElement.style.setProperty('--positive', theme.upColor);
      if (theme.upGlow) document.documentElement.style.setProperty('--positive-glow', theme.upGlow);
      if (theme.upTextGlow) document.documentElement.style.setProperty('--positive-text-glow', theme.upTextGlow);
      if (theme.downColor) document.documentElement.style.setProperty('--negative', theme.downColor);
      if (theme.downGlow) document.documentElement.style.setProperty('--negative-glow', theme.downGlow);
      if (theme.downTextGlow) document.documentElement.style.setProperty('--negative-text-glow', theme.downTextGlow);
    }
    // Render initially
    renderActivePeriodList(selectedPeriod);
    loadedSuccessfully = true;
  } catch (err) {
    console.error("数据渲染或解析失败，请检查返回的 JSON 格式和前端逻辑:", err);
    alert(`前端渲染出错了: ${err.message}`);
  } finally {
    const remainingAnimationTime = Math.max(0, 450 - (performance.now() - refreshStartedAt));
    if (remainingAnimationTime > 0) {
      await new Promise((resolve) => setTimeout(resolve, remainingAnimationTime));
    }
    refreshButton.disabled = false;
    refreshButton.classList.remove("is-refreshing");
    refreshButton.removeAttribute("aria-busy");
    if (notify && loadedSuccessfully) {
      showToast("数据已是最新");
    }
  }
}

function showToast(message) {
  if (toastTimer) {
    clearTimeout(toastTimer);
  }
  toastMessage.textContent = message;
  toast.classList.add("is-visible");
  toastTimer = setTimeout(() => {
    toast.classList.remove("is-visible");
    toastTimer = null;
  }, 2200);
}

// Setup segment button click handlers
function setupSegmentControls() {
  segmentButtons.forEach((btn) => {
    btn.addEventListener("click", (e) => {
      segmentButtons.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      activePeriod = btn.dataset.period;
      renderActivePeriodList();
    });
  });
}

// Rebuild period instances dropdown when period type (week/month/year) changes
function renderActivePeriodList(selectedPeriod = "") {
  if (!apiData) return;

  const list = apiData[activePeriod];
  
  // Clear select
  periodSelector.innerHTML = "";
  
  if (!list || list.length === 0) {
    periodSelector.innerHTML = `<option value="">无数据</option>`;
    clearDisplay();
    return;
  }

  // Populate options in reverse order (latest first)
  for (let i = list.length - 1; i >= 0; i--) {
    const item = list[i];
    const option = document.createElement("option");
    option.value = item.label;
    
    // Friendly text representation
    let labelText = item.label;
    if (activePeriod === "weekly") {
      labelText = `${item.label} (周盈亏: ${formatPnlSign(item.pnl)})`;
    } else if (activePeriod === "monthly") {
      labelText = `${item.label} (月盈亏: ${formatPnlSign(item.pnl)})`;
    } else if (activePeriod === "yearly") {
      labelText = `${item.label} (年盈亏: ${formatPnlSign(item.pnl)})`;
    }
    option.textContent = labelText;
    periodSelector.appendChild(option);
  }

  const hasSelectedPeriod = selectedPeriod
    && Array.from(periodSelector.options).some((option) => option.value === selectedPeriod);
  periodSelector.value = hasSelectedPeriod ? selectedPeriod : periodSelector.options[0].value;
  displaySelectedPeriod();
}

function handlePeriodChange() {
  displaySelectedPeriod();
}

function clearDisplay() {
  periodDateRange.textContent = "-";
  if (dataUpdatedAt) {
    dataUpdatedAt.textContent = "Data updated at -";
  }
  kpiPnl.textContent = "0.00 元";
  kpiRate.textContent = "0.00%";
  kpiBasisAsset.textContent = "0.00 元";
  kpiEndAsset.textContent = "0.00 元";
  detailsTbody.innerHTML = `<tr><td colspan="5" style="text-align: center; color: var(--text-muted);">暂无明细数据</td></tr>`;
  tradesSection.style.display = "none";
  tradesContainer.innerHTML = "";
  if (chartInstance) {
    chartInstance.destroy();
    chartInstance = null;
  }
  if (trendChartInstance) {
    trendChartInstance.destroy();
    trendChartInstance = null;
  }
  if (trendHeader) {
    trendHeader.textContent = "📈 收益走势";
  }
  if (trendSubtitle) {
    trendSubtitle.textContent = "-";
  }
  if (trendEmpty) {
    trendEmpty.style.display = "flex";
  }
  if (trendChartContainer) {
    trendChartContainer.style.display = "none";
  }
  closeIntradayModal();
}

// Displays metrics, charts, and list for selected period instance
function displaySelectedPeriod() {
  const selectedLabel = periodSelector.value;
  if (!selectedLabel || !apiData) return;

  const list = apiData[activePeriod];
  const item = list.find((i) => i.label === selectedLabel);
  if (!item) return;

  // 1. Update KPI summaries
  kpiPnl.textContent = `${formatPnlSign(item.pnl)} 元`;
  kpiPnl.className = `value ${item.pnl >= 0 ? "positive" : "negative"}`;
  
  kpiRate.textContent = `${item.pnl >= 0 ? "+" : ""}${(item.pnlRate * 100).toFixed(2)}%`;
  kpiRate.className = `value ${item.pnlRate >= 0 ? "positive" : "negative"}`;

  kpiBasisAsset.textContent = `${formatMoney(item.basisAsset)} 元`;
  kpiEndAsset.textContent = `${formatMoney(item.endAsset)} 元`;

  if (kpiNetDeposits) {
    const netDeposits = item.netDeposits ?? 0;
    const netDepositsRow = document.getElementById("kpi-net-deposits-row");
    if (netDepositsRow) {
      netDepositsRow.style.display = netDeposits !== 0 ? "" : "none";
    }
    kpiNetDeposits.textContent = `${formatPnlSign(netDeposits)} 元`;
  }

  // 2. Update date ranges badge
  if (item.days && item.days.length > 0) {
    const start = formatYmd(item.days[0].date);
    const end = formatYmd(item.days[item.days.length - 1].date);
    periodDateRange.textContent = `${start} 至 ${end}`;
    if (item.hasRebuiltData) {
      periodDateRange.textContent += " *";
      periodDateRange.title = "部分交易日数据来自历史快照重建";
    } else {
      periodDateRange.title = "";
    }
  } else {
    periodDateRange.textContent = "-";
    periodDateRange.title = "";
  }

  if (dataUpdatedAt) {
    dataUpdatedAt.textContent = item.updatedAt ? `Data updated at ${formatUpdatedAt(item.updatedAt)}` : "Data updated at -";
  }

  // 3. Render Chart
  const chartHeader = document.getElementById("chart-header");
  const detailsHeader = document.getElementById("details-header");
  const thDate = document.getElementById("th-date");
  const thPnl = document.getElementById("th-pnl");
  const thRate = document.getElementById("th-rate");
  const latestDetailsDate = item.days?.[item.days.length - 1]?.date;

  if (activePeriod === "yearly") {
    chartHeader.textContent = "📊 每月盈亏柱状图";
    renderDetailsHeader("月度收益明细", latestDetailsDate);
    thDate.textContent = "月份";
    thPnl.textContent = "月度盈亏";
    thRate.textContent = "月度收益率";

    const yearPrefix = selectedLabel;
    const months = apiData.monthly.filter((m) => m.label.startsWith(yearPrefix));
    renderChart(months, "monthly");
    renderPersistentTrend(buildYearTrend(item, months));

    // 4. Populate table detail rows (monthly data, reverse chronological order)
    detailsTbody.innerHTML = "";
    const sortedMonths = [...months].reverse();
    sortedMonths.forEach((month) => {
      const tr = document.createElement("tr");
      
      const displayDate = month.label; // e.g. "2026-06"
      const displayAsset = formatMoney(month.endAsset);
      const displayPnl = formatPnlSign(month.pnl);
      const displayPnlRate = `${month.pnl >= 0 ? "+" : ""}${(month.pnlRate * 100).toFixed(2)}%`;
      
      const pnlClass = month.pnl >= 0 ? "positive" : "negative";
      const statusPill = month.pnl >= 0 ? '<span class="status-pill profit">盈利</span>' : '<span class="status-pill loss">亏损</span>';

      tr.innerHTML = `
        <td>${displayDate}</td>
        <td>${displayAsset}</td>
        <td class="table-pnl ${pnlClass}">${displayPnl}</td>
        <td class="table-pnl ${pnlClass}">${displayPnlRate}</td>
        <td>${statusPill}</td>
      `;
      tr.classList.add("day-detail-row");
      tr.tabIndex = 0;
      tr.setAttribute("role", "button");
      tr.setAttribute("aria-label", `查看 ${displayDate} 当月收益走势`);
      tr.addEventListener("click", () => openTrendModal(buildMonthTrend(month)));
      tr.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          openTrendModal(buildMonthTrend(month));
        }
      });
      detailsTbody.appendChild(tr);
    });
  } else {
    chartHeader.textContent = "📊 每日盈亏";
    renderDetailsHeader("每日收益明细", latestDetailsDate);
    thDate.textContent = "日期";
    thPnl.textContent = "日盈亏";
    thRate.textContent = "日收益率";

    renderChart(item.days, "daily");
    renderPersistentTrend(activePeriod === "weekly" ? buildLatestIntradayTrend(item.days) : buildMonthTrend(item));

    // 4. Populate table detail rows (daily data, reverse chronological order)
    detailsTbody.innerHTML = "";
    const sortedDays = [...item.days].reverse();
    sortedDays.forEach((day) => {
      const tr = document.createElement("tr");
      
      const displayDate = formatYmd(day.date);
      const displayAsset = formatMoney(day.totalAsset);
      const displayPnl = formatPnlSign(day.pnl);
      const displayPnlRate = `${day.pnl >= 0 ? "+" : ""}${(day.pnlRate * 100).toFixed(2)}%`;
      
      const pnlClass = day.pnl >= 0 ? "positive" : "negative";
      const statusPill = day.pnl >= 0 ? '<span class="status-pill profit">盈利</span>' : '<span class="status-pill loss">亏损</span>';

      tr.innerHTML = `
        <td>${displayDate}</td>
        <td>${displayAsset}</td>
        <td class="table-pnl ${pnlClass}">${displayPnl}</td>
        <td class="table-pnl ${pnlClass}">${displayPnlRate}</td>
        <td>${statusPill}</td>
      `;
      tr.classList.add("day-detail-row");
      tr.tabIndex = 0;
      tr.setAttribute("role", "button");
      tr.setAttribute("aria-label", `查看 ${displayDate} 当日收益走势`);
      tr.addEventListener("click", () => openTrendModal(buildDayIntradayTrend(day)));
      tr.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          openTrendModal(buildDayIntradayTrend(day));
        }
      });
      detailsTbody.appendChild(tr);
    });
  }

  // 5. Render trades (only for weekly view)
  if (activePeriod === "weekly" && item.trades && item.trades.length > 0) {
    tradesSection.style.display = "block";
    tradesContainer.innerHTML = "";
    
    // Group trades by date
    const tradesByDate = {};
    item.trades.forEach((trade) => {
      if (!tradesByDate[trade.date]) {
        tradesByDate[trade.date] = [];
      }
      tradesByDate[trade.date].push(trade);
    });
    
    // Get dates in reverse chronological order
    const dates = Object.keys(tradesByDate).sort().reverse();
    
    dates.forEach((date) => {
      const trades = tradesByDate[date];
      const displayDate = formatYmdWithWeekday(date);
      
      // Create date card
      const dateCard = document.createElement("div");
      dateCard.className = "trade-date-card";
      
      // Date header
      const dateHeader = document.createElement("div");
      dateHeader.className = "trade-date-header";
      dateHeader.innerHTML = `
        <div class="trade-date-label">
          <img class="trade-date-icon" src="${calendarIconUrl(date)}" alt="" aria-hidden="true" loading="lazy" />
          <span class="trade-date-text">${displayDate}</span>
        </div>
        <span class="trade-count-badge">${trades.length} 笔交易</span>
      `;
      dateCard.appendChild(dateHeader);
      
      // Trade items
      const tradesList = document.createElement("div");
      tradesList.className = "trades-list";
      
      trades.forEach((trade, index) => {
        const tradeItem = document.createElement("div");
        tradeItem.className = "trade-item";
        
        const actionPill = trade.action === "买入" 
          ? '<span class="action-pill buy">买入</span>' 
          : '<span class="action-pill sell">卖出</span>';
        
        const displaySymbol = `${trade.name} (${trade.symbol})`;
        const displayPrice = trade.price == null ? "" : formatMoney(trade.price);
        const priceClass = trade.action === "买入" ? "trade-buy" : "trade-sell";
        
        tradeItem.innerHTML = `
          <div class="trade-item-number">#${trade.tradeNo}</div>
          <div class="trade-item-content">
            <div class="trade-item-main">
              <div class="trade-item-symbol">${displaySymbol}</div>
              <div class="trade-item-price ${priceClass}">${displayPrice}</div>
            </div>
            <div class="trade-item-action">${actionPill}</div>
          </div>
        `;
        
        tradesList.appendChild(tradeItem);
      });
      
      dateCard.appendChild(tradesList);
      tradesContainer.appendChild(dateCard);
    });
  } else {
    tradesSection.style.display = "none";
  }
}

function setupIntradayModal() {
  if (!intradayModal) return;

  intradayModalClose?.addEventListener("click", closeIntradayModal);
  intradayModal.addEventListener("click", (event) => {
    if (event.target === intradayModal) {
      closeIntradayModal();
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && intradayModal.classList.contains("is-open")) {
      closeIntradayModal();
    }
  });
}

function openTrendModal(trend) {
  if (!intradayModal) return;
  if (modalCloseTimer) {
    clearTimeout(modalCloseTimer);
    modalCloseTimer = null;
  }

  intradayModal.classList.remove("is-closing");
  intradayModal.classList.add("is-open");
  intradayModal.setAttribute("aria-hidden", "false");
  document.body.classList.add("modal-open");

  renderTrendChart({
    chart: "modal",
    trend,
  });
  requestAnimationFrame(() => intradayModalClose?.focus());
}

function closeIntradayModal() {
  if (!intradayModal) return;
  if (!intradayModal.classList.contains("is-open")) return;

  intradayModal.classList.remove("is-open");
  intradayModal.classList.add("is-closing");
  document.body.classList.remove("modal-open");

  modalCloseTimer = setTimeout(() => {
    intradayModal.classList.remove("is-closing");
    intradayModal.setAttribute("aria-hidden", "true");
    if (modalTrendChartInstance) {
      modalTrendChartInstance.destroy();
      modalTrendChartInstance = null;
    }
    modalCloseTimer = null;
  }, 320);
}

function renderPersistentTrend(trend) {
  renderTrendChart({
    chart: "persistent",
    trend,
  });
}

function renderTrendChart({ chart, trend }) {
  const isModal = chart === "modal";
  const titleEl = isModal ? modalTrendTitle : trendHeader;
  const subtitleEl = isModal ? modalTrendSubtitle : trendSubtitle;
  const emptyEl = isModal ? modalTrendEmpty : trendEmpty;
  const containerEl = isModal ? modalTrendChartContainer : trendChartContainer;
  const canvas = document.getElementById(isModal ? "modal-trend-chart" : "trend-chart");
  const emptyText = trend?.emptyText || "暂无走势数据";

  if (isModal && modalTrendChartInstance) {
    modalTrendChartInstance.destroy();
    modalTrendChartInstance = null;
  }
  if (!isModal && trendChartInstance) {
    trendChartInstance.destroy();
    trendChartInstance = null;
  }

  if (titleEl) {
    titleEl.textContent = trend?.title || "📈 收益走势";
  }
  if (subtitleEl) {
    subtitleEl.textContent = trend?.subtitle || "-";
  }

  if (!trend || !Array.isArray(trend.points) || trend.points.length === 0) {
    if (emptyEl) {
      emptyEl.textContent = emptyText;
      emptyEl.style.display = "flex";
    }
    if (containerEl) containerEl.style.display = "none";
    return;
  }

  if (emptyEl) emptyEl.style.display = "none";
  if (containerEl) containerEl.style.display = "block";

  const instance = createTrendChart(canvas, trend.points, trend);
  if (isModal) {
    modalTrendChartInstance = instance;
  } else {
    trendChartInstance = instance;
  }
}

function createTrendChart(canvas, points, trend) {
  const ctx = canvas.getContext("2d");
  const labels = points.map((point) => point.label);
  const pnlData = points.map((point) => point.pnl);
  const lastPnl = pnlData[pnlData.length - 1] ?? 0;
  const upColor = (apiData && apiData.theme && apiData.theme.upColor) || "#ef4444";
  const downColor = (apiData && apiData.theme && apiData.theme.downColor) || "#10b981";
  const lineColor = lastPnl >= 0 ? upColor : downColor;

  return new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [{
        label: trend.datasetLabel || "净值盈亏 (元)",
        data: pnlData,
        borderColor: lineColor,
        borderWidth: 2,
        pointRadius: 3,
        pointHoverRadius: 5,
        pointBackgroundColor: lineColor,
        pointBorderColor: "#111827",
        pointBorderWidth: 1.5,
        tension: 0.28,
        fill: {
          target: "origin",
          above: upColor + "2e",
          below: downColor + "2e"
        }
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: {
        intersect: false,
        mode: "index"
      },
      plugins: {
        legend: {
          display: false
        },
        tooltip: {
          backgroundColor: "rgba(17, 24, 39, 0.95)",
          titleColor: "#fff",
          bodyColor: "#f3f4f6",
          borderColor: "rgba(255,255,255,0.08)",
          borderWidth: 1,
          padding: 12,
          font: {
            family: "Outfit"
          },
          callbacks: {
            label: function(context) {
              const point = points[context.dataIndex];
              const lines = [
                ` 盈亏: ${point.pnl >= 0 ? "+" : ""}${formatMoney(point.pnl)} 元`
              ];
              if (typeof point.pnlRate === "number") {
                lines.push(` 收益率: ${point.pnlRate >= 0 ? "+" : ""}${(point.pnlRate * 100).toFixed(2)}%`);
              }
              if (typeof point.totalAsset === "number") {
                lines.push(` 总资产: ${formatMoney(point.totalAsset)} 元`);
              }
              return lines;
            }
          }
        }
      },
      scales: {
        x: {
          grid: {
            color: "rgba(255, 255, 255, 0.04)"
          },
          ticks: {
            color: "#9ca3af",
            font: {
              family: "Outfit",
              size: 11
            }
          }
        },
        y: {
          grid: {
            color: "rgba(255, 255, 255, 0.04)"
          },
          ticks: {
            color: "#9ca3af",
            font: {
              family: "Outfit",
              size: 11
            },
            callback: function(value) {
              return (value >= 0 ? "+" : "") + value.toLocaleString();
            }
          }
        }
      }
    }
  });
}

function buildLatestIntradayTrend(days) {
  const latestDay = [...(days || [])]
    .reverse()
    .find((day) => Array.isArray(day.intraday) && day.intraday.length > 0);

  return latestDay
    ? buildDayIntradayTrend(latestDay)
    : {
        title: "📈 当日收益走势",
        subtitle: "-",
        points: [],
        emptyText: "暂无分时快照数据",
      };
}

function buildDayIntradayTrend(day) {
  return {
    title: "📈 当日收益走势",
    subtitle: day?.date ? formatYmdWithWeekday(day.date) : "-",
    points: (day?.intraday || []).map((point) => ({
      label: point.time,
      pnl: point.pnl,
      pnlRate: point.pnlRate,
      totalAsset: point.totalAsset,
    })),
    datasetLabel: "当日净值盈亏 (元)",
    emptyText: "暂无分时快照数据",
  };
}

function buildMonthTrend(month) {
  const days = Array.isArray(month?.days) ? month.days : [];
  let cumulativePnl = 0;
  const basisAsset = month?.basisAsset || 0;

  return {
    title: "📈 当月收益走势",
    subtitle: month?.label || "-",
    points: days.map((day) => {
      cumulativePnl += day.pnl;
      return {
        label: formatMonthDay(day.date),
        pnl: Math.round(cumulativePnl * 100) / 100,
        pnlRate: basisAsset === 0 ? 0 : cumulativePnl / basisAsset,
        totalAsset: day.totalAsset,
      };
    }),
    datasetLabel: "当月累计盈亏 (元)",
    emptyText: "暂无当月收益走势数据",
  };
}

function buildYearTrend(year, months) {
  let cumulativePnl = 0;
  const basisAsset = year?.basisAsset || 0;

  return {
    title: "📈 当年收益走势",
    subtitle: year?.label || "-",
    points: (months || []).map((month) => {
      cumulativePnl += month.pnl;
      return {
        label: month.label,
        pnl: Math.round(cumulativePnl * 100) / 100,
        pnlRate: basisAsset === 0 ? 0 : cumulativePnl / basisAsset,
        totalAsset: month.endAsset,
      };
    }),
    datasetLabel: "当年累计盈亏 (元)",
    emptyText: "暂无当年收益走势数据",
  };
}

// Generate the Chart.js visualization
function renderChart(data, type) {
  if (chartInstance) {
    chartInstance.destroy();
  }

  const canvas = document.getElementById("returns-chart");
  const ctx = canvas.getContext("2d");

  let labels = [];
  let pnlData = [];

  if (type === "monthly") {
    labels = data.map((m) => m.label);
    pnlData = data.map((m) => m.pnl);
  } else {
    labels = data.map((d) => {
      const dateStr = d.date;
      return `${dateStr.slice(4, 6)}/${dateStr.slice(6, 8)}`;
    });
    pnlData = data.map((d) => d.pnl);
  }
  
  // Color configuration based on profit/loss
  const upColor = (apiData && apiData.theme && apiData.theme.upColor) || "#ef4444";
  const downColor = (apiData && apiData.theme && apiData.theme.downColor) || "#10b981";

  const backgroundColors = data.map((item) => item.pnl >= 0 ? upColor + "bf" : downColor + "bf");
  const borderColors = data.map((item) => item.pnl >= 0 ? upColor : downColor);

  chartInstance = new Chart(ctx, {
    type: "bar",
    data: {
      labels: labels,
      datasets: [{
        label: type === "monthly" ? "单月净值盈亏 (元)" : "单日净值盈亏 (元)",
        data: pnlData,
        backgroundColor: backgroundColors,
        borderColor: borderColors,
        borderWidth: 1.5,
        borderRadius: 6,
        barPercentage: 0.6
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          display: false
        },
        tooltip: {
          backgroundColor: "rgba(17, 24, 39, 0.95)",
          titleColor: "#fff",
          bodyColor: "#f3f4f6",
          borderColor: "rgba(255,255,255,0.08)",
          borderWidth: 1,
          padding: 12,
          font: {
            family: "Outfit"
          },
          callbacks: {
            label: function(context) {
              const val = context.raw;
              return ` 盈亏: ${val >= 0 ? "+" : ""}${formatMoney(val)} 元`;
            }
          }
        }
      },
      scales: {
        x: {
          grid: {
            color: "rgba(255, 255, 255, 0.04)"
          },
          ticks: {
            color: "#9ca3af",
            font: {
              family: "Outfit",
              size: 11
            }
          }
        },
        y: {
          grid: {
            color: "rgba(255, 255, 255, 0.04)"
          },
          ticks: {
            color: "#9ca3af",
            font: {
              family: "Outfit",
              size: 11
            },
            callback: function(value) {
              return (value >= 0 ? "+" : "") + value.toLocaleString();
            }
          }
        }
      }
    }
  });
}

// Global utilities
function formatMoney(value) {
  return value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatPnlSign(value) {
  return (value >= 0 ? "+" : "") + formatMoney(value);
}

function formatYmd(value) {
  if (value.length === 8) {
    return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
  }
  return value;
}

function formatMonthDay(value) {
  if (value.length === 8) {
    return `${value.slice(4, 6)}/${value.slice(6, 8)}`;
  }
  return value;
}

function formatYmdWithWeekday(value) {
  const formattedDate = formatYmd(value);
  if (!/^\d{8}$/.test(value)) {
    return formattedDate;
  }

  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6, 8));
  const weekday = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"][
    new Date(year, month - 1, day).getDay()
  ];

  return `${formattedDate} ${weekday}`;
}

function renderDetailsHeader(label, date) {
  const detailsHeader = document.getElementById("details-header");
  if (!detailsHeader) return;

  detailsHeader.classList.add("details-heading");
  detailsHeader.innerHTML = `
    <img class="section-calendar-icon" src="${calendarIconUrl(date)}" alt="" aria-hidden="true" />
    <span>${label}</span>
  `;
}

function calendarIconUrl(value) {
  const dateParam = value ? `date=${encodeURIComponent(value)}&` : "";
  return `/api/icon/calendar?${dateParam}locale=cn&color=red&weekday=0`;
}

function formatUpdatedAt(value) {
  const normalized = String(value).trim();
  const match = normalized.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::\d{2})?/);
  if (match) {
    return `${match[1]} ${match[2]}`;
  }
  return normalized;
}
