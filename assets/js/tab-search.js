/**
 * tab-business.js — Business tab.
 *
 * Spec §5.3 + extensions:
 *   - Five chart+table pairs: Page Views, Units Sold, Revenue, Spend, ROAS.
 *   - ROAS = ad-attributable Sales / Spend (from BCG Data). Only Amazon has
 *     spend data currently; other platforms will show nulls/gaps gracefully.
 *   - Multi-category selection at Category/Subcategory view level:
 *       - 1 selected  → single combined line (same as before)
 *       - 2–10 selected → one line per category/subcategory + one "Combined" line
 *       - >10 cap enforced with a warning
 *
 * Data sources:
 *   - sales.json (lazy-loaded) for page_views/units/revenue.
 *   - bcg_spend (already in main payload) for spend + ad-sales (ROAS).
 *   - weekly_catalogue for SKU → product-name lookup.
 */

import { State, loadTab } from "./dashboard.js";
import { createDateRange, createSegmented, createMultiSelect } from "./filters.js";
import { renderLineChart, destroyChart, PALETTE } from "./charts.js";
import { downloadCSV, downloadXLSX, filterContextSheet } from "./downloads.js";
import { escapeHtml, fmtInt, fmtINR, fmtROAS, pctChange, toast,
         makeTableCollapsible, syncTableCollapseLabels, wireTableToggleAll } from "./util.js";
import {
  bucketKey, enumeratePeriods,
  lastIndexWithData, findPrevWithData,
  pluralize, deltaPill, tsForFilename,
} from "./aggregate.js";

/* ---------------------------------------------------------------- *
 * Constants
 * ---------------------------------------------------------------- */
const METRICS = [
  { key: "page_views", label: "Page Views",  fmt: fmtInt, yFormat: "int",
    yTitle: "Page views", skuOk: true, spendOnly: false },
  { key: "units",      label: "Units Sold",  fmt: fmtInt, yFormat: "int",
    yTitle: "Units",      skuOk: true, spendOnly: false },
  { key: "revenue",    label: "Revenue",     fmt: fmtINR, yFormat: "inr",
    yTitle: "Revenue (₹)", skuOk: true, spendOnly: false },
  { key: "spend",      label: "Spend",       fmt: fmtINR, yFormat: "inr",
    yTitle: "Spend (₹)",  skuOk: false, spendOnly: true },
  { key: "roas",       label: "ROAS",        fmt: fmtROAS, yFormat: "roas",
    yTitle: "ROAS (Sales / Spend)", skuOk: false, spendOnly: true },
];

const MULTI_DIM_LIMIT = 10;   // max selectable dims for multi-line mode

/* ---------------------------------------------------------------- *
 * Module-local state
 * ---------------------------------------------------------------- */
const LocalState = {
  range: { from: "", to: "" },
  gran: "weekly",
  platforms: [],
  level: "overall",       // 'overall' | 'category' | 'subcategory' | 'sku'
  dim: "__all__",         // used for SKU; category/subcategory use dims[]
  dims: [],               // multi-selected category/subcategory values
  filters: null,
  salesRows: null,        // populated on first lazy-load
  skuLookup: null,        // Map<nh_sku, short_code>
  _agg: null,
  _dimMultiSelect: null,  // reference to the multi-select widget (cat/sub levels)
};

let _built = false;

/** Reset module state (called by Live Refresh to force a rebuild). */
export function reset() {
  _built = false;
  LocalState.salesRows = null;
  LocalState._dimMultiSelect = null;
}

/* ---------------------------------------------------------------- *
 * Public entry
 * ---------------------------------------------------------------- */
export async function renderBusinessTab() {
  const root = document.getElementById("content-business");
  if (!root || !State.data) return;

  if (!_built) {
    _built = true;
    buildSkeleton(root);
    buildFilters();
    LocalState.skuLookup = buildSkuLookup();
  }

  // Lazy-load sales.json the first time.
  if (LocalState.salesRows == null) {
    showOverlay(root, "Loading sales data…");
    try {
      LocalState.salesRows = await loadTab("sales");
    } catch (err) {
      showOverlay(root, `Failed to load sales data: ${err.message}`, true);
      return;
    } finally {
      hideOverlay();
    }
  }
  rerender();
}

/* ---------------------------------------------------------------- *
 * Skeleton — one section card per metric
 * ---------------------------------------------------------------- */
