/**
 * tab-spend.js — Spend tab.
 *
 * Spec §5.4. Three chart+table pairs (Spend, Sales, ROAS). Each chart shows
 * three lines: Branded, Generic, Total. Drill levels: Overall / Category /
 * Sub-category / Marketing Channel.
 *
 * ROAS = Sales / Spend per branch. Null when Spend = 0 in that branch.
 */

import { State } from "./dashboard.js";
import { createDateRange, createSegmented, createMultiSelect } from "./filters.js";
import { renderLineChart, destroyChart, PALETTE } from "./charts.js";
import { downloadCSV, downloadXLSX, filterContextSheet } from "./downloads.js";
import { escapeHtml, fmtINR, fmtROAS, pctChange, toast , makeTableCollapsible, syncTableCollapseLabels, wireTableToggleAll } from "./util.js";
import {
  bucketKey, enumeratePeriods, pluralize, deltaPill, tsForFilename,
} from "./aggregate.js";

/* ---------------------------------------------------------------- *
 * Constants
 * ---------------------------------------------------------------- */
// Three branches per period.
const BRANCHES = [
  { key: "branded", label: "Branded", color: PALETTE[0] },  // terracotta
  { key: "generic", label: "Generic", color: PALETTE[1] },  // sage
  { key: "total",   label: "Total",   color: "#1F2A22" },   // deep forest
];

// Three metric panels, in spec order.
const METRICS = [
  {
    key: "spend",
    label: "Spend",
    fmt: fmtINR,
    yFormat: "inr",
    yTitle: "Spend (₹)",
    pick: (b) => b.spend,         // how to read this metric from a branch object
  },
  {
    key: "sales",
    label: "Sales",
    fmt: fmtINR,
    yFormat: "inr",
    yTitle: "Sales (₹)",
    pick: (b) => b.sales,
  },
  {
    key: "roas",
    label: "ROAS",
    fmt: fmtROAS,
    yFormat: "roas",
    yTitle: "ROAS (×)",
    pick: (b) => b.roas,
  },
];

/* ---------------------------------------------------------------- *
 * Module-local state
 * ---------------------------------------------------------------- */
const LocalState = {
  range: { from: "", to: "" },
  gran: "weekly",
  platforms: [],
  level: "overall",   // 'overall' | 'category' | 'subcategory' | 'channel'
  dim: "__all__",
  filters: null,
  _agg: null,
};

let _built = false;

/** Reset module state (called by Live Refresh to force a rebuild). */
export function reset() {
  _built = false;
}

/* ---------------------------------------------------------------- *
 * Public entry
 * ---------------------------------------------------------------- */
export function renderSpendTab() {
  const root = document.getElementById("content-spend");
  if (!root || !State.data) return;
  if (!_built) {
    _built = true;
    buildSkeleton(root);
    buildFilters();
  }
  rerender();
}

/* ---------------------------------------------------------------- *
 * Skeleton — three section cards
 * ---------------------------------------------------------------- */
function buildSkeleton(root) {
  root.innerHTML = METRICS.map(m => `
    <section class="section-card" data-metric="${m.key}">
      <header class="section-head">
        <h2 class="section-title">${m.label}
          <span class="section-meta" id="spd-${m.key}-kpi"></span>
        </h2>
        <div class="section-actions">
          <span class="section-meta" id="spd-${m.key}-meta"></span>
          <button class="icon-btn" data-dl="csv" data-metric="${m.key}">CSV</button>
          <button class="icon-btn" data-dl="xlsx" data-metric="${m.key}">Excel</button>
        </div>
      </header>
      <div class="chart-box"><canvas id="spd-${m.key}-canvas"></canvas></div>
      <div class="tbl-wrap is-scroll-y">
        <table class="data-tbl" id="spd-${m.key}-tbl">
          <thead></thead>
          <tbody></tbody>
        </table>
      </div>
    </section>
  `).join("");

  root.querySelectorAll("[data-dl]").forEach(btn => {
    btn.addEventListener("click", () => {
      downloadMetric(btn.dataset.metric, btn.dataset.dl);
    });
  });

  // Collapse all per-period breakdown tables by default.
  root.querySelectorAll(".section-card > .tbl-wrap").forEach(el => makeTableCollapsible(el));
}

/* ---------------------------------------------------------------- *
 * Filter bar
 * ---------------------------------------------------------------- */
