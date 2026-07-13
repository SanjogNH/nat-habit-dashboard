/**
 * tab-business.js — Business tab.
 *
 * Spec §5.3. Four chart+table pairs (Page Views, Units Sold, Revenue, Spend).
 * Drill levels: Overall / Category / Subcategory / SKU. Spend is at category
 * or subcategory granularity in the source — at SKU view we show "N/A at SKU
 * level" instead of a fake number.
 *
 * Data sources:
 *   - sales.json (lazy-loaded) for page_views/units/revenue.
 *   - bcg_spend (already in main payload) for spend.
 *   - weekly_catalogue for SKU → product-name lookup.
 */

import { State, loadTab } from "./dashboard.js";
import {
  createDateRange, createSegmented, createMultiSelect,
  renderChipsAcrossTab, buildDateChip, buildMultiSelectChip, buildSegmentChip,
} from "./filters.js";
import { renderLineChart, destroyChart, exportChartImage, PALETTE } from "./charts.js";
import { downloadCSV, downloadXLSX, downloadImage, filterContextSheet } from "./downloads.js";
import { escapeHtml, fmtInt, fmtINR, fmtDelta, pctChange, toast , makeTableCollapsible, syncTableCollapseLabels, wireTableToggleAll } from "./util.js";
import {
  bucketKey, enumeratePeriods,
  lastIndexWithData, findPrevWithData, weightedAverage,
  pluralize, deltaPill, tsForFilename,
} from "./aggregate.js";

/* ---------------------------------------------------------------- *
 * Constants
 * ---------------------------------------------------------------- */
const METRICS = [
  { key: "page_views", label: "Page Views",  fmt: fmtInt, yFormat: "int",
    yTitle: "Page views" },
  { key: "units",      label: "Units Sold",  fmt: fmtInt, yFormat: "int",
    yTitle: "Units" },
  { key: "revenue",    label: "Revenue",     fmt: fmtINR, yFormat: "inr",
    yTitle: "Revenue (₹)" },
  { key: "spend",      label: "Spend",       fmt: fmtINR, yFormat: "inr",
    yTitle: "Spend (₹)" },
];

/* ---------------------------------------------------------------- *
 * Module-local state
 * ---------------------------------------------------------------- */