function buildSkeleton(root) {
  const sections = METRICS.map(m => `
    <section class="section-card" data-metric="${m.key}">
      <header class="section-head">
        <h2 class="section-title">${m.label}
          <span class="section-meta" id="bus-${m.key}-kpi"></span>
        </h2>
        <div class="section-actions">
          <span class="section-meta" id="bus-${m.key}-meta"></span>
          <button class="icon-btn" data-dl="csv" data-metric="${m.key}">CSV</button>
          <button class="icon-btn" data-dl="xlsx" data-metric="${m.key}">Excel</button>
        </div>
      </header>
      <div class="chart-box"><canvas id="bus-${m.key}-canvas"></canvas></div>
      <div class="tbl-wrap is-scroll-y">
        <table class="data-tbl" id="bus-${m.key}-tbl">
          <thead></thead>
          <tbody></tbody>
        </table>
      </div>
      <div class="empty-state" id="bus-${m.key}-empty" hidden></div>
    </section>
  `).join("");

  root.innerHTML = `
    <div id="bus-overlay" class="bus-overlay" hidden>
      <div class="boot-spinner" aria-hidden="true"></div>
      <p id="bus-overlay-msg" class="boot-msg">Loading…</p>
    </div>
    ${sections}
  `;

  root.querySelectorAll("[data-dl]").forEach(btn => {
    btn.addEventListener("click", () => {
      downloadMetric(btn.dataset.metric, btn.dataset.dl);
    });
  });

  root.querySelectorAll(".section-card > .tbl-wrap").forEach(el => makeTableCollapsible(el));
}

/* ---------------------------------------------------------------- *
 * Filter bar
 * ---------------------------------------------------------------- */
function buildFilters() {
  const bar = document.getElementById("filters-business");
  if (!bar) return;
  bar.innerHTML = "";

  const md = State.data.metadata;
  const dr = md.date_range || {};

  const dateF = createDateRange({
    id: "business.range",
    minDate: dr.min,
    maxDate: dr.max,
    defaultDays: 90,
  });
  bar.appendChild(dateF.el);

  const granF = createSegmented({
    id: "business.gran",
    label: "Granularity",
    options: [
      { value: "daily",   label: "Daily" },
      { value: "weekly",  label: "Weekly" },
      { value: "monthly", label: "Monthly" },
    ],
    defaultValue: "weekly",
  });
  bar.appendChild(granF.el);

  const platformOptions = (md.platforms || []).map(p => ({ value: p, label: p }));
  const platsF = createMultiSelect({
    id: "business.platforms",
    label: "Platforms",
    options: platformOptions,
    defaultSelected: platformOptions.map(o => o.value),
    allowAll: true,
  });
  bar.appendChild(platsF.el);

  const levelF = createSegmented({
    id: "business.level",
    label: "View level",
    options: [
      { value: "overall",    label: "Overall" },
      { value: "category",   label: "Category" },
      { value: "subcategory", label: "Sub-category" },
      { value: "sku",        label: "SKU" },
    ],
    defaultValue: "overall",
  });
  bar.appendChild(levelF.el);

  // Dimension area — swaps between a multi-select (cat/sub) and a <select> (SKU).
  const dimWrap = document.createElement("div");
  dimWrap.id = "business-dim-wrap";
  dimWrap.style.display = "none";
  bar.appendChild(dimWrap);

  // SKU <select> — only shown at SKU level.
  const skuWrap = document.createElement("div");
  skuWrap.className = "fl-group";
  skuWrap.id = "business-sku-wrap";
  skuWrap.innerHTML = `
    <div class="fl-lbl" id="business-sku-label">SKU</div>
    <select id="business-sku-select" class="fl-select"></select>
  `;
  skuWrap.style.display = "none";
  bar.appendChild(skuWrap);

  const toggleBtn = document.createElement("button");
  toggleBtn.className = "fl-tbl-toggle";
  toggleBtn.textContent = "Show all tables";
  bar.appendChild(toggleBtn);
  wireTableToggleAll(toggleBtn, document.getElementById("content-business"));

  LocalState.filters = { dateF, granF, platsF, levelF };

  syncFromFilters();

  dateF.onChange(() => { syncFromFilters(); rerender(); });
  granF.onChange(() => { syncFromFilters(); rerender(); });
  platsF.onChange(() => { syncFromFilters(); rebuildDimension(); rerender(); });
  levelF.onChange(() => {
    LocalState.dim = "__all__";
    LocalState.dims = [];
    syncFromFilters();
    rebuildDimension();
    rerender();
  });

  document.getElementById("business-sku-select").addEventListener("change", e => {
    LocalState.dim = e.target.value;
    rerender();
  });

  rebuildDimension();
}

function syncFromFilters() {
  const { dateF, granF, platsF, levelF } = LocalState.filters;
  LocalState.range    = dateF.getRange();
  LocalState.gran     = granF.getValue();
  LocalState.platforms = platsF.getSelected();
  LocalState.level    = levelF.getValue();
}

/* ---------------------------------------------------------------- *
 * Dimension widget — switches between multi-select (cat/sub) and <select> (SKU)
 * ---------------------------------------------------------------- */