function buildFilters() {
  const bar = document.getElementById("filters-spend");
  if (!bar) return;
  bar.innerHTML = "";

  const md = State.data.metadata;
  const dr = md.date_range || {};

  const dateF = createDateRange({
    id: "spend.range",
    minDate: dr.min,
    maxDate: dr.max,
    defaultDays: 90,
  });
  bar.appendChild(dateF.el);

  const granF = createSegmented({
    id: "spend.gran",
    label: "Granularity",
    options: [
      { value: "daily",   label: "Daily" },
      { value: "weekly",  label: "Weekly" },
      { value: "monthly", label: "Monthly" },
    ],
    defaultValue: "weekly",
  });
  bar.appendChild(granF.el);

  // Platforms — only those with any spend data.
  const spendPlatforms = [...new Set((State.data.bcg_spend || []).map(r => r.platform))]
    .filter(Boolean).sort();
  const platformOptions = spendPlatforms.map(p => ({ value: p, label: p }));
  const platsF = createMultiSelect({
    id: "spend.platforms",
    label: "Platforms",
    options: platformOptions,
    defaultSelected: platformOptions.map(o => o.value),
    allowAll: true,
  });
  bar.appendChild(platsF.el);

  const levelF = createSegmented({
    id: "spend.level",
    label: "View level",
    options: [
      { value: "overall",     label: "Overall" },
      { value: "category",    label: "Category" },
      { value: "subcategory", label: "Sub-category" },
      { value: "channel",     label: "Marketing Channel" },
    ],
    defaultValue: "overall",
  });
  bar.appendChild(levelF.el);

  // Dimension dropdown — visibility + options change with level.
  const dimWrap = document.createElement("div");
  dimWrap.className = "fl-group";
  dimWrap.id = "spend-dim-wrap";
  dimWrap.innerHTML = `
    <div class="fl-lbl" id="spend-dim-label">Dimension</div>
    <select id="spend-dim-select" class="fl-select"></select>
  `;
  bar.appendChild(dimWrap);

  const toggleBtn = document.createElement("button");
  toggleBtn.className = "fl-tbl-toggle";
  toggleBtn.textContent = "Show all tables";
  bar.appendChild(toggleBtn);
  wireTableToggleAll(toggleBtn, document.getElementById("content-spend"));

  LocalState.filters = { dateF, granF, platsF, levelF };

  syncFromFilters();
  dateF.onChange(() => { syncFromFilters(); rerender(); });
  granF.onChange(() => { syncFromFilters(); rerender(); });
  platsF.onChange(() => { syncFromFilters(); rerender(); });
  levelF.onChange(() => { LocalState.dim = "__all__"; syncFromFilters(); rerender(); });

  document.getElementById("spend-dim-select").addEventListener("change", e => {
    LocalState.dim = e.target.value;
    rerender();
  });
}

function syncFromFilters() {
  const { dateF, granF, platsF, levelF } = LocalState.filters;
  LocalState.range = dateF.getRange();
  LocalState.gran = granF.getValue();
  LocalState.platforms = platsF.getSelected();
  LocalState.level = levelF.getValue();
}

/* ---------------------------------------------------------------- *
 * Re-render
 * ---------------------------------------------------------------- */
function rerender() {
  refreshDimensionDropdown();
  const agg = computeAggregations();
  LocalState._agg = agg;
  for (const m of METRICS) renderMetricPanel(m, agg);
  syncTableCollapseLabels(document.getElementById("content-spend"));
}

function refreshDimensionDropdown() {
  const wrap = document.getElementById("spend-dim-wrap");
  const sel  = document.getElementById("spend-dim-select");
  const labelEl = document.getElementById("spend-dim-label");
  if (LocalState.level === "overall") {
    wrap.style.display = "none";
    LocalState.dim = "__all__";
    return;
  }
  wrap.style.display = "";

  const labelMap = {
    category:    "Category",
    subcategory: "Sub-category",
    channel:     "Marketing Channel",
  };
  labelEl.textContent = labelMap[LocalState.level];

  const opts = availableDimensions();
  sel.innerHTML = [
    `<option value="__all__">All ${labelMap[LocalState.level].toLowerCase()}s (combined)</option>`,
    ...opts.map(o => `<option value="${escapeHtml(o.value)}">${escapeHtml(o.display)}</option>`),
  ].join("");

  if (LocalState.dim !== "__all__" && !opts.some(o => o.value === LocalState.dim)) {
    LocalState.dim = "__all__";
  }
  sel.value = LocalState.dim;
}

