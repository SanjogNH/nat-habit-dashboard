/**
 * tab-impressions.js — Impressions & Brand Share tab.
 *
 * Spec §5.2. Weekly granularity only.
 *
 * Section A — Keyword level (weekly_sfr):
 *   1. Total Impressions   (Σ impressions across filtered rows)
 *   2. Brand Impression Share %  (weighted by impressions)
 *   3. Total Clicks
 *   4. Brand Click Share %       (weighted by clicks)
 *
 * Section B — SKU level (weekly_catalogue):
 *   - Multi-line chart of SKU impressions over weeks for selected SKUs.
 *
 * Brand share % is computed as Σ(impressions × brand_impression_share_pct/100)
 * divided by Σ(impressions) × 100 — i.e., a true weighted average across the
 * period, not the simple mean of percentages.
 */

import { State } from "./dashboard.js";
import { createDateRange, createMultiSelect, createSegmented } from "./filters.js";
import { renderLineChart, destroyChart, PALETTE } from "./charts.js";
import { downloadCSV, downloadXLSX, filterContextSheet } from "./downloads.js";
import { escapeHtml, fmtInt, pctChange, toast } from "./util.js";
import {
  pluralize, deltaPill, tsForFilename,
} from "./aggregate.js";

/* ---------------------------------------------------------------- *
 * Metric definitions for the four keyword-level cards
 * ---------------------------------------------------------------- */
const KW_METRICS = [
  {
    key: "impressions",
    label: "Total Impressions",
    fmt: fmtInt,
    yFormat: "int",
    yTitle: "Impressions",
    derive: (row) => row.impressions || 0,
  },
  {
    key: "brand_imp_share",
    label: "Brand Impression Share",
    fmt: (v) => v == null ? "—" : `${v.toFixed(2)}%`,
    yFormat: "pct",
    yTitle: "Brand impression share (%)",
    derive: null,   // computed at aggregation time as weighted avg
  },
  {
    key: "clicks",
    label: "Total Clicks",
    fmt: fmtInt,
    yFormat: "int",
    yTitle: "Clicks",
    derive: (row) => row.clicks || 0,
  },
  {
    key: "brand_click_share",
    label: "Brand Click Share",
    fmt: (v) => v == null ? "—" : `${v.toFixed(2)}%`,
    yFormat: "pct",
    yTitle: "Brand click share (%)",
    derive: null,
  },
];

const SKU_TOP_N = 10;
const SHORT_CODE_DISPLAY_LEN = 48;

/* ---------------------------------------------------------------- *
 * Module-local state
 * ---------------------------------------------------------------- */
const LocalState = {
  range: { from: "", to: "" },
  platforms: [],
  branded: "both",
  categories: [],
  subcategories: [],
  selectedSkus: [],     // user override; empty = default to top 10
  filters: null,
  _aggKw: null,
  _aggSku: null,
  skuLookup: null,      // Map<nh_sku, short_code>
};

let _built = false;

/** Reset module state (called by Live Refresh to force a rebuild). */
export function reset() {
  _built = false;
}

/* ---------------------------------------------------------------- *
 * Public entry
 * ---------------------------------------------------------------- */
export function renderImpressionsTab() {
  const root = document.getElementById("content-impressions");
  if (!root || !State.data) return;
  if (!_built) {
    _built = true;
    LocalState.skuLookup = buildSkuLookup();
    buildSkeleton(root);
    buildFilters();
  }
  rerender();
}

/* ---------------------------------------------------------------- *
 * Skeleton
 * ---------------------------------------------------------------- */