const LocalState = {
  range: { from: "", to: "" },
  gran: "weekly",
  platforms: [],
  level: "overall",       // 'overall' | 'category' | 'subcategory' | 'sku'
  dims: new Set(),        // multi-select dim values; empty set ↔ "all"
  filters: null,
  salesRows: null,        // populated on first lazy-load
  skuLookup: null,        // Map<nh_sku, short_code>
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
export async function renderBusinessTab() {
  const root = document.getElementById("content-business");
  if (!root || !State.data) return;

  if (!_built) {
    _built = true;
    buildSkeleton(root);
    buildFilters();
    LocalState.skuLookup = buildSkuLookup();
  }

  // Lazy-load sales.json the first time. 35 MB raw / ~2 MB on the wire.
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
          <button class="icon-btn" data-dl="img" data-metric="${m.key}">Image</button>
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

  const customBuilder = `
    <section class="section-card" id="bus-custom-builder">
      <header class="section-head">
        <h2 class="section-title">Custom Graph Builder
          <span class="section-meta" id="bus-custom-kpi"></span>
        </h2>
        <div class="section-actions">
          <span class="section-meta" id="bus-custom-meta"></span>
          <button class="icon-btn" data-dl="csv" data-metric="custom">CSV</button>
          <button class="icon-btn" data-dl="xlsx" data-metric="custom">Excel</button>
          <button class="icon-btn" data-dl="img" data-metric="custom">Image</button>
        </div>
      </header>
      <p class="section-meta" style="margin:-8px 0 14px;">
        Pick any combination of metrics and a time grain. Uses the Platforms filter above; always combined across all categories/SKUs.
      </p>
      <div class="filter-bar" id="bus-custom-filters" style="margin-bottom:16px;"></div>
      <div class="chart-box"><canvas id="bus-custom-canvas"></canvas></div>
      <div class="tbl-wrap is-scroll-y">
        <table class="data-tbl" id="bus-custom-tbl">
          <thead></thead>
          <tbody></tbody>
        </table>
      </div>
      <div class="empty-state" id="bus-custom-empty" hidden>Pick at least one metric above to plot.</div>
    </section>
  `;

  root.innerHTML = `
    <div id="bus-overlay" class="bus-overlay" hidden>
      <div class="boot-spinner" aria-hidden="true"></div>
      <p id="bus-overlay-msg" class="boot-msg">Loading…</p>
    </div>
    ${sections}
    ${customBuilder}
  `;

  // Wire download buttons (four metric cards + the custom builder card).
  root.querySelectorAll("[data-dl]").forEach(btn => {
    btn.addEventListener("click", () => {
      const metric = btn.dataset.metric;
      const kind = btn.dataset.dl;
      if (metric === "custom") { downloadCustom(kind); return; }
      if (kind === "img") { downloadMetricImage(metric); return; }
      downloadMetric(metric, kind);
    });
  });

  // Collapse all time-series breakdown tables by default (each section card has one).
  root.querySelectorAll(".section-card > .tbl-wrap").forEach(el => makeTableCollapsible(el));

  buildCustomBuilderFilters();
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
      { value: "daily", label: "Daily" },
      { value: "weekly", label: "Weekly" },
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
    defaultSelected: platformOptions.map(o => o.value),   // all
    allowAll: true,
  });
  bar.appendChild(platsF.el);

  const levelF = createSegmented({
    id: "business.level",
    label: "View level",
    options: [
      { value: "overall", label: "Overall" },
      { value: "category", label: "Category" },
      { value: "subcategory", label: "Sub-category" },
      { value: "sku", label: "SKU" },
    ],
    defaultValue: "overall",
  });
  bar.appendChild(levelF.el);

  // Dimension multi-select — built lazily when level !== overall.  The widget
  // is rebuilt when level changes so options map to the new field.
  const dimWrap = document.createElement("div");
  dimWrap.className = "fl-group";
  dimWrap.id = "business-dim-wrap";
  dimWrap.innerHTML = `<div class="fl-lbl" id="business-dim-label">Dimension</div><div id="business-dim-slot"></div>`;
  bar.appendChild(dimWrap);

  // "Show all tables / Hide all tables" toggle — appended at end of filter bar.
  const toggleBtn = document.createElement("button");
  toggleBtn.className = "fl-tbl-toggle";
  toggleBtn.textContent = "Show all tables";
  bar.appendChild(toggleBtn);
  wireTableToggleAll(toggleBtn, document.getElementById("content-business"));

  LocalState.filters = { dateF, granF, platsF, levelF };

  syncFromFilters();
  dateF.onChange(() => { syncFromFilters(); rerender(); });
  granF.onChange(() => { syncFromFilters(); rerender(); });
  platsF.onChange(() => { syncFromFilters(); rerender(); });
  levelF.onChange(() => {
    LocalState.dims = new Set();   // reset dim picks when changing level
    syncFromFilters();
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
 * SKU → short_code lookup, built from weekly_catalogue
 * ---------------------------------------------------------------- */
function buildSkuLookup() {
  const map = new Map();
  const rows = State.data.weekly_catalogue || [];
  for (const r of rows) {
    if (r.nh_sku && r.short_code && !map.has(r.nh_sku)) {
      map.set(r.nh_sku, r.short_code);
    }
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
  refreshDimensionFilter();
  const agg = computeAggregations();
  LocalState._agg = agg;
  for (const m of METRICS) renderMetricPanel(m, agg);
  renderCustomBuilder();
  // Update collapsed-table summary labels to reflect new row counts.
  syncTableCollapseLabels(document.getElementById("content-business"));
  // Active-filter chips above each table.
  renderChipsAcrossTab(document.getElementById("content-business"), buildChips());
}

/* ---------------------------------------------------------------- *
 * Active-filter chip spec
 * ---------------------------------------------------------------- */
function buildChips() {
  const chips = [];
  if (!LocalState.filters) return chips;
  const { dateF, granF, platsF, levelF } = LocalState.filters;

  const dateChip = buildDateChip(dateF);
  if (dateChip) chips.push(dateChip);

  // Granularity — default is Weekly.
  const granChip = buildSegmentChip(granF, "Granularity", "weekly",
    { daily: "Daily", weekly: "Weekly", monthly: "Monthly" });
  if (granChip) chips.push(granChip);

  // Platforms.
  const allPlats = (State.data?.metadata?.platforms || []);
  const platChip = buildMultiSelectChip(platsF, "Platforms",
    () => allPlats, { resetTo: allPlats });
  if (platChip) chips.push(platChip);

  // View level — default Overall. Chip lets the user reset back to Overall.
  const levelChip = buildSegmentChip(levelF, "View level", "overall",
    { overall: "Overall", category: "Category",
      subcategory: "Sub-category", sku: "SKU" });
  if (levelChip) chips.push(levelChip);

  // Dimension picks — only meaningful when level !== overall AND the user
  // has narrowed away from the full set.
  if (LocalState.level !== "overall" && _dimPicker) {
    const allDims = availableDimensions().map(d => d.value);
    const sel = _dimPicker.getSelected();
    const isAll = sel.length === 0 || sel.length === allDims.length;
    if (!isAll) {
      const labelMap = { category: "Category", subcategory: "Sub-category", sku: "SKU" };
      const prefix = labelMap[LocalState.level] || "Dimension";
      // For SKUs, use display names from skuDisplay() for readability.
      const display = LocalState.level === "sku"
        ? sel.map(skuDisplay)
        : sel;
      const shown = display.slice(0, 3).join(", ");
      const extra = display.length > 3 ? ` +${display.length - 3}` : "";
      chips.push({
        label: `${prefix}: ${shown}${extra}`,
        onClear: () => _dimPicker.setSelected?.(allDims),
      });
    }
  }

  return chips;
}

/**
 * Build (or rebuild) the dimension multi-select to match the current
 * view-level. When level === overall, hide the wrapper.
 */
let _dimPicker = null;
function refreshDimensionFilter() {
  const wrap = document.getElementById("business-dim-wrap");
  const slot = document.getElementById("business-dim-slot");
  const labelEl = document.getElementById("business-dim-label");
  if (LocalState.level === "overall") {
    wrap.style.display = "none";
    _dimPicker = null;
    LocalState.dims = new Set();
    return;
  }
  wrap.style.display = "";

  const labelMap = {
    category: "Category",
    subcategory: "Sub-category",
    sku: "SKU",
  };
  labelEl.textContent = labelMap[LocalState.level];

  const opts = availableDimensions();
  const optionList = opts.map(o => ({ value: o.value, label: o.display }));

  // Survivors from prior selection, if compatible with new options.
  const priorSelection = [...LocalState.dims];
  const optionValues = new Set(optionList.map(o => o.value));
  const survivors = priorSelection.filter(v => optionValues.has(v));

  slot.innerHTML = "";
  _dimPicker = createMultiSelect({
    id: `business.dim.${LocalState.level}`,    // persist per-level
    label: labelMap[LocalState.level],
    options: optionList,
    defaultSelected: survivors.length ? survivors : optionList.map(o => o.value),
    allowAll: true,
    searchable: true,
    placeholder: `All ${labelMap[LocalState.level].toLowerCase()}s (combined)`,
  });
  _dimPicker.el.querySelector(".fl-lbl")?.remove();
  slot.appendChild(_dimPicker.el);

  LocalState.dims = new Set(_dimPicker.getSelected());

  _dimPicker.onChange((vals) => {
    LocalState.dims = new Set(vals);
    const agg = computeAggregations();
    LocalState._agg = agg;
    for (const m of METRICS) renderMetricPanel(m, agg);
    syncTableCollapseLabels(document.getElementById("content-business"));
  });
}

/** Return options for the dimension dropdown based on current platform filter. */
function availableDimensions() {
  const platSet = new Set(LocalState.platforms);
  const sales = (LocalState.salesRows || []).filter(r => platSet.has(r.platform));
  const level = LocalState.level;
  if (level === "category") {
    const set = new Set(sales.map(r => r.category).filter(Boolean));
    return [...set].sort().map(v => ({ value: v, display: v }));
  }
  if (level === "subcategory") {
    const set = new Set(sales.map(r => r.subcategory).filter(Boolean));
    return [...set].sort().map(v => ({ value: v, display: v }));
  }
  if (level === "sku") {
    const set = new Set(sales.map(r => r.nh_sku).filter(Boolean));
    return [...set].sort()
      .map(sku => ({ value: sku, display: skuDisplay(sku) }));
  }
  return [];
}

/* ---------------------------------------------------------------- *
 * Aggregations
 *
 * Dim filter semantics: LocalState.dims is a Set of selected values for the
 * current level. Empty Set OR full coverage of available options means "all";
 * partial selection sums the picked dims together (OR-filter).
 *
 * Output:
 *   { periods: [{key, label, hasSales, hasSpend, page_views, units, revenue, spend}],
 *     spendAvailable: bool,
 *     totals: {page_views, units, revenue, spend} }
 * ---------------------------------------------------------------- */
function computeAggregations() {
  const { range, gran, platforms, level } = LocalState;
  const platSet = new Set(platforms);
  const spendAvailable = (level !== "sku");

  // Treat empty selection same as "all".
  const allDims = new Set(availableDimensions().map(d => d.value));
  const useAll = LocalState.dims.size === 0 || LocalState.dims.size === allDims.size;
  const dimSet = useAll ? null : LocalState.dims;

  const matchesDim = (r) => {
    if (!dimSet) return true;
    if (level === "category")    return dimSet.has(r.category);
    if (level === "subcategory") return dimSet.has(r.subcategory);
    if (level === "sku")         return dimSet.has(r.nh_sku);
    return true;
  };

  // Filter sales.
  const sales = (LocalState.salesRows || []).filter(r => {
    if (!platSet.has(r.platform)) return false;
    if (range.from && r.date < range.from) return false;
    if (range.to   && r.date > range.to)   return false;
    if (!matchesDim(r)) return false;
    return true;
  });

  // Filter spend (only if applicable to current level). BCG rows carry no
  // SKU, so spend can only filter to category/subcategory.
  const spendRows = spendAvailable ? (State.data.bcg_spend || []).filter(r => {
    if (!platSet.has(r.platform)) return false;
    if (range.from && r.date < range.from) return false;
    if (range.to   && r.date > range.to)   return false;
    if (dimSet) {
      if (level === "category"    && !dimSet.has(r.category))    return false;
      if (level === "subcategory" && !dimSet.has(r.subcategory)) return false;
    }
    return true;
  }) : [];

  // Enumerate periods in range, then bucket.
  const periodList = enumeratePeriods(range.from, range.to, gran);
  const periodMap = new Map(periodList.map(p => [p.key, {
    key: p.key, label: p.label,
    page_views: null, units: null, revenue: null, spend: null,
    hasSales: false, hasSpend: false,
  }]));

  for (const r of sales) {
    const key = bucketKey(r.date, gran);
    const e = periodMap.get(key);
    if (!e) continue;            // row outside enumerated range (shouldn't happen)
    if (!e.hasSales) {
      e.page_views = 0; e.units = 0; e.revenue = 0;
      e.hasSales = true;
    }
    e.page_views += +r.glance_views || 0;
    e.units      += +r.gross_units  || 0;
    e.revenue    += +r.revenue      || 0;
  }
  for (const r of spendRows) {
    const key = bucketKey(r.date, gran);
    const e = periodMap.get(key);
    if (!e) continue;
    if (!e.hasSpend) { e.spend = 0; e.hasSpend = true; }
    e.spend += +r.spend || 0;
  }

  const periods = periodList.map(p => periodMap.get(p.key));

  // Totals for the visible window.
  const totals = { page_views: 0, units: 0, revenue: 0, spend: 0 };
  for (const p of periods) {
    if (p.hasSales) {
      totals.page_views += p.page_views;
      totals.units      += p.units;
      totals.revenue    += p.revenue;
    }
    if (p.hasSpend) totals.spend += p.spend;
  }

  return { periods, spendAvailable, totals };
}

/* ---------------------------------------------------------------- *
 * Per-metric panel render
 * ---------------------------------------------------------------- */
function renderMetricPanel(metric, agg) {
  const section = document.querySelector(`.section-card[data-metric="${metric.key}"]`);
  const canvas = document.getElementById(`bus-${metric.key}-canvas`);
  const thead = document.querySelector(`#bus-${metric.key}-tbl thead`);
  const tbody = document.querySelector(`#bus-${metric.key}-tbl tbody`);
  const empty = document.getElementById(`bus-${metric.key}-empty`);
  const kpiEl = document.getElementById(`bus-${metric.key}-kpi`);
  const metaEl = document.getElementById(`bus-${metric.key}-meta`);

  // SPEND at SKU level: replace with N/A card.
  if (metric.key === "spend" && !agg.spendAvailable) {
    destroyChart(canvas);
    canvas.parentElement.style.display = "none";
    section.querySelector(".tbl-wrap").style.display = "none";
    empty.hidden = false;
    empty.innerHTML = `
      <strong>Not available at SKU level.</strong><br>
      Spend in BCG Data is recorded at category or sub-category granularity, not per SKU.
      Switch to a higher view level to see spend.
    `;
    kpiEl.textContent = "";
    metaEl.textContent = "";
    section.querySelectorAll('[data-dl]').forEach(b => b.disabled = true);
    return;
  } else {
    canvas.parentElement.style.display = "";
    section.querySelector(".tbl-wrap").style.display = "";
    empty.hidden = true;
    section.querySelectorAll('[data-dl]').forEach(b => b.disabled = false);
  }

  const periods = agg.periods;
  // Series with nulls for periods that contributed no rows.
  const values = periods.map(p => {
    if (metric.key === "spend") return p.hasSpend ? p.spend : null;
    return p.hasSales ? p[metric.key] : null;
  });
  const labels = periods.map(p => p.label);

  // Headline = weighted average across the whole selected range, not just
  // the latest period. These are all sum-per-period metrics, so the weight
  // is 1 per period (a straight average-per-period); see aggregate.js.
  const rangeAvg = weightedAverage(values);
  // Still show a trend arrow: average of the first half of the range vs the
  // second half, so the headline retains a sense of direction.
  const mid = Math.ceil(values.length / 2);
  const firstHalfAvg = weightedAverage(values.slice(0, mid));
  const secondHalfAvg = weightedAverage(values.slice(mid));
  const delta = pctChange(secondHalfAvg, firstHalfAvg);

  if (rangeAvg == null) {
    kpiEl.innerHTML = `<span style="color:var(--brand-muted-2)">No data in range</span>`;
  } else {
    const periodName = ({daily:"day", weekly:"week", monthly:"month"})[LocalState.gran] || "period";
    const deltaPart = delta == null
      ? ""
      : `<span class="${delta > 0 ? "delta-up" : (delta < 0 ? "delta-down" : "")}" style="margin-left:8px;">${
            delta > 0 ? "▲" : (delta < 0 ? "▼" : "→")} ${Math.abs(delta).toFixed(1)}%</span>`;
    kpiEl.innerHTML = `<span class="kpi-val">${metric.fmt(rangeAvg)}</span> <span style="color:var(--brand-muted); font-size:var(--fs-sm); margin-left:4px;">avg/${periodName}</span>${deltaPart}`;
  }
  metaEl.textContent = `${periods.length} ${pluralize(LocalState.gran, periods.length)}`;

  // Chart
  renderLineChart(canvas, {
    labels,
    series: [{ label: metric.label, data: values }],
    yFormat: metric.yFormat,
    yTitle: metric.yTitle,
  });

  // Table: newest first, with Δ% vs immediately-previous period.
  let head = `<tr><th>Period</th><th class="num">${escapeHtml(metric.label)}</th><th class="num">Δ vs prev</th></tr>`;
  thead.innerHTML = head;

  const rowsHTML = [];
  for (let i = periods.length - 1; i >= 0; i--) {
    const p = periods[i];
    const v = values[i];
    const prev = i > 0 ? values[i - 1] : null;
    const dlt = pctChange(v, prev);
    const vCell = v == null ? "—" : metric.fmt(v);
    const dCell = dlt == null
      ? `<span class="pill pill--flat">—</span>`
      : deltaPill(dlt);
    rowsHTML.push(`<tr><td><strong>${escapeHtml(p.label)}</strong></td><td class="num mono">${vCell}</td><td class="num">${dCell}</td></tr>`);
  }
  tbody.innerHTML = rowsHTML.join("") || `<tr><td colspan="3" class="empty-state">No periods in range.</td></tr>`;
}

function ts() { return tsForFilename(); }

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
  const dims = [...(LocalState.dims || [])];
  const allDims = new Set(availableDimensions().map(d => d.value));
  const useAll = dims.length === 0 || dims.length === allDims.size;
  // For SKU level, expand each SKU code to its human display string.
  const dimDisplay = LocalState.level === "sku"
    ? dims.map(skuDisplay)
    : dims;
  return {
    "Tab": "Business",
    "Granularity": LocalState.gran,
    "Date range": `${LocalState.range.from || "—"} to ${LocalState.range.to || "—"}`,
    "Platforms": LocalState.platforms,
    "View level": LocalState.level,
    "Dimension": (LocalState.level === "overall" || useAll) ? "All combined" : dimDisplay,
    "Generated at": new Date().toISOString(),
  };
}

function downloadMetricImage(metricKey) {
  const canvas = document.getElementById(`bus-${metricKey}-canvas`);
  const dataUrl = canvas && exportChartImage(canvas);
  if (!dataUrl) { toast("Chart isn't ready to export yet."); return; }
  downloadImage(`nat-habit_business-${metricKey}_${ts()}.png`, dataUrl);
}

function downloadMetric(metricKey, kind) {
  const metric = METRICS.find(m => m.key === metricKey);
  const agg = LocalState._agg;
  if (!metric || !agg) return;
  if (metric.key === "spend" && !agg.spendAvailable) {
    toast("Spend isn't available at SKU level.");
    return;
  }
  const cols = [
    { key: "period", label: "Period" },
    { key: "value",  label: metric.label },
    { key: "delta",  label: "Δ vs prev (%)" },
  ];
  const values = agg.periods.map(p => p[metric.key]);
  const rows = [];
  for (let i = agg.periods.length - 1; i >= 0; i--) {
    const p = agg.periods[i];
    const v = values[i];
    const prev = i > 0 ? values[i - 1] : null;
    const dlt = pctChange(v, prev);
    rows.push({
      period: p.label,
      value: v == null ? "" : v,
      delta: dlt == null ? "" : Number(dlt.toFixed(2)),
    });
  }
  if (!rows.length) { toast("Nothing to download."); return; }
  const fname = `nat-habit_business-${metric.key.replace("_", "-")}_${ts()}`;
  if (kind === "csv") {
    downloadCSV(`${fname}.csv`, cols, rows);
    return;
  }
  downloadXLSX(`${fname}.xlsx`, [
    { name: metric.label, columns: cols, rows },
    rawRowsSheet(metric.key),
    filterContextSheet("Filter context", describeContext()),
  ]);
}

function rawRowsSheet(metricKey) {
  const platSet = new Set(LocalState.platforms);
  const { range, level } = LocalState;
  // Same multi-select dim semantics as computeAggregations.
  const allDims = new Set(availableDimensions().map(d => d.value));
  const useAll = LocalState.dims.size === 0 || LocalState.dims.size === allDims.size;
  const dimSet = useAll ? null : LocalState.dims;

  if (metricKey === "spend") {
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
      (!dimSet || (
        (level === "category"    && dimSet.has(r.category))    ||
        (level === "subcategory" && dimSet.has(r.subcategory))
      )));
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
    (!range.from || r.date >= range.from) &&
    (!range.to   || r.date <= range.to) &&
    (!dimSet || (
      (level === "category"    && dimSet.has(r.category))    ||
      (level === "subcategory" && dimSet.has(r.subcategory)) ||
      (level === "sku"         && dimSet.has(r.nh_sku))
    )));
  return { name: "Filtered sales rows", columns: cols, rows };
}

/* ================================================================== *
 * Custom Graph Builder
 *
 * A self-contained mini-tool at the bottom of the Business tab: pick any
 * combination of the four Business metrics, a time grain, and a date range,
 * and see them plotted together. Always combined across all
 * categories/SKUs (Overall level) — it respects the tab's Platforms filter
 * so it stays consistent with everything above it, but doesn't try to
 * replicate the dimension-slicing UI for simplicity.
 *
 * Metrics with different units get a second (right-hand) y-axis — Page
 * Views + Units share the "int" axis, Revenue + Spend share the "inr" axis.
 * ================================================================== */
const CustomBuilder = {
  range: { from: "", to: "" },
  gran: "weekly",
  metrics: ["revenue", "units"],   // sensible default pairing
  filters: null,
  _agg: null,
};

function buildCustomBuilderFilters() {
  const bar = document.getElementById("bus-custom-filters");
  if (!bar) return;
  bar.innerHTML = "";

  const md = State.data.metadata;
  const dr = md.date_range || {};

  const dateF = createDateRange({
    id: "business.custom.range",
    minDate: dr.min,
    maxDate: dr.max,
    defaultDays: 90,
  });
  bar.appendChild(dateF.el);

  const granF = createSegmented({
    id: "business.custom.gran",
    label: "Granularity",
    options: [
      { value: "daily", label: "Daily" },
      { value: "weekly", label: "Weekly" },
      { value: "monthly", label: "Monthly" },
    ],
    defaultValue: "weekly",
  });
  bar.appendChild(granF.el);

  const metricOptions = METRICS.map(m => ({ value: m.key, label: m.label }));
  const metricsF = createMultiSelect({
    id: "business.custom.metrics",
    label: "Metrics",
    options: metricOptions,
    defaultSelected: CustomBuilder.metrics,
    allowAll: false,
  });
  bar.appendChild(metricsF.el);

  CustomBuilder.filters = { dateF, granF, metricsF };

  const sync = () => {
    CustomBuilder.range = dateF.getRange();
    CustomBuilder.gran = granF.getValue();
    CustomBuilder.metrics = metricsF.getSelected();
  };
  sync();
  dateF.onChange(() => { sync(); renderCustomBuilder(); });
  granF.onChange(() => { sync(); renderCustomBuilder(); });
  metricsF.onChange(() => { sync(); renderCustomBuilder(); });
}

function computeCustomAggregation() {
  const { range, gran, metrics } = CustomBuilder;
  const platSet = new Set(LocalState.platforms);
  const wantsSpend = metrics.includes("spend");
  const wantsSales = metrics.some(m => m !== "spend");

  const periodList = enumeratePeriods(range.from, range.to, gran);
  const periodMap = new Map(periodList.map(p => [p.key, {
    key: p.key, label: p.label,
    page_views: null, units: null, revenue: null, spend: null,
    hasSales: false, hasSpend: false,
  }]));

  if (wantsSales) {
    for (const r of (LocalState.salesRows || [])) {
      if (!platSet.has(r.platform)) continue;
      if (range.from && r.date < range.from) continue;
      if (range.to   && r.date > range.to)   continue;
      const e = periodMap.get(bucketKey(r.date, gran));
      if (!e) continue;
      if (!e.hasSales) { e.page_views = 0; e.units = 0; e.revenue = 0; e.hasSales = true; }
      e.page_views += +r.glance_views || 0;
      e.units      += +r.gross_units  || 0;
      e.revenue    += +r.revenue      || 0;
    }
  }
  if (wantsSpend) {
    for (const r of (State.data.bcg_spend || [])) {
      if (!platSet.has(r.platform)) continue;
      if (range.from && r.date < range.from) continue;
      if (range.to   && r.date > range.to)   continue;
      const e = periodMap.get(bucketKey(r.date, gran));
      if (!e) continue;
      if (!e.hasSpend) { e.spend = 0; e.hasSpend = true; }
      e.spend += +r.spend || 0;
    }
  }

  return { periods: periodList.map(p => periodMap.get(p.key)) };
}

function renderCustomBuilder() {
  if (!LocalState.salesRows) return;   // sales.json not loaded yet
  const agg = computeCustomAggregation();
  CustomBuilder._agg = agg;

  const canvas = document.getElementById("bus-custom-canvas");
  const thead = document.querySelector("#bus-custom-tbl thead");
  const tbody = document.querySelector("#bus-custom-tbl tbody");
  const empty = document.getElementById("bus-custom-empty");
  const kpiEl = document.getElementById("bus-custom-kpi");
  const metaEl = document.getElementById("bus-custom-meta");
  const wrap = document.querySelector("#bus-custom-builder .chart-box");
  const tblWrap = document.querySelector("#bus-custom-builder .tbl-wrap");

  const selectedMetrics = METRICS.filter(m => CustomBuilder.metrics.includes(m.key));
  if (!selectedMetrics.length) {
    destroyChart(canvas);
    wrap.style.display = "none";
    tblWrap.style.display = "none";
    empty.hidden = false;
    kpiEl.textContent = "";
    metaEl.textContent = "";
    return;
  }
  wrap.style.display = "";
  tblWrap.style.display = "";
  empty.hidden = true;

  const labels = agg.periods.map(p => p.label);
  const series = selectedMetrics.map(m => ({
    label: m.label,
    yFormat: m.yFormat,
    data: agg.periods.map(p => {
      if (m.key === "spend") return p.hasSpend ? p.spend : null;
      return p.hasSales ? p[m.key] : null;
    }),
  }));

  renderCustomChart(canvas, { labels, series });

  const periodName = ({daily:"day", weekly:"week", monthly:"month"})[CustomBuilder.gran] || "period";
  kpiEl.textContent = `${selectedMetrics.length} metric${selectedMetrics.length === 1 ? "" : "s"}`;
  metaEl.textContent = `${agg.periods.length} ${pluralize(CustomBuilder.gran, agg.periods.length)}`;

  // Table: one row per period, one column pair per selected metric.
  let head = `<tr><th>Period</th>`;
  for (const m of selectedMetrics) head += `<th class="num">${escapeHtml(m.label)}</th>`;
  head += `</tr>`;
  thead.innerHTML = head;

  const rowsHTML = [];
  for (let i = agg.periods.length - 1; i >= 0; i--) {
    const p = agg.periods[i];
    let row = `<tr><td><strong>${escapeHtml(p.label)}</strong></td>`;
    for (const m of selectedMetrics) {
      const v = m.key === "spend" ? (p.hasSpend ? p.spend : null) : (p.hasSales ? p[m.key] : null);
      row += `<td class="num mono">${v == null ? "—" : m.fmt(v)}</td>`;
    }
    row += `</tr>`;
    rowsHTML.push(row);
  }
  tbody.innerHTML = rowsHTML.join("") || `<tr><td colspan="${selectedMetrics.length + 1}" class="empty-state">No periods in range.</td></tr>`;
}

/**
 * Multi-metric, dual-axis line chart for the custom builder. Metrics with
 * yFormat "int" (Page Views, Units) share the left axis; "inr" metrics
 * (Revenue, Spend) get their own right-hand axis so scales don't collide.
 */
function renderCustomChart(canvas, { labels, series }) {
  destroyChart(canvas);
  if (typeof window.Chart === "undefined") return null;

  const formatsUsed = [...new Set(series.map(s => s.yFormat))];
  const axisFor = new Map(formatsUsed.map((f, i) => [f, i === 0 ? "y" : "y1"]));
  const axisTitle = { int: "Count", inr: "₹" };

  const tick = (fmt) => (v) => {
    const abs = Math.abs(v);
    const prefix = fmt === "inr" ? "₹" : "";
    if (abs >= 1e7) return `${prefix}${(v / 1e7).toFixed(1)}Cr`;
    if (abs >= 1e5) return `${prefix}${(v / 1e5).toFixed(1)}L`;
    if (abs >= 1000) return `${prefix}${(v / 1000).toFixed(1)}K`;
    return `${prefix}${Number(v).toLocaleString("en-IN")}`;
  };
  const valueFn = (fmt) => (v) => v == null ? "—" : (fmt === "inr" ? fmtINR(v) : fmtInt(v));

  const datasets = series.map((s, i) => {
    const color = PALETTE[i % PALETTE.length];
    return {
      label: s.label,
      data: s.data,
      borderColor: color,
      backgroundColor: color + "22",
      borderWidth: 2.2,
      tension: 0.3,
      pointRadius: 3,
      pointHoverRadius: 5,
      pointBackgroundColor: color,
      pointBorderColor: color,
      fill: false,
      spanGaps: true,
      yAxisID: axisFor.get(s.yFormat),
    };
  });

  const scales = {
    x: {
      grid: { display: false },
      ticks: { maxRotation: 0, autoSkip: true, autoSkipPadding: 12, font: { size: 11 } },
    },
    y: {
      position: "left",
      beginAtZero: true,
      grid: { color: "rgba(31,42,34,0.06)" },
      ticks: { font: { size: 11 }, callback: tick(formatsUsed[0]) },
      title: { display: true, text: axisTitle[formatsUsed[0]] || "", font: { size: 11, weight: 600 }, color: "#7A7268" },
    },
  };
  if (formatsUsed[1]) {
    scales.y1 = {
      position: "right",
      beginAtZero: true,
      grid: { drawOnChartArea: false },
      ticks: { font: { size: 11 }, callback: tick(formatsUsed[1]) },
      title: { display: true, text: axisTitle[formatsUsed[1]] || "", font: { size: 11, weight: 600 }, color: "#7A7268" },
    };
  }

  return new Chart(canvas, {
    type: "line",
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: {
          position: "top", align: "end",
          labels: { boxWidth: 8, boxHeight: 8, padding: 14, font: { size: 12, weight: 600 }, usePointStyle: true },
        },
        tooltip: {
          backgroundColor: "rgba(31,42,34,0.95)",
          titleColor: "#fff", bodyColor: "#fff",
          padding: 10, cornerRadius: 8, displayColors: true,
          boxPadding: 4, boxWidth: 6, boxHeight: 6,
          callbacks: {
            label(ctx) {
              const s = series[ctx.datasetIndex];
              const v = ctx.parsed.y;
              return `${ctx.dataset.label}: ${valueFn(s.yFormat)(v)}`;
            },
          },
        },
      },
      scales,
    },
  });
}