function availableDimensions() {
  const platSet = new Set(LocalState.platforms);
  const rows = (State.data.bcg_spend || []).filter(r => platSet.has(r.platform));
  let pickField;
  if (LocalState.level === "category")    pickField = "category";
  if (LocalState.level === "subcategory") pickField = "subcategory";
  if (LocalState.level === "channel")     pickField = "marketing_channel";
  if (!pickField) return [];
  const set = new Set(rows.map(r => r[pickField]).filter(Boolean));
  return [...set].sort().map(v => ({ value: v, display: v }));
}

/* ---------------------------------------------------------------- *
 * Aggregations
 *
 * Output:
 *   { periods: [{key, label,
 *                branded: {spend, sales, roas, hasData},
 *                generic: {...},
 *                total: {...} }]
 *   }
 * ---------------------------------------------------------------- */
function computeAggregations() {
  const { range, gran, platforms, level, dim } = LocalState;
  const platSet = new Set(platforms);

  const rows = (State.data.bcg_spend || []).filter(r => {
    if (!platSet.has(r.platform)) return false;
    if (range.from && r.date < range.from) return false;
    if (range.to   && r.date > range.to)   return false;
    if (level === "category"    && dim !== "__all__" && r.category          !== dim) return false;
    if (level === "subcategory" && dim !== "__all__" && r.subcategory       !== dim) return false;
    if (level === "channel"     && dim !== "__all__" && r.marketing_channel !== dim) return false;
    return true;
  });

  const periodList = enumeratePeriods(range.from, range.to, gran);
  const periodMap = new Map(periodList.map(p => [p.key, _emptyPeriod(p)]));

  for (const r of rows) {
    const key = bucketKey(r.date, gran);
    const e = periodMap.get(key);
    if (!e) continue;
    const branch = r.branded_bucket === "Branded" ? e.branded : e.generic;
    if (!branch.hasData) { branch.spend = 0; branch.sales = 0; branch.hasData = true; }
    if (!e.total.hasData) { e.total.spend = 0; e.total.sales = 0; e.total.hasData = true; }
    branch.spend  += +r.spend || 0;
    branch.sales  += +r.sales || 0;
    e.total.spend += +r.spend || 0;
    e.total.sales += +r.sales || 0;
  }

  // Compute ROAS for each branch per period.
  for (const e of periodMap.values()) {
    for (const b of [e.branded, e.generic, e.total]) {
      b.roas = (b.hasData && b.spend > 0) ? b.sales / b.spend : null;
    }
  }

  return { periods: periodList.map(p => periodMap.get(p.key)) };
}

function _emptyPeriod(p) {
  return {
    key: p.key, label: p.label,
    branded: { spend: null, sales: null, roas: null, hasData: false },
    generic: { spend: null, sales: null, roas: null, hasData: false },
    total:   { spend: null, sales: null, roas: null, hasData: false },
  };
}

/* ---------------------------------------------------------------- *
 * Per-metric panel
 * ---------------------------------------------------------------- */