function buildSkeleton(root) {
  const kwCards = KW_METRICS.map(m => `
    <section class="section-card" data-metric="${m.key}">
      <header class="section-head">
        <h2 class="section-title">${m.label}
          <span class="section-meta" id="imp-${m.key}-kpi"></span>
        </h2>
        <div class="section-actions">
          <span class="section-meta" id="imp-${m.key}-meta"></span>
          <button class="icon-btn" data-dl="csv" data-metric="${m.key}">CSV</button>
          <button class="icon-btn" data-dl="xlsx" data-metric="${m.key}">Excel</button>
        </div>
      </header>
      <div class="chart-box"><canvas id="imp-${m.key}-canvas"></canvas></div>
      <div class="tbl-wrap is-scroll-y">
        <table class="data-tbl" id="imp-${m.key}-tbl">
          <thead></thead><tbody></tbody>
        </table>
      </div>
    </section>
  `).join("");

  root.innerHTML = `
    <h3 class="tab-section-head">Keyword level</h3>
    ${kwCards}

    <h3 class="tab-section-head">SKU level</h3>
    <section class="section-card" data-metric="sku">
      <header class="section-head">
        <h2 class="section-title">SKU Impressions
          <span class="section-meta" id="imp-sku-kpi"></span>
        </h2>
        <div class="keyword-pickline">
          <span class="section-meta">SKUs:</span>
          <span id="imp-sku-picker-slot"></span>
          <span class="section-actions">
            <button class="icon-btn" data-dl="csv" data-metric="sku">CSV</button>
            <button class="icon-btn" data-dl="xlsx" data-metric="sku">Excel</button>
          </span>
        </div>
      </header>
      <div class="chart-box is-tall"><canvas id="imp-sku-canvas"></canvas></div>
      <div class="tbl-wrap is-scroll-y">
        <table class="data-tbl" id="imp-sku-tbl">
          <thead></thead><tbody></tbody>
        </table>
      </div>
    </section>
  `;

  root.querySelectorAll("[data-dl]").forEach(btn => {
    btn.addEventListener("click", () => {
      downloadMetric(btn.dataset.metric, btn.dataset.dl);
    });
  });
}

/* ---------------------------------------------------------------- *
 * Filter bar
 * ---------------------------------------------------------------- */
function buildFilters() {
  const bar = document.getElementById("filters-impressions");
  if (!bar) return;
  bar.innerHTML = "";

  const md = State.data.metadata;
  const dr = md.date_range || {};

  const dateF = createDateRange({
    id: "imp.range",
    minDate: dr.min,
    maxDate: dr.max,
    defaultDays: 90,
  });
  bar.appendChild(dateF.el);

  // Platforms — only those present in weekly_sfr or weekly_catalogue.
  const impPlatforms = new Set();
  for (const r of State.data.weekly_sfr || []) impPlatforms.add(r.platform);
  for (const r of State.data.weekly_catalogue || []) impPlatforms.add(r.platform);
  const platformOptions = [...impPlatforms].filter(Boolean).sort()
    .map(p => ({ value: p, label: p }));
  const platsF = createMultiSelect({
    id: "imp.platforms",
    label: "Platforms",
    options: platformOptions,
    defaultSelected: platformOptions.map(o => o.value),
    allowAll: true,
  });
  bar.appendChild(platsF.el);

  const brandedF = createSegmented({
    id: "imp.branded",
    label: "Keyword type",
    options: [
      { value: "both",    label: "Both" },
      { value: "branded", label: "Branded" },
      { value: "generic", label: "Generic" },
    ],
    defaultValue: "both",
  });
  bar.appendChild(brandedF.el);

  // Category — from union of weekly_sfr + weekly_catalogue.
  const catSet = new Set();
  for (const r of State.data.weekly_sfr || [])       if (r.category) catSet.add(r.category);
  for (const r of State.data.weekly_catalogue || []) if (r.category) catSet.add(r.category);
  const catOptions = [...catSet].sort().map(c => ({ value: c, label: c }));
  const catsF = createMultiSelect({
    id: "imp.categories",
    label: "Categories",
    options: catOptions,
    defaultSelected: catOptions.map(o => o.value),
    allowAll: true,
  });
  bar.appendChild(catsF.el);

  // Subcategory — initial set is all; will refresh on category change.
  const subF = createMultiSelect({
    id: "imp.subcategories",
    label: "Sub-categories",
    options: collectSubcategoryOptions(catsF.getSelected()),
    defaultSelected: null,    // null = all by default in createMultiSelect
    allowAll: true,
  });
  bar.appendChild(subF.el);

  LocalState.filters = { dateF, platsF, brandedF, catsF, subF };

  syncFromFilters();
  dateF.onChange(() => { syncFromFilters(); rerender(); });
  platsF.onChange(() => { syncFromFilters(); refreshSubcategoryOptions(); rerender(); });
  brandedF.onChange(() => { syncFromFilters(); rerender(); });
  catsF.onChange(() => { syncFromFilters(); refreshSubcategoryOptions(); rerender(); });
  subF.onChange(() => { syncFromFilters(); rerender(); });
}

