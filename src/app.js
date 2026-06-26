// Frontend Application Logic for Yangjian Dashboard
let apiData = null; // Store weekly, monthly, yearly data
let activePeriod = "weekly"; // "weekly" | "monthly" | "yearly"
let chartInstance = null; // Store Chart.js instance

// Elements
const segmentButtons = document.querySelectorAll(".segment-btn");
const periodSelector = document.getElementById("period-selector");
const periodDateRange = document.getElementById("period-date-range");
const kpiPnl = document.getElementById("kpi-pnl");
const kpiRate = document.getElementById("kpi-rate");
const kpiBasisAsset = document.getElementById("kpi-basis-asset");
const kpiEndAsset = document.getElementById("kpi-end-asset");
const detailsTbody = document.getElementById("details-tbody");
const tradesSection = document.getElementById("trades-section");
const tradesContainer = document.getElementById("trades-container");

// Initialize application
document.addEventListener("DOMContentLoaded", () => {
  fetchDashboardData();
  setupSegmentControls();
  periodSelector.addEventListener("change", handlePeriodChange);
});

// Fetch data from local backend server
async function fetchDashboardData() {
  try {
    const response = await fetch("/api/data");
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
    renderActivePeriodList();
  } catch (err) {
    console.error("数据渲染或解析失败，请检查返回的 JSON 格式和前端逻辑:", err);
    alert(`前端渲染出错了: ${err.message}`);
  }
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
function renderActivePeriodList() {
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

  // Auto-select latest instance
  periodSelector.selectedIndex = 0;
  displaySelectedPeriod();
}

function handlePeriodChange() {
  displaySelectedPeriod();
}

function clearDisplay() {
  periodDateRange.textContent = "-";
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

  // 2. Update date ranges badge
  if (item.days && item.days.length > 0) {
    const start = formatYmd(item.days[0].date);
    const end = formatYmd(item.days[item.days.length - 1].date);
    periodDateRange.textContent = `${start} 至 ${end}`;
    if (item.hasRebuiltData) {
      periodDateRange.textContent += " · 含重建数据";
      periodDateRange.title = "部分交易日数据来自 account-snapshots.rebuilt.json（历史快照重建）";
    } else {
      periodDateRange.title = "";
    }
  } else {
    periodDateRange.textContent = "-";
    periodDateRange.title = "";
  }

  // 3. Render Chart
  const chartHeader = document.getElementById("chart-header");
  const detailsHeader = document.getElementById("details-header");
  const thDate = document.getElementById("th-date");
  const thPnl = document.getElementById("th-pnl");
  const thRate = document.getElementById("th-rate");

  if (activePeriod === "yearly") {
    chartHeader.textContent = "📊 每月盈亏柱状图";
    detailsHeader.textContent = "📅 月度收益明细";
    thDate.textContent = "月份";
    thPnl.textContent = "月度盈亏";
    thRate.textContent = "月度收益率";

    const yearPrefix = selectedLabel;
    const months = apiData.monthly.filter((m) => m.label.startsWith(yearPrefix));
    renderChart(months, "monthly");

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
      detailsTbody.appendChild(tr);
    });
  } else {
    chartHeader.textContent = "📊 每日盈亏柱状图";
    detailsHeader.textContent = "📅 日度收益明细";
    thDate.textContent = "日期";
    thPnl.textContent = "日内盈亏";
    thRate.textContent = "日内收益率";

    renderChart(item.days, "daily");

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
      const displayDate = formatYmd(date);
      
      // Create date card
      const dateCard = document.createElement("div");
      dateCard.className = "trade-date-card";
      
      // Date header
      const dateHeader = document.createElement("div");
      dateHeader.className = "trade-date-header";
      dateHeader.innerHTML = `
        <div class="trade-date-label">
          <span class="trade-date-icon">📅</span>
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
        const displayPrice = formatMoney(trade.price);
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