function renderMetricPanel(metric, agg) {
  const canvas = document.getElementById(`spd-${metric.key}-canvas`);
  const thead  = document.querySelector(`#spd-${metric.key}-tbl thead`);
  const tbody  = document.querySelector(`#spd-${metric.key}-tbl tbody`);
  const kpiEl  = document.getElementById(`spd-${metric.key}-kpi`);
  const metaEl = document.getElementById(`spd-${metric.key}-meta`);

  const labels = agg.periods.map(p => p.label);

  // Build one series per branch.
  const series = BRANCHES.map(br => ({
    label: br.label,
    color: br.color,
    data: agg.periods.map(p => metric.pick(p[br.key])),
  }));

  // Render chart with custom colors per branch (Total = forest, otherwise PALETTE).
  renderColoredLineChart(canvas, {
    labels,
    series,
    yFormat: metric.yFormat,
    yTitle: metric.yTitle,
  });

  // Header KPI shows the Total branch's latest value + Δ vs previous.
  const totals = agg.periods.map(p => metric.pick(p.total));
  const latIdx = (() => {
    for (let i = totals.length - 1; i >= 0; i--) if (totals[i] != null) return i;
    return -1;
  })();
  const latestVal = latIdx >= 0 ? totals[latIdx] : null;
  const prevVal   = latIdx > 0  ? totals[latIdx - 1] : null;
  const delta = pctChange(latestVal, prevVal);

  if (latestVal == null) {
    kpiEl.innerHTML = `<span style="color:var(--brand-muted-2)">No data in range</span>`;
  } else {
    const periodName = ({daily:"day", weekly:"week", monthly:"month"})[LocalState.gran] || "period";
    const deltaPart = delta == null
      ? `<span style="color:var(--brand-muted-2); margin-left:8px;">no prior ${periodName}</span>`
      : `<span class="${delta > 0 ? "delta-up" : (delta < 0 ? "delta-down" : "")}" style="margin-left:8px;">${
            delta > 0 ? "▲" : (delta < 0 ? "▼" : "→")} ${Math.abs(delta).toFixed(1)}%</span>`;
    kpiEl.innerHTML = `<span class="kpi-val">${metric.fmt(latestVal)}</span> <span style="color:var(--brand-muted); font-size:var(--fs-sm); margin-left:4px;">total</span>${deltaPart}`;
  }
  metaEl.textContent = `${agg.periods.length} ${pluralize(LocalState.gran, agg.periods.length)}`;

  // Table — one row per period (newest first), columns: Period, Branded, Δ, Generic, Δ, Total, Δ.
  thead.innerHTML = `<tr>
    <th>Period</th>
    <th class="num">Branded</th><th class="num">Δ</th>
    <th class="num">Generic</th><th class="num">Δ</th>
    <th class="num">Total</th><th class="num">Δ</th>
  </tr>`;

  const rowsHTML = [];
  for (let i = agg.periods.length - 1; i >= 0; i--) {
    const p = agg.periods[i];
    const prev = i > 0 ? agg.periods[i - 1] : null;
    const cell = (cur, prv) => {
      const v = metric.pick(cur);
      const pv = prv ? metric.pick(prv) : null;
      const vCell = `<td class="num mono">${v == null ? "—" : metric.fmt(v)}</td>`;
      const dCell = `<td class="num">${deltaPill(pctChange(v, pv))}</td>`;
      return vCell + dCell;
    };
    rowsHTML.push(`<tr><td><strong>${escapeHtml(p.label)}</strong></td>${cell(p.branded, prev?.branded)}${cell(p.generic, prev?.generic)}${cell(p.total, prev?.total)}</tr>`);
  }
  tbody.innerHTML = rowsHTML.join("") || `<tr><td colspan="7" class="empty-state">No periods in range.</td></tr>`;
}

/* ---------------------------------------------------------------- *
 * Custom multi-color line chart (branches need fixed colors)
 *
 * The default renderLineChart in charts.js assigns colors from PALETTE in
 * series order. For Spend we want a deliberate mapping (Branded=terracotta,
 * Generic=sage, Total=forest), so we go around the helper here.
 * ---------------------------------------------------------------- */
function renderColoredLineChart(canvas, { labels, series, yFormat, yTitle }) {
  destroyChart(canvas);
  if (typeof window.Chart === "undefined") return;
  const datasets = series.map(s => ({
    label: s.label,
    data: s.data,
    borderColor: s.color,
    backgroundColor: s.color + "22",
    borderWidth: 2.2,
    tension: 0.3,
    pointRadius: 3,
    pointHoverRadius: 5,
    pointBackgroundColor: s.color,
    pointBorderColor: s.color,
    fill: false,
    spanGaps: true,
  }));

  // Compute tick formatter (delegated to charts.js logic, but inlined for color override).
  const tickFn = (v) => {
    const abs = Math.abs(v);
    if (yFormat === "inr") {
      const sign = v < 0 ? "-" : "";
      if (abs >= 1e7) return `${sign}₹${(abs / 1e7).toFixed(1)}Cr`;
      if (abs >= 1e5) return `${sign}₹${(abs / 1e5).toFixed(1)}L`;
      if (abs >= 1000) return `${sign}₹${(abs / 1000).toFixed(1)}K`;
      return `${sign}₹${abs}`;
    }
    if (yFormat === "roas") return `${Number(v).toFixed(1)}x`;
    if (abs >= 1e7) return `${(v / 1e7).toFixed(1)}Cr`;
    if (abs >= 1e5) return `${(v / 1e5).toFixed(1)}L`;
    if (abs >= 1000) return `${(v / 1000).toFixed(1)}K`;
    return Number(v).toLocaleString("en-IN");
  };
  const valueFn = (v) => {
    if (v == null) return "—";
    if (yFormat === "inr")  return fmtINR(v);
    if (yFormat === "roas") return fmtROAS(v);
    return Number(v).toLocaleString("en-IN");
  };

  const chart = new Chart(canvas, {
    type: "line",
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: {
          position: "top", align: "end",
          labels: { boxWidth: 8, boxHeight: 8, padding: 14,
                    font: { size: 12, weight: 600 }, usePointStyle: true },
        },
        tooltip: {
          backgroundColor: "rgba(31,42,34,0.95)",
          titleColor: "#fff", bodyColor: "#fff",
          padding: 10, cornerRadius: 8, displayColors: true,
          boxPadding: 4, boxWidth: 6, boxHeight: 6,
          callbacks: {
            label(ctx) {
              const v = ctx.parsed.y;
              if (v == null) return `${ctx.dataset.label}: —`;
              return `${ctx.dataset.label}: ${valueFn(v)}`;
            },
          },
        },
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: { maxRotation: 0, autoSkip: true, autoSkipPadding: 12, font: { size: 11 } },
        },
        y: {
          beginAtZero: true,
          grid: { color: "rgba(31,42,34,0.06)" },
          ticks: { font: { size: 11 }, callback: tickFn },
          title: yTitle ? { display: true, text: yTitle, font: { size: 11, weight: 600 }, color: "#7A7268" } : undefined,
        },
      },
    },
  });
  return chart;
}