function syncFromFilters() {
  const { dateF, platsF, brandedF, catsF, subF } = LocalState.filters;
  LocalState.range = dateF.getRange();
  LocalState.platforms = platsF.getSelected();
  LocalState.branded = brandedF.getValue();
  LocalState.categories = catsF.getSelected();
  LocalState.subcategories = subF.getSelected();
}

/**
 * Build subcategory option list based on currently-selected categories.
 * Cascading filter — picking categories narrows the subcategory list.
 */
function collectSubcategoryOptions(selectedCats) {
  const catSet = new Set(selectedCats);
  const subSet = new Set();
  const addIfCatMatches = (r) => {
    if (!r.subcategory) return;
    if (catSet.size && !catSet.has(r.category)) return;
    subSet.add(r.subcategory);
  };
  for (const r of State.data.weekly_sfr || [])       addIfCatMatches(r);
  for (const r of State.data.weekly_catalogue || []) addIfCatMatches(r);
  return [...subSet].sort().map(s => ({ value: s, label: s }));
}

function refreshSubcategoryOptions() {
  // We rebuild the subcategory multi-select in-place by simulating a new
  // option set. createMultiSelect doesn't expose setOptions, so swap the
  // whole widget for simplicity.
  const { subF } = LocalState.filters;
  const newOpts = collectSubcategoryOptions(LocalState.categories);
  // Replace the subF widget entirely so saved selections clamp to valid.
  const parent = subF.el.parentElement;
  const placeholderIdx = Array.from(parent.children).indexOf(subF.el);
  const newSubF = createMultiSelect({
    id: "imp.subcategories",
    label: "Sub-categories",
    options: newOpts,
    defaultSelected: null,
    allowAll: true,
  });
  parent.replaceChild(newSubF.el, subF.el);
  LocalState.filters.subF = newSubF;
  newSubF.onChange(() => { syncFromFilters(); rerender(); });
  LocalState.subcategories = newSubF.getSelected();
}

/* ---------------------------------------------------------------- *
 * SKU lookup (for display labels)
 * ---------------------------------------------------------------- */
function buildSkuLookup() {
  const map = new Map();
  for (const r of State.data.weekly_catalogue || []) {
    if (r.nh_sku && r.short_code && !map.has(r.nh_sku)) {
      map.set(r.nh_sku, r.short_code);
    }
  }
  return map;
}

function skuShort(sku) {
  const sc = LocalState.skuLookup?.get(sku) || "";
  if (!sc) return sku;
  const trimmed = sc.length > SHORT_CODE_DISPLAY_LEN
    ? sc.slice(0, SHORT_CODE_DISPLAY_LEN - 1) + "…"
    : sc;
  return `${trimmed} (${sku})`;
}

/* ---------------------------------------------------------------- *
 * Aggregation
 * ---------------------------------------------------------------- */

/** Convert a row's week_num to a period key/label using metadata.weeks. */
function weekMetaByNum() {
  const map = new Map();
  for (const w of State.data.weeks || []) map.set(w.week_num, w);
  return map;
}

/**
 * Determine eligible weeks: those fully inside the selected date range.
 * Returns a sorted array of week metadata objects.
 */
function eligibleWeeks() {
  const weeks = State.data.weeks || [];
  const { from, to } = LocalState.range;
  return weeks.filter(w => {
    if (from && w.start < from) return false;
    if (to   && w.end   > to)   return false;
    return true;
  });
}