function rebuildDimension() {
  const level   = LocalState.level;
  const dimWrap = document.getElementById("business-dim-wrap");
  const skuWrap = document.getElementById("business-sku-wrap");

  if (level === "overall") {
    dimWrap.style.display = "none";
    skuWrap.style.display = "none";
    LocalState.dim  = "__all__";
    LocalState.dims = [];
    LocalState._dimMultiSelect = null;
    return;
  }

  if (level === "sku") {
    dimWrap.style.display = "none";
    skuWrap.style.display = "";
    LocalState._dimMultiSelect = null;
    refreshSkuDropdown();
    return;
  }

  // Category or Sub-category — multi-select
  skuWrap.style.display = "none";
  dimWrap.style.display = "";
  dimWrap.innerHTML = "";   // clear previous widget

  const labelMap = { category: "Category", subcategory: "Sub-category" };
  const field    = level === "category" ? "category" : "subcategory";
  const platSet  = new Set(LocalState.platforms);

  const dimSet = new Set();
  for (const r of (LocalState.salesRows || [])) {
    if (platSet.has(r.platform) && r[field]) dimSet.add(r[field]);
  }
  const opts = [...dimSet].sort().map(v => ({ value: v, label: v }));

  const ms = createMultiSelect({
    id: `business.dims.${level}`,
    label: labelMap[level],
    options: opts,
    defaultSelected: opts.map(o => o.value),  // all selected initially
    allowAll: true,
    maxSelected: MULTI_DIM_LIMIT,
  });

  dimWrap.appendChild(ms.el);
  LocalState._dimMultiSelect = ms;
  LocalState.dims = ms.getSelected();

  ms.onChange(sel => {
    LocalState.dims = sel;
    rerender();
  });
}

function refreshSkuDropdown() {
  const sel = document.getElementById("business-sku-select");
  if (!sel) return;
  const platSet = new Set(LocalState.platforms);
  const skuSet = new Set();
  for (const r of (LocalState.salesRows || [])) {
    if (platSet.has(r.platform) && r.nh_sku) skuSet.add(r.nh_sku);
  }
  const opts = [...skuSet].sort().map(sku => ({ value: sku, display: skuDisplay(sku) }));
  sel.innerHTML = [
    `<option value="__all__">All SKUs (combined)</option>`,
    ...opts.map(o => `<option value="${escapeHtml(o.value)}">${escapeHtml(o.display)}</option>`),
  ].join("");
  if (LocalState.dim !== "__all__" && !opts.some(o => o.value === LocalState.dim)) {
    LocalState.dim = "__all__";
  }
  sel.value = LocalState.dim;
}

/* ---------------------------------------------------------------- *
 * SKU → short_code lookup
 * ---------------------------------------------------------------- */
function buildSkuLookup() {
  const map = new Map();
  for (const r of (State.data.weekly_catalogue || [])) {
    if (r.nh_sku && r.short_code && !map.has(r.nh_sku)) map.set(r.nh_sku, r.short_code);
  }
  return map;
}

function skuDisplay(sku) {
  const sc = LocalState.skuLookup?.get(sku);
  return sc ? `${sc} (${sku})` : sku;
}

/* ---------------------------------------------------------------- *
 * Re-render
 * ---------------------------------------------------------------- */
function rerender() {
  const agg = computeAggregations();
  LocalState._agg = agg;
  for (const m of METRICS) renderMetricPanel(m, agg);
  syncTableCollapseLabels(document.getElementById("content-business"));
}

/* ---------------------------------------------------------------- *
 * Aggregations
 *
 * Multi-dim mode (category/subcategory with 2+ dims selected):
 *   agg.multiDim = true
 *   agg.dimKeys  = string[]     — the selected dim values
 *   agg.byDim    = Map<dim, periods[]>  — per-dim period arrays
 *   agg.periods  = combined period array (union of all dims, with combined totals)
 *
 * Single-dim / overall mode:
 *   agg.multiDim = false
 *   agg.periods  = periods[]
 * ---------------------------------------------------------------- */
function computeAggregations() {
  const { range, gran, platforms, level, dim, dims } = LocalState;
  const platSet = new Set(platforms);
  const spendAvailable = (level !== "sku");

  // Determine if we're in multi-dim mode.
  const isMultiDim = (level === "category" || level === "subcategory") && dims.length >= 2;

  if (isMultiDim) {
    return computeMultiDimAgg({ range, gran, platSet, level, dims, spendAvailable });
  }

  // Single-dim / overall / SKU mode (original logic).
  return computeSingleAgg({ range, gran, platSet, level, dim, dims, spendAvailable });
}