/* ---------------------------------------------------------------- *
 * Downloads
 * ---------------------------------------------------------------- */
function describeContext() {
  return {
    "Tab": "Spend",
    "Granularity": LocalState.gran,
    "Date range": `${LocalState.range.from || "—"} to ${LocalState.range.to || "—"}`,
    "Platforms": LocalState.platforms,
    "View level": LocalState.level,
    "Dimension": (LocalState.dim === "__all__" || LocalState.level === "overall")
      ? "All combined" : LocalState.dim,
    "Generated at": new Date().toISOString(),
  };
}

function downloadMetric(metricKey, kind) {
  const metric = METRICS.find(m => m.key === metricKey);
  const agg = LocalState._agg;
  if (!metric || !agg || !agg.periods.length) {
    toast("Nothing to download.");
    return;
  }
  const cols = [
    { key: "period",      label: "Period" },
    { key: "branded",     label: `Branded ${metric.label}` },
    { key: "branded_d",   label: "Δ vs prev (%)" },
    { key: "generic",     label: `Generic ${metric.label}` },
    { key: "generic_d",   label: "Δ vs prev (%)" },
    { key: "total",       label: `Total ${metric.label}` },
    { key: "total_d",     label: "Δ vs prev (%)" },
  ];
  const rows = [];
  for (let i = agg.periods.length - 1; i >= 0; i--) {
    const p = agg.periods[i];
    const prev = i > 0 ? agg.periods[i - 1] : null;
    const v = (branch) => metric.pick(p[branch]);
    const d = (branch) => {
      const cur = metric.pick(p[branch]);
      const prv = prev ? metric.pick(prev[branch]) : null;
      const dlt = pctChange(cur, prv);
      return dlt == null ? "" : Number(dlt.toFixed(2));
    };
    rows.push({
      period: p.label,
      branded: v("branded") ?? "", branded_d: d("branded"),
      generic: v("generic") ?? "", generic_d: d("generic"),
      total:   v("total")   ?? "", total_d:   d("total"),
    });
  }
  const fname = `nat-habit_spend-${metricKey}_${tsForFilename()}`;
  if (kind === "csv") return downloadCSV(`${fname}.csv`, cols, rows);
  downloadXLSX(`${fname}.xlsx`, [
    { name: metric.label, columns: cols, rows },
    rawRowsSheet("Filtered spend rows"),
    filterContextSheet("Filter context", describeContext()),
  ]);
}

function rawRowsSheet(name) {
  const platSet = new Set(LocalState.platforms);
  const { range, level, dim } = LocalState;
  const cols = [
    { key: "platform", label: "Platform" }, { key: "date", label: "Date" },
    { key: "category", label: "Category" }, { key: "subcategory", label: "Sub-category" },
    { key: "branded_bucket", label: "Type" },
    { key: "marketing_channel", label: "Channel" },
    { key: "spend", label: "Spend" }, { key: "sales", label: "Sales" },
  ];
  const rows = (State.data.bcg_spend || []).filter(r =>
    platSet.has(r.platform) &&
    (!range.from || r.date >= range.from) &&
    (!range.to   || r.date <= range.to) &&
    (level !== "category"    || dim === "__all__" || r.category          === dim) &&
    (level !== "subcategory" || dim === "__all__" || r.subcategory       === dim) &&
    (level !== "channel"     || dim === "__all__" || r.marketing_channel === dim));
  return { name, columns: cols, rows };
}