/* ===== Keyword aggregation ===== */
function computeKeywordAggregations() {
  const weeks = eligibleWeeks();
  const wNumSet = new Set(weeks.map(w => w.week_num));
  const platSet = new Set(LocalState.platforms);
  const catSet = new Set(LocalState.categories);
  const subSet = new Set(LocalState.subcategories);
  const branded = LocalState.branded;

  const rows = (State.data.weekly_sfr || []).filter(r => {
    if (!platSet.has(r.platform)) return false;
    if (!wNumSet.has(r.week_num)) return false;
    if (catSet.size && !catSet.has(r.category)) return false;
    if (subSet.size && !subSet.has(r.subcategory)) return false;
    if (branded === "branded" && r.branded_bucket !== "Branded") return false;
    if (branded === "generic" && r.branded_bucket === "Branded") return false;
    return true;
  });

  // For each week, sum impressions, brand impressions, clicks, brand clicks.
  const byWeek = new Map();
  for (const w of weeks) {
    byWeek.set(w.week_num, {
      week: w,
      imp_sum: 0, imp_brand_sum: 0,
      click_sum: 0, click_brand_sum: 0,
      hasData: false,
    });
  }
  for (const r of rows) {
    const e = byWeek.get(r.week_num);
    if (!e) continue;
    const imp = +r.impressions || 0;
    const brandImpPct = +r.brand_impression_share_pct || 0;
    const click = +r.clicks || 0;
    const brandClickPct = +r.brand_click_share_pct || 0;
    e.imp_sum += imp;
    e.imp_brand_sum += imp * (brandImpPct / 100);
    e.click_sum += click;
    e.click_brand_sum += click * (brandClickPct / 100);
    e.hasData = true;
  }

  // Derive per-week values for each metric.
  const periods = weeks.map(w => {
    const e = byWeek.get(w.week_num);
    return {
      key: `W${w.week_num}`,
      label: w.label,
      range_display: w.range_display,
      hasData: e.hasData,
      impressions:       e.hasData ? e.imp_sum : null,
      brand_imp_share:   e.hasData && e.imp_sum > 0
                         ? (e.imp_brand_sum / e.imp_sum) * 100 : null,
      clicks:            e.hasData ? e.click_sum : null,
      brand_click_share: e.hasData && e.click_sum > 0
                         ? (e.click_brand_sum / e.click_sum) * 100 : null,
    };
  });

  return { periods, rawRowCount: rows.length };
}

/* ===== SKU aggregation ===== */
function computeSkuAggregations() {
  const weeks = eligibleWeeks();
  const wNumSet = new Set(weeks.map(w => w.week_num));
  const platSet = new Set(LocalState.platforms);
  const catSet = new Set(LocalState.categories);
  const subSet = new Set(LocalState.subcategories);

  const rows = (State.data.weekly_catalogue || []).filter(r => {
    if (!platSet.has(r.platform)) return false;
    if (!wNumSet.has(r.week_num)) return false;
    if (catSet.size && !catSet.has(r.category)) return false;
    if (subSet.size && !subSet.has(r.subcategory)) return false;
    return true;
  });

  // Aggregate per (sku, week_num) — sum impressions across platforms.
  const skuTotals = new Map();           // sku -> total impressions across range
  const bySku = new Map();               // sku -> Map<week_num, impressions>
  for (const r of rows) {
    let perWeek = bySku.get(r.nh_sku);
    if (!perWeek) { perWeek = new Map(); bySku.set(r.nh_sku, perWeek); }
    perWeek.set(r.week_num, (perWeek.get(r.week_num) || 0) + (+r.impressions || 0));
    skuTotals.set(r.nh_sku, (skuTotals.get(r.nh_sku) || 0) + (+r.impressions || 0));
  }

  // Rank SKUs by total impressions descending.
  const allSkus = [...skuTotals.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([sku]) => sku);

  return { weeks, bySku, allSkus, skuTotals, rawRowCount: rows.length };
}

/* ---------------------------------------------------------------- *
 * Render
 * ---------------------------------------------------------------- */
function rerender() {
  const aggKw = computeKeywordAggregations();
  const aggSku = computeSkuAggregations();
  LocalState._aggKw = aggKw;
  LocalState._aggSku = aggSku;
  for (const m of KW_METRICS) renderKeywordPanel(m, aggKw);
  renderSkuPicker(aggSku);
  renderSkuPanel(aggSku);
}