function computeSingleAgg({ range, gran, platSet, level, dim, dims, spendAvailable }) {
  // The effective single-dim value: for cat/sub with 0 or 1 dim selected
  // we filter to that dim; for "all" we aggregate everything.
  const effDim = (level === "category" || level === "subcategory")
    ? (dims.length === 1 ? dims[0] : "__all__")
    : dim;

  const sales = (LocalState.salesRows || []).filter(r => {
    if (!platSet.has(r.platform)) return false;
    if (range.from && r.date < range.from) return false;
    if (range.to   && r.date > range.to)   return false;
    if (level === "category"    && effDim !== "__all__" && r.category    !== effDim) return false;
    if (level === "subcategory" && effDim !== "__all__" && r.subcategory !== effDim) return false;
    if (level === "sku"         && dim    !== "__all__" && r.nh_sku      !== dim)    return false;
    return true;
  });

  const spendRows = spendAvailable ? (State.data.bcg_spend || []).filter(r => {
    if (!platSet.has(r.platform)) return false;
    if (range.from && r.date < range.from) return false;
    if (range.to   && r.date > range.to)   return false;
    if (level === "category"    && effDim !== "__all__" && r.category    !== effDim) return false;
    if (level === "subcategory" && effDim !== "__all__" && r.subcategory !== effDim) return false;
    return true;
  }) : [];

  const periodList = enumeratePeriods(range.from, range.to, gran);
  const periodMap  = new Map(periodList.map(p => [p.key, {
    key: p.key, label: p.label,
    page_views: null, units: null, revenue: null,
    spend: null, ad_sales: null, roas: null,
    hasSales: false, hasSpend: false,
  }]));

  for (const r of sales) {
    const key = bucketKey(r.date, gran);
    const e = periodMap.get(key);
    if (!e) continue;
    if (!e.hasSales) { e.page_views = 0; e.units = 0; e.revenue = 0; e.hasSales = true; }
    e.page_views += +r.glance_views || 0;
    e.units      += +r.gross_units  || 0;
    e.revenue    += +r.revenue      || 0;
  }
  for (const r of spendRows) {
    const key = bucketKey(r.date, gran);
    const e = periodMap.get(key);
    if (!e) continue;
    if (!e.hasSpend) { e.spend = 0; e.ad_sales = 0; e.hasSpend = true; }
    e.spend    += +r.spend || 0;
    e.ad_sales += +r.sales || 0;
  }

  const periods = periodList.map(p => {
    const e = periodMap.get(p.key);
    if (e.hasSpend && e.spend > 0) e.roas = e.ad_sales / e.spend;
    else if (e.hasSpend && e.spend === 0) e.roas = null;
    return e;
  });

  const totals = { page_views: 0, units: 0, revenue: 0, spend: 0, ad_sales: 0 };
  for (const p of periods) {
    if (p.hasSales) {
      totals.page_views += p.page_views;
      totals.units      += p.units;
      totals.revenue    += p.revenue;
    }
    if (p.hasSpend) { totals.spend += p.spend; totals.ad_sales += p.ad_sales; }
  }

  return { periods, multiDim: false, spendAvailable, totals };
}

function computeMultiDimAgg({ range, gran, platSet, level, dims, spendAvailable }) {
  const field = level === "category" ? "category" : "subcategory";
  const periodList = enumeratePeriods(range.from, range.to, gran);

  // Per-dim period maps.
  const byDim = new Map();
  for (const d of dims) {
    byDim.set(d, new Map(periodList.map(p => [p.key, {
      key: p.key, label: p.label,
      page_views: null, units: null, revenue: null,
      spend: null, ad_sales: null, roas: null,
      hasSales: false, hasSpend: false,
    }])));
  }

  // Also a combined map.
  const combinedMap = new Map(periodList.map(p => [p.key, {
    key: p.key, label: p.label,
    page_views: null, units: null, revenue: null,
    spend: null, ad_sales: null, roas: null,
    hasSales: false, hasSpend: false,
  }]));

  const dimSet = new Set(dims);

  for (const r of (LocalState.salesRows || [])) {
    if (!platSet.has(r.platform)) continue;
    if (range.from && r.date < range.from) continue;
    if (range.to   && r.date > range.to)   continue;
    const dv = r[field];
    if (!dimSet.has(dv)) continue;
    const key = bucketKey(r.date, gran);
    for (const [dimVal, pm] of [[dv, byDim.get(dv)], ["__combined__", combinedMap]]) {
      if (!pm) continue;
      const e = pm.get(key);
      if (!e) continue;
      if (!e.hasSales) { e.page_views = 0; e.units = 0; e.revenue = 0; e.hasSales = true; }
      e.page_views += +r.glance_views || 0;
      e.units      += +r.gross_units  || 0;
      e.revenue    += +r.revenue      || 0;
    }
  }

  if (spendAvailable) {
    for (const r of (State.data.bcg_spend || [])) {
      if (!platSet.has(r.platform)) continue;
      if (range.from && r.date < range.from) continue;
      if (range.to   && r.date > range.to)   continue;
      const dv = r[field];
      if (!dimSet.has(dv)) continue;
      const key = bucketKey(r.date, gran);
      for (const [dimVal, pm] of [[dv, byDim.get(dv)], ["__combined__", combinedMap]]) {
        if (!pm) continue;
        const e = pm.get(key);
        if (!e) continue;
        if (!e.hasSpend) { e.spend = 0; e.ad_sales = 0; e.hasSpend = true; }
        e.spend    += +r.spend || 0;
        e.ad_sales += +r.sales || 0;
      }
    }
  }

  // Finalize ROAS for each dim and combined.
  const finalize = (pm) => periodList.map(p => {
    const e = pm.get(p.key);
    if (e.hasSpend && e.spend > 0) e.roas = e.ad_sales / e.spend;
    return e;
  });

  const byDimPeriods = new Map();
  for (const [d, pm] of byDim) byDimPeriods.set(d, finalize(pm));
  const combinedPeriods = finalize(combinedMap);

  // Flat periods array = combined (for KPI / meta display).
  return {
    multiDim: true,
    dimKeys: dims,
    byDimPeriods,
    combinedPeriods,
    periods: combinedPeriods,
    spendAvailable,
    totals: { page_views: 0, units: 0, revenue: 0, spend: 0, ad_sales: 0 },
  };
}