function describeCustomContext() {
  return {
    "Tab": "Business — Custom Graph Builder",
    "Granularity": CustomBuilder.gran,
    "Date range": `${CustomBuilder.range.from || "—"} to ${CustomBuilder.range.to || "—"}`,
    "Platforms": LocalState.platforms,
    "Metrics": CustomBuilder.metrics,
    "Generated at": new Date().toISOString(),
  };
}

function downloadCustom(kind) {
  const agg = CustomBuilder._agg;
  const selectedMetrics = METRICS.filter(m => CustomBuilder.metrics.includes(m.key));
  if (!agg || !selectedMetrics.length || !agg.periods.length) {
    toast("Nothing to download — pick at least one metric.");
    return;
  }
  if (kind === "img") {
    const canvas = document.getElementById("bus-custom-canvas");
    const dataUrl = canvas && exportChartImage(canvas);
    if (!dataUrl) { toast("Chart isn't ready to export yet."); return; }
    downloadImage(`nat-habit_business-custom_${ts()}.png`, dataUrl);
    return;
  }

  const cols = [{ key: "period", label: "Period" }];
  for (const m of selectedMetrics) cols.push({ key: m.key, label: m.label });
  const rows = agg.periods.map(p => {
    const row = { period: p.label };
    for (const m of selectedMetrics) {
      const v = m.key === "spend" ? (p.hasSpend ? p.spend : null) : (p.hasSales ? p[m.key] : null);
      row[m.key] = v == null ? "" : v;
    }
    return row;
  }).reverse();

  const fname = `nat-habit_business-custom_${ts()}`;
  if (kind === "csv") { downloadCSV(`${fname}.csv`, cols, rows); return; }
  downloadXLSX(`${fname}.xlsx`, [
    { name: "Custom graph", columns: cols, rows },
    filterContextSheet("Filter context", describeCustomContext()),
  ]);
}