function renderKeywordPanel(metric, agg) {
  const canvas = document.getElementById(`imp-${metric.key}-canvas`);
  const thead  = document.querySelector(`#imp-${metric.key}-tbl thead`);
  const tbody  = document.querySelector(`#imp-${metric.key}-tbl tbody`);
  const kpiEl  = document.getElementById(`imp-${metric.key}-kpi`);
  const metaEl = document.getElementById(`imp-${metric.key}-meta`);

  const labels = agg.periods.map(p => p.label);
  const values = agg.periods.map(p => p[metric.key]);

  renderLineChart(canvas, {
    labels,
    series: [{ label: metric.label, data: values }],
    yFormat: metric.yFormat,
    yTitle: metric.yTitle,
  });

  const latIdx = lastIndexNonNull(values);
  const prevIdx = latIdx > 0 ? prevNonNull(values, latIdx) : -1;
  const latestVal = latIdx >= 0 ? values[latIdx] : null;
  const prevVal   = prevIdx >= 0 ? values[prevIdx] : null;
  const delta = pctChange(latestVal, prevVal);
  if (latestVal == null) {
    kpiEl.innerHTML = `<span style="color:var(--brand-muted-2)">No data in range</span>`;
  } else {
    const dpart = delta == null
      ? `<span style="color:var(--brand-muted-2); margin-left:8px;">no prior week</span>`
      : `<span class="${delta > 0 ? "delta-up" : (delta < 0 ? "delta-down" : "")}" style="margin-left:8px;">${
            delta > 0 ? "▲" : (delta < 0 ? "▼" : "→")} ${Math.abs(delta).toFixed(1)}%</span>`;
    kpiEl.innerHTML = `<span class="kpi-val">${metric.fmt(latestVal)}</span>${dpart}`;
  }
  metaEl.textContent = `${agg.periods.length} ${pluralize("weekly", agg.periods.length)} · ${agg.rawRowCount} keyword-rows`;

  thead.innerHTML = `<tr><th>Period</th><th class="num">${escapeHtml(metric.label)}</th><th class="num">Δ vs prev</th></tr>`;
  const rowsHTML = [];
  for (let i = agg.periods.length - 1; i >= 0; i--) {
    const p = agg.periods[i];
    const v = values[i];
    const prev = i > 0 ? values[i - 1] : null;
    const dlt = pctChange(v, prev);
    const tip = p.range_display ? ` title="${escapeHtml(p.range_display)}"` : "";
    rowsHTML.push(`<tr><td${tip}><strong>${escapeHtml(p.label)}</strong></td><td class="num mono">${v == null ? "—" : metric.fmt(v)}</td><td class="num">${deltaPill(dlt)}</td></tr>`);
  }
  tbody.innerHTML = rowsHTML.join("") || `<tr><td colspan="3" class="empty-state">No weeks in range.</td></tr>`;
}

function lastIndexNonNull(arr) {
  for (let i = arr.length - 1; i >= 0; i--) if (arr[i] != null) return i;
  return -1;
}
function prevNonNull(arr, idx) {
  for (let i = idx - 1; i >= 0; i--) if (arr[i] != null) return i;
  return -1;
}

/* ===== SKU picker ===== */
let _skuPicker = null;
function renderSkuPicker(agg) {
  const slot = document.getElementById("imp-sku-picker-slot");
  if (!slot) return;
  const options = agg.allSkus.map(sku => ({ value: sku, label: skuShort(sku) }));
  // Default selection: top-N by total impressions in current range.
  const defaultSel = agg.allSkus.slice(0, SKU_TOP_N);

  slot.innerHTML = "";
  _skuPicker = createMultiSelect({
    id: "imp.skus",
    label: "",
    options,
    defaultSelected: defaultSel,
    allowAll: false,
    searchable: true,
    placeholder: "Pick SKUs…",
    maxSelected: 15,
  });
  _skuPicker.el.querySelector(".fl-lbl")?.remove();
  slot.appendChild(_skuPicker.el);

  // Clamp persisted selection to current option set; fall back to default.
  const sel = _skuPicker.getSelected().filter(s => agg.skuTotals.has(s));
  if (sel.length === 0 && defaultSel.length) _skuPicker.setSelected(defaultSel);
  LocalState.selectedSkus = _skuPicker.getSelected();

  _skuPicker.onChange((s) => {
    LocalState.selectedSkus = s;
    renderSkuPanel(LocalState._aggSku);
  });
}