/* ---------------------------------------------------------------- *
 * Per-metric panel render
 * ---------------------------------------------------------------- */
function renderMetricPanel(metric, agg) {
  const section  = document.querySelector(`.section-card[data-metric="${metric.key}"]`);
  const canvas   = document.getElementById(`bus-${metric.key}-canvas`);
  const thead    = document.querySelector(`#bus-${metric.key}-tbl thead`);
  const tbody    = document.querySelector(`#bus-${metric.key}-tbl tbody`);
  const empty    = document.getElementById(`bus-${metric.key}-empty`);
  const kpiEl    = document.getElementById(`bus-${metric.key}-kpi`);
  const metaEl   = document.getElementById(`bus-${metric.key}-meta`);

  // ROAS and Spend at SKU level → N/A
  if (metric.skuOk === false && !agg.spendAvailable) {
    destroyChart(canvas);
    canvas.parentElement.style.display = "none";
    section.querySelector(".tbl-wrap").style.display = "none";
    empty.hidden = false;
    const reason = metric.key === "roas"
      ? "ROAS isn't available at SKU level (spend is recorded at category granularity)."
      : "Spend isn't available at SKU level (spend is recorded at category granularity).<br>Switch to a higher view level.";
    empty.innerHTML = `<strong>Not available at SKU level.</strong><br>${reason}`;
    kpiEl.textContent = ""; metaEl.textContent = "";
    section.querySelectorAll("[data-dl]").forEach(b => b.disabled = true);
    return;
  }

  canvas.parentElement.style.display = "";
  section.querySelector(".tbl-wrap").style.display = "";
  empty.hidden = true;
  section.querySelectorAll("[data-dl]").forEach(b => b.disabled = false);

  if (agg.multiDim) {
    renderMultiDimPanel(metric, agg, canvas, thead, tbody, kpiEl, metaEl);
  } else {
    renderSingleDimPanel(metric, agg, canvas, thead, tbody, kpiEl, metaEl);
  }
}

/* ── single-dim (original behaviour) ── */
function renderSingleDimPanel(metric, agg, canvas, thead, tbody, kpiEl, metaEl) {
  const { periods } = agg;
  const values = periods.map(p => {
    if (metric.key === "spend")    return p.hasSpend ? p.spend    : null;
    if (metric.key === "roas")     return p.hasSpend ? p.roas     : null;
    return p.hasSales ? p[metric.key] : null;
  });
  const labels = periods.map(p => p.label);

  const valIdx   = lastIndexWithData(values);
  const latestVal = valIdx >= 0 ? values[valIdx] : null;
  const prevIdx  = findPrevWithData(values, valIdx);
  const prevVal  = prevIdx >= 0 ? values[prevIdx] : null;
  const delta    = pctChange(latestVal, prevVal);

  if (latestVal == null) {
    kpiEl.innerHTML = `<span style="color:var(--brand-muted-2)">No data in range</span>`;
  } else {
    const pn = ({ daily:"day", weekly:"week", monthly:"month" })[LocalState.gran] || "period";
    const dp = delta == null
      ? `<span style="color:var(--brand-muted-2); margin-left:8px;">no prior ${pn}</span>`
      : `<span class="${delta > 0 ? "delta-up" : delta < 0 ? "delta-down" : ""}" style="margin-left:8px;">${
            delta > 0 ? "▲" : delta < 0 ? "▼" : "→"} ${Math.abs(delta).toFixed(1)}%</span>`;
    kpiEl.innerHTML = `<span class="kpi-val">${metric.fmt(latestVal)}</span>${dp}`;
  }
  metaEl.textContent = `${periods.length} ${pluralize(LocalState.gran, periods.length)}`;

  renderLineChart(canvas, {
    labels,
    series: [{ label: metric.label, data: values }],
    yFormat: metric.yFormat,
    yTitle:  metric.yTitle,
  });

  let head = `<tr><th>Period</th><th class="num">${escapeHtml(metric.label)}</th><th class="num">Δ vs prev</th></tr>`;
  thead.innerHTML = head;

  const rowsHTML = [];
  for (let i = periods.length - 1; i >= 0; i--) {
    const p = periods[i];
    const v = values[i];
    const prev = i > 0 ? values[i - 1] : null;
    const dlt = pctChange(v, prev);
    rowsHTML.push(`<tr>
      <td><strong>${escapeHtml(p.label)}</strong></td>
      <td class="num mono">${v == null ? "—" : metric.fmt(v)}</td>
      <td class="num">${dlt == null ? `<span class="pill pill--flat">—</span>` : deltaPill(dlt)}</td>
    </tr>`);
  }
  tbody.innerHTML = rowsHTML.join("") ||
    `<tr><td colspan="3" class="empty-state">No periods in range.</td></tr>`;
}

/* ── multi-dim (2+ categories/subcategories) ── */
function renderMultiDimPanel(metric, agg, canvas, thead, tbody, kpiEl, metaEl) {
  const { dimKeys, byDimPeriods, combinedPeriods } = agg;
  const labels = combinedPeriods.map(p => p.label);

  // Build one data array per dim + one combined.
  const getVal = (p) => {
    if (metric.key === "spend") return p.hasSpend ? p.spend : null;
    if (metric.key === "roas")  return p.hasSpend ? p.roas  : null;
    return p.hasSales ? p[metric.key] : null;
  };

  const dimSeries = dimKeys.map((d, i) => ({
    label: d,
    data:  (byDimPeriods.get(d) || []).map(getVal),
    color: PALETTE[i % PALETTE.length],
  }));
  const combinedValues = combinedPeriods.map(getVal);
  const combinedSeries = {
    label: "Combined",
    data:  combinedValues,
    color: "#1F2A22",   // deep forest for the combined line
  };

  // KPI from the combined line.
  const valIdx    = lastIndexWithData(combinedValues);
  const latestVal = valIdx >= 0 ? combinedValues[valIdx] : null;
  const prevIdx   = findPrevWithData(combinedValues, valIdx);
  const prevVal   = prevIdx >= 0 ? combinedValues[prevIdx] : null;
  const delta     = pctChange(latestVal, prevVal);

  if (latestVal == null) {
    kpiEl.innerHTML = `<span style="color:var(--brand-muted-2)">No data in range</span>`;
  } else {
    const pn = ({ daily:"day", weekly:"week", monthly:"month" })[LocalState.gran] || "period";
    const dp = delta == null
      ? `<span style="color:var(--brand-muted-2); margin-left:8px;">no prior ${pn}</span>`
      : `<span class="${delta > 0 ? "delta-up" : delta < 0 ? "delta-down" : ""}" style="margin-left:8px;">${
            delta > 0 ? "▲" : delta < 0 ? "▼" : "→"} ${Math.abs(delta).toFixed(1)}%</span>`;
    kpiEl.innerHTML = `<span class="kpi-val">${metric.fmt(latestVal)}</span>${dp}`;
  }
  metaEl.textContent =
    `${combinedPeriods.length} ${pluralize(LocalState.gran, combinedPeriods.length)} · ${dimKeys.length} ${LocalState.level === "category" ? "categories" : "sub-categories"}`;

  // Chart: individual dim lines + combined (dashed, prominent).
  // Build datasets directly so we can set dash style on combined.
  destroyChart(canvas);
  if (typeof window.Chart !== "undefined") {
    const allSeries = [...dimSeries, combinedSeries];
    const datasets = allSeries.map((s, i) => {
      const isCombined = (s.label === "Combined");
      return {
        label: s.label,
        data:  s.data,
        borderColor: s.color,
        backgroundColor: s.color + "22",
        borderWidth: isCombined ? 2.8 : 2,
        borderDash: isCombined ? [6, 3] : [],
        tension: 0.3,
        pointRadius: 3,
        pointHoverRadius: 5,
        pointBackgroundColor: s.color,
        pointBorderColor: s.color,
        fill: false,
        spanGaps: true,
      };
    });

    // Tick / value formatters (duplicated from charts.js for the direct Chart() call).
    const tickFns = {
      int:  v => { const a = Math.abs(v); return a >= 1e7 ? `${(v/1e7).toFixed(1)}Cr` : a >= 1e5 ? `${(v/1e5).toFixed(1)}L` : a >= 1000 ? `${(v/1000).toFixed(1)}K` : String(v); },
      inr:  v => { const a = Math.abs(v); const s = v < 0 ? "-" : ""; return a >= 1e7 ? `${s}₹${(a/1e7).toFixed(1)}Cr` : a >= 1e5 ? `${s}₹${(a/1e5).toFixed(1)}L` : a >= 1000 ? `${s}₹${(a/1000).toFixed(1)}K` : `${s}₹${a}`; },
      roas: v => `${Number(v).toFixed(1)}x`,
      pct:  v => `${Number(v).toFixed(0)}%`,
    };
    const valFns = {
      int:  v => v == null ? "—" : Number(v).toLocaleString("en-IN"),
      inr:  fmtINR,
      roas: fmtROAS,
      pct:  v => v == null ? "—" : `${Number(v).toFixed(2)}%`,
    };
    const tickFn = tickFns[metric.yFormat] || tickFns.int;
    const valFn  = valFns[metric.yFormat]  || valFns.int;

    new Chart(canvas, {
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
                return `${ctx.dataset.label}: ${v == null ? "—" : valFn(v)}`;
              },
            },
          },
        },
        scales: {
          x: { grid: { display: false },
               ticks: { maxRotation: 0, autoSkip: true, autoSkipPadding: 12, font: { size: 11 } } },
          y: { beginAtZero: true, grid: { color: "rgba(31,42,34,0.06)" },
               ticks: { font: { size: 11 }, callback: tickFn },
               title: metric.yTitle ? { display: true, text: metric.yTitle,
                        font: { size: 11, weight: 600 }, color: "#7A7268" } : undefined },
        },
      },
    });
  }

  // Table: period rows × (dim1, dim2, …, Combined) columns.
  thead.innerHTML = `<tr>
    <th>Period</th>
    ${dimKeys.map(d => `<th class="num">${escapeHtml(d)}</th>`).join("")}
    <th class="num"><strong>Combined</strong></th>
    <th class="num">Δ Combined</th>
  </tr>`;

  const rowsHTML = [];
  for (let i = combinedPeriods.length - 1; i >= 0; i--) {
    const p = combinedPeriods[i];
    const cVal = combinedValues[i];
    const cPrev = i > 0 ? combinedValues[i - 1] : null;
    const dlt = pctChange(cVal, cPrev);
    const dimCells = dimKeys.map(d => {
      const v = getVal((byDimPeriods.get(d) || [])[i] || {});
      return `<td class="num mono">${v == null ? "—" : metric.fmt(v)}</td>`;
    }).join("");
    rowsHTML.push(`<tr>
      <td><strong>${escapeHtml(p.label)}</strong></td>
      ${dimCells}
      <td class="num mono"><strong>${cVal == null ? "—" : metric.fmt(cVal)}</strong></td>
      <td class="num">${dlt == null ? `<span class="pill pill--flat">—</span>` : deltaPill(dlt)}</td>
    </tr>`);
  }
  tbody.innerHTML = rowsHTML.join("") ||
    `<tr><td colspan="${dimKeys.length + 3}" class="empty-state">No periods in range.</td></tr>`;
}