/* ===== SKU panel ===== */
function renderSkuPanel(agg) {
  const canvas = document.getElementById("imp-sku-canvas");
  const thead  = document.querySelector("#imp-sku-tbl thead");
  const tbody  = document.querySelector("#imp-sku-tbl tbody");
  const kpiEl  = document.getElementById("imp-sku-kpi");

  if (!agg.weeks.length || LocalState.selectedSkus.length === 0) {
    destroyChart(canvas);
    thead.innerHTML = "";
    tbody.innerHTML = `<tr><td class="empty-state">${
      agg.weeks.length ? "Pick at least one SKU." : "No weeks in range."
    }</td></tr>`;
    kpiEl.textContent = "";
    return;
  }

  const labels = agg.weeks.map(w => w.label);
  const series = LocalState.selectedSkus.map(sku => ({
    label: skuShort(sku),
    data: agg.weeks.map(w => agg.bySku.get(sku)?.get(w.week_num) ?? null),
  }));

  renderLineChart(canvas, {
    labels,
    series,
    yFormat: "int",
    yTitle: "Impressions",
  });

  // KPI: total impressions across selected SKUs in the most recent week with data.
  let total = 0;
  let kpiWeek = null;
  for (let i = agg.weeks.length - 1; i >= 0; i--) {
    const w = agg.weeks[i];
    let weekTotal = 0;
    let any = false;
    for (const sku of LocalState.selectedSkus) {
      const v = agg.bySku.get(sku)?.get(w.week_num);
      if (v != null) { weekTotal += v; any = true; }
    }
    if (any) { total = weekTotal; kpiWeek = w; break; }
  }
  kpiEl.innerHTML = kpiWeek
    ? `<span class="kpi-val">${fmtInt(total)}</span> <span style="color:var(--brand-muted); font-size:var(--fs-sm); margin-left:4px;">selected SKUs · ${escapeHtml(kpiWeek.label)}</span>`
    : `<span style="color:var(--brand-muted-2)">No data in selected SKUs</span>`;

  // Table — one row per SKU, columns: SKU, totals per week + total in range.
  let head = `<tr><th>SKU</th>`;
  for (const w of agg.weeks) {
    const tip = w.range_display ? ` title="${escapeHtml(w.range_display)}"` : "";
    head += `<th class="num"${tip}>${escapeHtml(w.label)}</th>`;
  }
  head += `<th class="num">Total in range</th></tr>`;
  thead.innerHTML = head;

  const rowsHTML = LocalState.selectedSkus.map(sku => {
    let total = 0;
    let cells = "";
    for (const w of agg.weeks) {
      const v = agg.bySku.get(sku)?.get(w.week_num);
      if (v != null) total += v;
      cells += `<td class="num mono">${v == null ? "—" : fmtInt(v)}</td>`;
    }
    return `<tr><td class="kw-cell">${escapeHtml(skuShort(sku))}</td>${cells}<td class="num mono"><strong>${fmtInt(total)}</strong></td></tr>`;
  }).join("");
  tbody.innerHTML = rowsHTML || `<tr><td colspan="${agg.weeks.length + 2}" class="empty-state">No SKU data.</td></tr>`;
}

/* ---------------------------------------------------------------- *
 * Downloads
 * ---------------------------------------------------------------- */
function describeContext() {
  return {
    "Tab": "Impressions & Brand Share",
    "Granularity": "weekly",
    "Date range": `${LocalState.range.from || "—"} to ${LocalState.range.to || "—"}`,
    "Platforms": LocalState.platforms,
    "Keyword type": LocalState.branded,
    "Categories": LocalState.categories,
    "Sub-categories": LocalState.subcategories,
    "Generated at": new Date().toISOString(),
  };
}

function downloadMetric(metricKey, kind) {
  if (metricKey === "sku") return downloadSku(kind);
  const metric = KW_METRICS.find(m => m.key === metricKey);
  const agg = LocalState._aggKw;
  if (!metric || !agg || !agg.periods.length) { toast("Nothing to download."); return; }

  const cols = [
    { key: "period", label: "Period" },
    { key: "range",  label: "Date range" },
    { key: "value",  label: metric.label },
    { key: "delta",  label: "Δ vs prev (%)" },
  ];
  const rows = [];
  const values = agg.periods.map(p => p[metricKey]);
  for (let i = agg.periods.length - 1; i >= 0; i--) {
    const p = agg.periods[i];
    const v = values[i];
    const prev = i > 0 ? values[i - 1] : null;
    const dlt = pctChange(v, prev);
    rows.push({
      period: p.label,
      range: p.range_display || "",
      value: v == null ? "" : (metric.yFormat === "pct" ? Number(v.toFixed(4)) : v),
      delta: dlt == null ? "" : Number(dlt.toFixed(2)),
    });
  }
  const fname = `nat-habit_impressions-${metricKey}_${tsForFilename()}`;
  if (kind === "csv") return downloadCSV(`${fname}.csv`, cols, rows);
  downloadXLSX(`${fname}.xlsx`, [
    { name: metric.label, columns: cols, rows },
    rawKeywordSheet(),
    filterContextSheet("Filter context", describeContext()),
  ]);
}