/* ---------------------------------------------------------------- *
 * Overlay (used during initial sales.json load)
 * ---------------------------------------------------------------- */
function showOverlay(root, msg, isError = false) {
  const o = root.querySelector("#bus-overlay");
  const m = root.querySelector("#bus-overlay-msg");
  if (!o) return;
  o.hidden = false;
  m.textContent = msg;
  m.style.color = isError ? "var(--down)" : "var(--brand-muted)";
  o.querySelector(".boot-spinner").style.display = isError ? "none" : "";
}
function hideOverlay() {
  const o = document.getElementById("bus-overlay");
  if (o) o.hidden = true;
}

/* ---------------------------------------------------------------- *
 * Downloads
 * ---------------------------------------------------------------- */
function describeContext() {
  const { level, dim, dims } = LocalState;
  let dimDesc;
  if (level === "overall") dimDesc = "All combined";
  else if (level === "sku") dimDesc = dim === "__all__" ? "All SKUs combined" : skuDisplay(dim);
  else dimDesc = dims.length === 0 ? "All combined"
    : dims.length === 1 ? dims[0]
    : `${dims.length} selected: ${dims.join(", ")}`;
  return {
    "Tab": "Business",
    "Granularity": LocalState.gran,
    "Date range": `${LocalState.range.from || "—"} to ${LocalState.range.to || "—"}`,
    "Platforms": LocalState.platforms,
    "View level": level,
    "Dimension": dimDesc,
    "Generated at": new Date().toISOString(),
  };
}

function downloadMetric(metricKey, kind) {
  const metric = METRICS.find(m => m.key === metricKey);
  const agg = LocalState._agg;
  if (!metric || !agg) return;
  if (!agg.spendAvailable && metric.skuOk === false) {
    toast(`${metric.label} isn't available at SKU level.`);
    return;
  }

  const fname = `nat-habit_business-${metricKey.replace("_", "-")}_${tsForFilename()}`;

  if (agg.multiDim) {
    // Multi-dim table: period + per-dim + combined columns.
    const { dimKeys, byDimPeriods, combinedPeriods } = agg;
    const getVal = (p) => {
      if (metricKey === "spend") return p.hasSpend ? p.spend : null;
      if (metricKey === "roas")  return p.hasSpend ? p.roas  : null;
      return p.hasSales ? p[metricKey] : null;
    };
    const cols = [
      { key: "period", label: "Period" },
      ...dimKeys.map(d => ({ key: `dim_${d}`, label: d })),
      { key: "combined", label: "Combined" },
      { key: "delta", label: "Δ Combined (%)" },
    ];
    const combinedValues = combinedPeriods.map(getVal);
    const rows = [];
    for (let i = combinedPeriods.length - 1; i >= 0; i--) {
      const p = combinedPeriods[i];
      const cVal  = combinedValues[i];
      const cPrev = i > 0 ? combinedValues[i - 1] : null;
      const dlt   = pctChange(cVal, cPrev);
      const row   = { period: p.label, combined: cVal ?? "", delta: dlt == null ? "" : Number(dlt.toFixed(2)) };
      for (const d of dimKeys) {
        const dv = getVal((byDimPeriods.get(d) || [])[i] || {});
        row[`dim_${d}`] = dv ?? "";
      }
      rows.push(row);
    }
    if (!rows.length) { toast("Nothing to download."); return; }
    if (kind === "csv") return downloadCSV(`${fname}.csv`, cols, rows);
    return downloadXLSX(`${fname}.xlsx`, [
      { name: metric.label, columns: cols, rows },
      rawRowsSheet(metricKey),
      filterContextSheet("Filter context", describeContext()),
    ]);
  }

  // Single-dim download (original).
  const values = agg.periods.map(p => {
    if (metricKey === "spend") return p.hasSpend ? p.spend : null;
    if (metricKey === "roas")  return p.hasSpend ? p.roas  : null;
    return p.hasSales ? p[metricKey] : null;
  });
  const cols = [
    { key: "period", label: "Period" },
    { key: "value",  label: metric.label },
    { key: "delta",  label: "Δ vs prev (%)" },
  ];
  const rows = [];
  for (let i = agg.periods.length - 1; i >= 0; i--) {
    const v    = values[i];
    const prev = i > 0 ? values[i - 1] : null;
    const dlt  = pctChange(v, prev);
    rows.push({ period: agg.periods[i].label, value: v ?? "", delta: dlt == null ? "" : Number(dlt.toFixed(2)) });
  }
  if (!rows.length) { toast("Nothing to download."); return; }
  if (kind === "csv") return downloadCSV(`${fname}.csv`, cols, rows);
  downloadXLSX(`${fname}.xlsx`, [
    { name: metric.label, columns: cols, rows },
    rawRowsSheet(metricKey),
    filterContextSheet("Filter context", describeContext()),
  ]);
}

function rawRowsSheet(metricKey) {
  const { range, level, dim, dims, platforms } = LocalState;
  const platSet = new Set(platforms);
  const field = level === "category" ? "category" : level === "subcategory" ? "subcategory" : null;
  const dimSet = field ? new Set(dims) : null;
  const effDim = level === "sku" ? dim : "__all__";

  if (metricKey === "spend" || metricKey === "roas") {
    const cols = [
      { key: "platform", label: "Platform" }, { key: "date", label: "Date" },
      { key: "category", label: "Category" }, { key: "subcategory", label: "Sub-category" },
      { key: "branded_bucket", label: "Type" }, { key: "marketing_channel", label: "Channel" },
      { key: "spend", label: "Spend" }, { key: "sales", label: "Ad Sales" },
    ];
    const rows = (State.data.bcg_spend || []).filter(r =>
      platSet.has(r.platform) &&
      (!range.from || r.date >= range.from) && (!range.to || r.date <= range.to) &&
      (!dimSet || dimSet.has(r[field])));
    return { name: "Filtered spend rows", columns: cols, rows };
  }
  const cols = [
    { key: "platform", label: "Platform" }, { key: "date", label: "Date" },
    { key: "nh_sku", label: "NH SKU" },
    { key: "category", label: "Category" }, { key: "subcategory", label: "Sub-category" },
    { key: "glance_views", label: "Page Views" },
    { key: "gross_units",  label: "Units" },
    { key: "revenue",      label: "Revenue" },
  ];
  const rows = (LocalState.salesRows || []).filter(r =>
    platSet.has(r.platform) &&
    (!range.from || r.date >= range.from) && (!range.to || r.date <= range.to) &&
    (!dimSet || dimSet.has(r[field])) &&
    (level !== "sku" || effDim === "__all__" || r.nh_sku === effDim));
  return { name: "Filtered sales rows", columns: cols, rows };
}