function downloadSku(kind) {
  const agg = LocalState._aggSku;
  if (!agg || !agg.weeks.length) { toast("Nothing to download."); return; }
  const cols = [
    { key: "sku",   label: "NH SKU" },
    { key: "name",  label: "Product" },
    ...agg.weeks.map(w => ({ key: `w_${w.week_num}`, label: w.label })),
    { key: "total", label: "Total in range" },
  ];
  const rows = LocalState.selectedSkus.map(sku => {
    const row = { sku, name: LocalState.skuLookup?.get(sku) || "" };
    let total = 0;
    for (const w of agg.weeks) {
      const v = agg.bySku.get(sku)?.get(w.week_num);
      row[`w_${w.week_num}`] = v == null ? "" : v;
      if (v != null) total += v;
    }
    row.total = total;
    return row;
  });
  const fname = `nat-habit_impressions-sku_${tsForFilename()}`;
  if (kind === "csv") return downloadCSV(`${fname}.csv`, cols, rows);
  downloadXLSX(`${fname}.xlsx`, [
    { name: "SKU Impressions", columns: cols, rows },
    rawCatalogueSheet(),
    filterContextSheet("Filter context", describeContext()),
  ]);
}

function rawKeywordSheet() {
  const platSet = new Set(LocalState.platforms);
  const catSet = new Set(LocalState.categories);
  const subSet = new Set(LocalState.subcategories);
  const branded = LocalState.branded;
  const eligibleWNums = new Set(eligibleWeeks().map(w => w.week_num));
  const cols = [
    { key: "platform", label: "Platform" }, { key: "week_num", label: "Week #" },
    { key: "search_query", label: "Keyword" },
    { key: "branded_bucket", label: "Type" },
    { key: "category", label: "Category" }, { key: "subcategory", label: "Sub-category" },
    { key: "impressions", label: "Impressions" },
    { key: "brand_impression_share_pct", label: "Brand Impression Share %" },
    { key: "clicks", label: "Clicks" },
    { key: "brand_click_share_pct", label: "Brand Click Share %" },
  ];
  const rows = (State.data.weekly_sfr || []).filter(r =>
    platSet.has(r.platform) && eligibleWNums.has(r.week_num) &&
    (!catSet.size || catSet.has(r.category)) &&
    (!subSet.size || subSet.has(r.subcategory)) &&
    (branded === "both" ||
     (branded === "branded" && r.branded_bucket === "Branded") ||
     (branded === "generic" && r.branded_bucket !== "Branded")));
  return { name: "Filtered keyword rows", columns: cols, rows };
}

function rawCatalogueSheet() {
  const platSet = new Set(LocalState.platforms);
  const catSet = new Set(LocalState.categories);
  const subSet = new Set(LocalState.subcategories);
  const eligibleWNums = new Set(eligibleWeeks().map(w => w.week_num));
  const cols = [
    { key: "platform", label: "Platform" }, { key: "week_num", label: "Week #" },
    { key: "nh_sku", label: "NH SKU" },
    { key: "short_code", label: "Product" },
    { key: "category", label: "Category" }, { key: "subcategory", label: "Sub-category" },
    { key: "impressions", label: "Impressions" },
  ];
  const rows = (State.data.weekly_catalogue || []).filter(r =>
    platSet.has(r.platform) && eligibleWNums.has(r.week_num) &&
    (!catSet.size || catSet.has(r.category)) &&
    (!subSet.size || subSet.has(r.subcategory)));
  return { name: "Filtered SKU rows", columns: cols, rows };
}
