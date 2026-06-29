/**
 * tab-search.js — Search Movement tab.
 *
 * Spec §5.1. Renders:
 *   - Filter bar: date range, granularity (Weekly/Daily), platforms,
 *     branded/generic (both modes — daily inherits from weekly per
 *     calculate.py enrichment), keyword multi-select (max 10).
 *   - Top Keywords table — top 10 by rank (Amazon, lower=better) or volume
 *     (others, higher=better) in the latest period of the filtered range.
 *     Movement vs previous period. CSV + Excel downloads. View-full-list modal.
 *   - Keyword Trend chart — multi-line overlay (up to 10 keywords) across the
 *     filtered range. Y-axis reversed in rank mode.
 */

import { State, loadTab } from "./dashboard.js";
import { createDateRange, createSegmented, createMultiSelect } from "./filters.js";
import { renderLineChart, destroyChart, renderSideLegend, PALETTE } from "./charts.js";
import { downloadCSV, downloadXLSX, filterContextSheet } from "./downloads.js";
import { escapeHtml, fmtInt, toast } from "./util.js";

const RANK_PLATFORMS = new Set(["Amazon"]);
const KEYWORD_TREND_LIMIT = 10;

/** Tab-local UI state — separate from app-global filters so React-style. */
const LocalState = {
  view: "weekly",          // 'weekly' | 'daily'
  range: { from: "", to: "" },
  platforms: [],
  branded: "both",         // 'both' | 'branded' | 'generic' (Weekly only)
  globalCategories: [],    // tab-wide multi-select (empty array = all)
  globalKeywords: [],      // tab-wide multi-select (empty array = all)
  selectedKeywords: [],    // trend-chart picker selection (max 10)
  // sort: { col, dir }
  //   col: null (default), "keyword", "category", or a period label e.g. "Week23"
  //   dir: "auto" (rank→asc, volume→desc), "asc", or "desc"
  sort: { col: null, dir: "auto" },
  filters: null,           // map of widget refs
};

/* ---------------------------------------------------------------- *
 * Public entry
 * ---------------------------------------------------------------- */
let _built = false;

/** Reset module state (called by Live Refresh to force a rebuild). */
export function reset() {
  _built = false;
}

/** Build the tab markup + filters once; subsequent calls just re-render. */
export function renderSearchTab() {
  const root = document.getElementById("content-search");
  if (!root || !State.data) return;
  if (!_built) {
    _built = true;
    buildSkeleton(root);
    buildFilters();
  }
  rerender();
}

/* ---------------------------------------------------------------- *
 * DOM skeleton — replaces the milestone-2 placeholder content
 * ---------------------------------------------------------------- */
function buildSkeleton(root) {
  root.innerHTML = `
    <div id="search-mode-notice" class="mode-notice" hidden></div>

    <section class="section-card">
      <header class="section-head">
        <h2 class="section-title">Top keywords <span id="search-mode-subtitle" class="section-meta"></span></h2>
        <div class="section-actions">
          <span id="search-table-meta" class="section-meta"></span>
          <button class="icon-btn" id="search-top-csv">CSV</button>
          <button class="icon-btn" id="search-top-xlsx">Excel</button>
        </div>
      </header>
      <div class="tbl-wrap">
        <table class="data-tbl" id="search-top-tbl">
          <thead></thead>
          <tbody></tbody>
        </table>
      </div>
      <button class="expand-btn" id="search-expand-btn">View full keyword list →</button>
    </section>

    <section class="section-card">
      <header class="section-head">
        <h2 class="section-title">Keyword trend</h2>
        <div class="keyword-pickline">
          <span class="section-meta">Keywords:</span>
          <span id="search-keyword-picker-slot"></span>
          <span class="section-actions">
            <button class="icon-btn" id="search-trend-csv">CSV</button>
            <button class="icon-btn" id="search-trend-xlsx">Excel</button>
          </span>
        </div>
      </header>
      <div class="chart-and-legend">
        <div class="chart-box is-tall"><canvas id="search-trend-canvas"></canvas></div>
        <div class="chart-side-legend" id="search-trend-legend"></div>
      </div>
    </section>

    <!-- Modal -->
    <div class="modal-overlay" id="search-modal" hidden>
      <div class="modal-card">
        <div class="modal-head">
          <h2>All keywords</h2>
          <div style="display:flex; gap:6px; align-items:center;">
            <button class="icon-btn" id="search-full-csv">CSV</button>
            <button class="icon-btn" id="search-full-xlsx">Excel</button>
            <button class="modal-close" id="search-modal-close" aria-label="Close">×</button>
          </div>
        </div>
        <div class="modal-body">
          <table class="data-tbl" id="search-full-tbl">
            <thead></thead>
            <tbody></tbody>
          </table>
        </div>
      </div>
    </div>
  `;

  // Modal close handlers.
  document.getElementById("search-modal-close").addEventListener("click", closeModal);
  document.getElementById("search-modal").addEventListener("click", (e) => {
    if (e.target.id === "search-modal") closeModal();
  });
  document.getElementById("search-expand-btn").addEventListener("click", openModal);

  // Download buttons.
  document.getElementById("search-top-csv").addEventListener("click", () => downloadTopTable("csv"));
  document.getElementById("search-top-xlsx").addEventListener("click", () => downloadTopTable("xlsx"));
  document.getElementById("search-full-csv").addEventListener("click", () => downloadFullTable("csv"));
  document.getElementById("search-full-xlsx").addEventListener("click", () => downloadFullTable("xlsx"));
  document.getElementById("search-trend-csv").addEventListener("click", () => downloadTrend("csv"));
  document.getElementById("search-trend-xlsx").addEventListener("click", () => downloadTrend("xlsx"));
}

/* ---------------------------------------------------------------- *
 * Filter bar — built once
 * ---------------------------------------------------------------- */
function buildFilters() {
  const bar = document.getElementById("filters-search");
  if (!bar) return;
  bar.innerHTML = "";

  const md = State.data.metadata;
  const dr = md.date_range || {};

  // Date range
  const dateF = createDateRange({
    id: "search.range",
    minDate: dr.min,
    maxDate: dr.max,
    defaultDays: 90,
  });
  bar.appendChild(dateF.el);

  // Granularity
  const viewF = createSegmented({
    id: "search.view",
    label: "View by",
    options: [{ value: "weekly", label: "Weekly" }, { value: "daily", label: "Daily" }],
    defaultValue: "weekly",
  });
  bar.appendChild(viewF.el);

  // Platforms — flat alphabetical list (the rank-based/volume-based grouping
  // was misleading once Amazon could contribute volume in mixed mode). The
  // "View by" toggle now drives which subset is shown.
  const ALL_PLATFORM_OPTIONS = (md.platforms || []).map(p => ({ value: p, label: p }));
  const RANK_PLATFORM_OPTIONS = ALL_PLATFORM_OPTIONS.filter(o => RANK_PLATFORMS.has(o.value));
  const platsF = createMultiSelect({
    id: "search.platforms",
    label: "Platforms",
    options: ALL_PLATFORM_OPTIONS,
    defaultSelected: ALL_PLATFORM_OPTIONS.some(o => o.value === "Amazon") ? ["Amazon"] : ALL_PLATFORM_OPTIONS.slice(0, 1).map(o => o.value),
    allowAll: false,
    validate: (value, nextSet) => {
      if (nextSet.size === 0) {
        return "At least one platform must remain selected.";
      }
      return null;
    },
  });
  bar.appendChild(platsF.el);

  // Branded / Generic — Weekly only.
  const brandedF = createSegmented({
    id: "search.branded",
    label: "Keyword type",
    options: [
      { value: "both", label: "Both" },
      { value: "branded", label: "Branded" },
      { value: "generic", label: "Generic" },
    ],
    defaultValue: "both",
  });
  // appended later — after Categories + Keywords filters

  // Categories — multi-select, derived from weekly_sfr (the primary backing data
  // for Search Movement). Daily rows inherit category from the same upstream.
  const catSet = new Set();
  for (const r of State.data.weekly_sfr || []) if (r.category) catSet.add(r.category);
  for (const r of State.data.daily_sfr  || []) if (r.category) catSet.add(r.category);
  const categoryOptions = [...catSet].sort().map(c => ({ value: c, label: c }));
  const categoriesF = createMultiSelect({
    id: "search.categories",
    label: "Categories",
    options: categoryOptions,
    defaultSelected: categoryOptions.map(o => o.value),
    allowAll: true,
    searchable: true,
  });
  bar.appendChild(categoriesF.el);

  // Keywords — multi-select, cascades from categories. No max cap (tab-wide
  // filter; the trend-chart picker has its own 10-cap downstream).
  const keywordsF = createMultiSelect({
    id: "search.keywords",
    label: "Keywords",
    options: collectKeywordOptions(categoriesF.getSelected()),
    defaultSelected: null,          // null = all by default
    allowAll: true,
    searchable: true,
    placeholder: "All keywords",
  });
  bar.appendChild(keywordsF.el);

  // Now append Keyword Type (after the Categories + Keywords filters so the
  // visual order is: Date · View · Platforms · Categories · Keywords · Keyword Type · View by).
  bar.appendChild(brandedF.el);

  // "View by" — only meaningful when Amazon is the sole selected platform
  // in Weekly view. Defaults to Rank (Amazon's traditional view) but the
  // user can flip to Volume to surface keywords that have no rank.
  // Visibility is managed in rerender().
  const metricF = createSegmented({
    id: "search.metric",
    label: "View by",
    options: [
      { value: "rank",   label: "Rank" },
      { value: "volume", label: "Volume" },
    ],
    defaultValue: "rank",
  });
  bar.appendChild(metricF.el);

  // Stash option lists so the metric toggle's onChange handler can swap them.
  LocalState._allPlatformOptions  = ALL_PLATFORM_OPTIONS;
  LocalState._rankPlatformOptions = RANK_PLATFORM_OPTIONS;

  // Wire change events.
  LocalState.filters = { dateF, viewF, platsF, brandedF, metricF, categoriesF, keywordsF };
  syncFromFilters();
  // If we're starting in Rank mode + Weekly, clamp the platforms picker now
  // (in case persisted state has Volume-only platforms selected).
  applyMetricModeToPicker(/* toastOnDrop */ false);

  // Filter changes invalidate the user's column sort (different periods may
  // now be in view). Reset it so the table goes back to its natural ordering.
  const onFilterChange = () => { LocalState.sort = { col: null, dir: "auto" }; };

  dateF.onChange(() => { onFilterChange(); syncFromFilters(); rerender(); });
  viewF.onChange(() => { onFilterChange(); syncFromFilters(); applyMetricModeToPicker(false); rerender(); });
  platsF.onChange(() => { onFilterChange(); syncFromFilters(); rerender(); });
  brandedF.onChange(() => { onFilterChange(); syncFromFilters(); rerender(); });
  metricF.onChange(() => { onFilterChange(); syncFromFilters(); applyMetricModeToPicker(true); rerender(); });
  categoriesF.onChange(() => {
    onFilterChange();
    syncFromFilters();
    // Cascade: re-derive keyword options from the new category selection,
    // dropping picks that no longer apply.
    keywordsF.setOptions(collectKeywordOptions(LocalState.globalCategories));
    LocalState.globalKeywords = keywordsF.getSelected();
    rerender();
  });
  keywordsF.onChange(() => { onFilterChange(); syncFromFilters(); rerender(); });
}

/**
 * Build the option list for the global Keyword multi-select, restricted to
 * keywords whose category is among the currently-selected categories.
 * Used for both the initial build and the cascade on category change.
 */
function collectKeywordOptions(selectedCats) {
  const catSet = new Set(selectedCats);
  const kwSet = new Set();
  const addIfMatches = (r, kwField) => {
    const kw = r[kwField];
    if (!kw) return;
    if (catSet.size && !catSet.has(r.category)) return;
    kwSet.add(kw);
  };
  for (const r of State.data.weekly_sfr || []) addIfMatches(r, "search_query");
  for (const r of State.data.daily_sfr  || []) addIfMatches(r, "keyword");
  return [...kwSet].sort().map(k => ({ value: k, label: k }));
}

/**
 * Make the Platforms picker reflect the current "View by" toggle state.
 *   Rank mode  → show only rank-capable platforms
 *   Volume mode → show all platforms
 * If currently-selected platforms get filtered out (e.g., switching to Rank
 * with Flipkart selected), they're dropped and a toast explains.
 */
function applyMetricModeToPicker(toastOnDrop) {
  const { platsF, viewF, metricF } = LocalState.filters || {};
  if (!platsF || !viewF || !metricF) return;
  const isWeekly = viewF.getValue() === "weekly";
  const rankMode = metricF.getValue() === "rank";
  // In Daily view, the toggle is hidden — keep the full platform list.
  const newOptions = (isWeekly && rankMode)
    ? LocalState._rankPlatformOptions
    : LocalState._allPlatformOptions;
  const fallback = newOptions.some(o => o.value === "Amazon") ? ["Amazon"] : [];
  const dropped = platsF.setOptions(newOptions, fallback);
  // Sync LocalState since selection may have changed.
  LocalState.platforms = platsF.getSelected();
  if (toastOnDrop && dropped.length) {
    const names = dropped.join(", ");
    toast(`Hidden ${names} — no rank data available.`);
  }
}

function syncFromFilters() {
  const { dateF, viewF, platsF, brandedF, metricF, categoriesF, keywordsF } = LocalState.filters;
  LocalState.range = dateF.getRange();
  LocalState.view = viewF.getValue();
  LocalState.platforms = platsF.getSelected();
  LocalState.branded = brandedF.getValue();
  LocalState.metricMode = metricF.getValue();   // 'rank' or 'volume'
  LocalState.globalCategories = categoriesF ? categoriesF.getSelected() : [];
  LocalState.globalKeywords   = keywordsF   ? keywordsF.getSelected()   : [];
  // Keyword-type filter is valid in both Weekly and Daily — daily rows
  // carry a branded_bucket field enriched by the pipeline.
}

/* ---------------------------------------------------------------- *
 * Re-render everything that depends on filter state
 * ---------------------------------------------------------------- */
/**
 * Decide whether the chart should be in rank mode right now.
 *
 *   Weekly + user toggle = "rank" → rank mode. The Platforms picker is
 *     already filtered to rank-capable platforms by
 *     applyMetricModeToPicker(), so "all selected platforms are rank-
 *     capable" is guaranteed in this state.
 *   Daily: rank mode whenever Amazon is selected (Daily SFR has no volume
 *     column — Amazon's daily values are ranks).
 *
 * Single source of truth so the various render + download paths agree.
 */
function currentRankMode() {
  const isWeekly = LocalState.view === "weekly";
  if (isWeekly) {
    return LocalState.metricMode === "rank";
  }
  // Daily: any Amazon selection → rank mode (Daily SFR has no volume column).
  return LocalState.platforms.some(p => RANK_PLATFORMS.has(p));
}

function rerender() {
  const isWeekly = LocalState.view === "weekly";

  // Toggle visibility: show in Weekly when at least one rank-capable
  // platform exists in the data. Hide in Daily (single field per row).
  const metricF = LocalState.filters?.metricF;
  if (metricF) {
    const anyRankCapable = (LocalState._rankPlatformOptions || []).length > 0;
    metricF.el.style.display = (isWeekly && anyRankCapable) ? "" : "none";
  }

  const rankMode = currentRankMode();

  // Mode notice — describes what the user is looking at.
  const notice = document.getElementById("search-mode-notice");
  if (rankMode) {
    const ctx = isWeekly ? "Weekly" : "Amazon";
    notice.innerHTML = `<strong>Rank mode (${ctx})</strong> — lower numbers are better. Movement arrows show rank changes. Only keywords inside the ranked set appear.`;
    notice.hidden = false;
  } else if (isWeekly && LocalState.platforms.length === 1) {
    notice.innerHTML = `<strong>Volume mode</strong> — search volume per keyword on ${escapeHtml(LocalState.platforms[0])}.`;
    notice.hidden = false;
  } else if (LocalState.platforms.length > 1) {
    notice.innerHTML = `<strong>Volume mode</strong> — searches summed across ${LocalState.platforms.length} platforms.`;
    notice.hidden = false;
  } else {
    notice.hidden = true;
  }
  document.getElementById("search-mode-subtitle").textContent = rankMode
    ? "— by Search Rank (latest period)"
    : "— by Search Volume (latest period)";

  // Compute aggregations.
  const agg = computeAggregations({ rankMode });
  LocalState._agg = agg;  // cached for downloads

  renderTopTable(agg, rankMode);
  renderTableMeta(agg);
  renderKeywordPicker(agg);
  renderTrend(agg, rankMode);
}

/* ---------------------------------------------------------------- *
 * Aggregations
 *
 * Returns:
 *   {
 *     periods: string[]                // labels for chart x-axis ('Week23', '2026-06-15', etc.)
 *     periodMeta: Map(label -> {start, end, range_display})
 *     latestPeriod: string | null
 *     prevPeriod: string | null
 *     byKeyword: Map(kw -> {
 *         keyword, category, subcategory,
 *         periodValues: Map(label -> number|null),
 *         latestValue, prevValue,
 *         movementDiff, movementPct, improved,
 *     })
 *     keywordsSortedForLatest: string[]  // sort order at latest period
 *   }
 * ---------------------------------------------------------------- */
function computeAggregations({ rankMode }) {
  const { range, view, platforms, branded } = LocalState;

  if (view === "weekly") return aggregateWeekly({ range, platforms, branded, rankMode });
  return aggregateDaily({ range, platforms, branded, rankMode });
}

function aggregateWeekly({ range, platforms, branded, rankMode }) {
  const weeks = State.data.weeks || [];
  const allRows = State.data.weekly_sfr;
  if (!Array.isArray(allRows)) return emptyAgg();

  // Determine eligible week_nums: weeks fully inside [from, to].
  const eligibleWeeks = weeks.filter(w => {
    if (range.from && w.start < range.from) return false;
    if (range.to   && w.end   > range.to)   return false;
    return true;
  });
  const weekNumSet = new Set(eligibleWeeks.map(w => w.week_num));

  const periodLabels = eligibleWeeks.map(w => w.label);  // 'Week23'
  const periodMeta = new Map(eligibleWeeks.map(w => [w.label, w]));

  // Filter rows: platform, week, branded, category, keyword.
  const platSet = new Set(platforms);
  const brandedFilter = branded;
  const catSet  = setOrNullForAll(LocalState.globalCategories);
  const kwSet   = setOrNullForAll(LocalState.globalKeywords);
  const filtered = allRows.filter(r =>
    platSet.has(r.platform) &&
    weekNumSet.has(r.week_num) &&
    (brandedFilter === "both" || (r.branded_bucket || "Generic").toLowerCase() === brandedFilter) &&
    (catSet == null || catSet.has(r.category)) &&
    (kwSet  == null || kwSet.has(r.search_query))
  );

  // Group by keyword × week. Metric: rank (Amazon) → min; volume (others) → sum.
  const byKeyword = new Map();
  for (const r of filtered) {
    let entry = byKeyword.get(r.search_query);
    if (!entry) {
      entry = {
        keyword: r.search_query,
        category: r.category,
        subcategory: r.subcategory,
        periodValues: new Map(),
      };
      byKeyword.set(r.search_query, entry);
    }
    const weekLabel = `Week${r.week_num}`;
    const existing = entry.periodValues.get(weekLabel);
    const metric = rankMode ? r.rank : r.volume;
    if (metric == null) continue;
    if (existing == null) entry.periodValues.set(weekLabel, metric);
    else if (rankMode) entry.periodValues.set(weekLabel, Math.min(existing, metric));
    else entry.periodValues.set(weekLabel, existing + metric);
  }

  return finishAgg(byKeyword, periodLabels, periodMeta, rankMode);
}

/**
 * Treat a "fully selected" multi-select as "no filter at all" so the table
 * doesn't go empty when the widget is built with everything pre-checked but
 * the underlying data has more categories/keywords than the option set.
 *
 * Returns: null (= no filter) | Set of allowed values
 */
function setOrNullForAll(arr) {
  if (!arr || arr.length === 0) return null;
  return new Set(arr);
}

function aggregateDaily({ range, platforms, branded, rankMode }) {
  const allRows = State.data.daily_sfr;
  if (!Array.isArray(allRows)) return emptyAgg();

  const platSet = new Set(platforms);
  const brandedFilter = branded;
  const catSet = setOrNullForAll(LocalState.globalCategories);
  const kwSet  = setOrNullForAll(LocalState.globalKeywords);
  const filtered = allRows.filter(r => {
    if (!platSet.has(r.platform)) return false;
    if (range.from && r.date < range.from) return false;
    if (range.to   && r.date > range.to)   return false;
    if (brandedFilter !== "both" &&
        (r.branded_bucket || "Generic").toLowerCase() !== brandedFilter) return false;
    if (catSet && !catSet.has(r.category)) return false;
    if (kwSet  && !kwSet.has(r.keyword))   return false;
    return true;
  });

  // x-axis is distinct dates in ascending order.
  const dateSet = new Set();
  for (const r of filtered) dateSet.add(r.date);
  const periodLabels = [...dateSet].sort();
  const periodMeta = new Map(periodLabels.map(d => [d, { range_display: d }]));

  const byKeyword = new Map();
  for (const r of filtered) {
    let entry = byKeyword.get(r.keyword);
    if (!entry) {
      entry = {
        keyword: r.keyword,
        category: r.category,
        subcategory: r.subcategory,
        periodValues: new Map(),
      };
      byKeyword.set(r.keyword, entry);
    }
    if (r.rank == null) continue;
    const existing = entry.periodValues.get(r.date);
    if (existing == null) entry.periodValues.set(r.date, r.rank);
    else if (rankMode) entry.periodValues.set(r.date, Math.min(existing, r.rank));
    else entry.periodValues.set(r.date, existing + r.rank);
  }

  return finishAgg(byKeyword, periodLabels, periodMeta, rankMode);
}

function finishAgg(byKeyword, periodLabels, periodMeta, rankMode) {
  // "Latest" = most recent period in range that has at least one data point.
  const periodsWithData = periodLabels.filter(p =>
    [...byKeyword.values()].some(e => e.periodValues.get(p) != null)
  );
  const latestPeriod = periodsWithData.length
    ? periodsWithData[periodsWithData.length - 1]
    : null;
  // "Previous period" = calendar period immediately before latest (regardless
  // of whether that period had data).
  const latestIdx = latestPeriod ? periodLabels.indexOf(latestPeriod) : -1;
  const prevPeriod = latestIdx > 0 ? periodLabels[latestIdx - 1] : null;

  // Visible periods = the full eligible range (the user's date filter now
  // determines column count; the table scrolls horizontally if it overflows).
  const visiblePeriods = periodLabels.slice();

  // Compute latest/prev and movement per keyword.
  for (const entry of byKeyword.values()) {
    entry.latestValue = latestPeriod ? entry.periodValues.get(latestPeriod) ?? null : null;
    entry.prevValue   = prevPeriod   ? entry.periodValues.get(prevPeriod)   ?? null : null;
    if (entry.latestValue != null && entry.prevValue != null) {
      entry.movementDiff = entry.latestValue - entry.prevValue;
      if (rankMode) {
        // Lower is better; improvement = negative diff.
        entry.improved = entry.movementDiff < 0;
        entry.movementPct = null;
      } else {
        entry.improved = entry.movementDiff > 0;
        entry.movementPct = entry.prevValue !== 0
          ? (entry.movementDiff / Math.abs(entry.prevValue)) * 100
          : null;
      }
    } else {
      entry.movementDiff = null;
      entry.movementPct = null;
      entry.improved = null;
    }
  }

  // Default sort: by latest period value (ascending for rank, descending for
  // volume). Keywords missing in latest period go last. This drives
  // keywordsSortedForLatest (used by the trend picker) regardless of the
  // user's table sort choice.
  const defaultSorted = [...byKeyword.values()].sort((a, b) =>
    compareByValue(a.latestValue, b.latestValue, a.keyword, b.keyword, rankMode));

  return {
    periods: periodLabels,
    visiblePeriods,
    periodMeta,
    latestPeriod, prevPeriod,
    byKeyword,
    keywordsSortedForLatest: defaultSorted.map(e => e.keyword),
    sortedEntries: defaultSorted,    // default order; renderTopTable may resort
  };
}

/**
 * Shared comparator for the top-keywords table. `rankMode` flips the sense
 * (lower rank wins; higher volume wins). Nulls last regardless.
 */
function compareByValue(av, bv, aKey, bKey, rankMode) {
  if (av == null && bv == null) return aKey.localeCompare(bKey);
  if (av == null) return 1;
  if (bv == null) return -1;
  return rankMode ? (av - bv) : (bv - av);
}

function emptyAgg() {
  return {
    periods: [], visiblePeriods: [], periodMeta: new Map(),
    latestPeriod: null, prevPeriod: null,
    byKeyword: new Map(),
    keywordsSortedForLatest: [], sortedEntries: [],
  };
}

/* ---------------------------------------------------------------- *
 * Top-10 table — now sortable + spans the full eligible date range
 * ---------------------------------------------------------------- */
function renderTopTable(agg, rankMode) {
  const thead = document.querySelector("#search-top-tbl thead");
  const tbody = document.querySelector("#search-top-tbl tbody");

  if (!agg.sortedEntries.length || !agg.latestPeriod) {
    thead.innerHTML = "";
    tbody.innerHTML = `<tr><td class="empty-state">No keyword data in the selected range. Adjust filters above.</td></tr>`;
    return;
  }

  const showPeriods = agg.visiblePeriods;   // all eligible periods in range
  // Resolve the active sort spec into (col, dir).
  const sortSpec = resolveSortSpec(agg, rankMode);

  // Reorder + slice to top-10 based on the active sort column.
  const ordered = orderEntriesForSort(agg.sortedEntries, sortSpec, rankMode);
  const top10 = ordered.slice(0, 10);

  // Build header with sortable controls. # is not sortable (it's just row index
  // after sort); every other column is.
  let head = `<tr>
    <th class="rank">#</th>
    ${sortableTh("keyword",  "Keyword",  sortSpec, "left")}
    ${sortableTh("category", "Category", sortSpec, "left")}`;
  for (const p of showPeriods) {
    const isLatest = (p === agg.latestPeriod);
    const meta = agg.periodMeta.get(p);
    const tip = meta?.range_display ? meta.range_display : "";
    const label = isLatest ? `${p} (latest)` : p;
    head += sortableTh(p, label, sortSpec, "num", tip);
  }
  head += `<th class="num">Movement</th></tr>`;
  thead.innerHTML = head;

  // Wire click handlers on sortable th cells.
  thead.querySelectorAll("th[data-sort-col]").forEach(th => {
    th.addEventListener("click", () => {
      const col = th.dataset.sortCol;
      const cur = LocalState.sort;
      // Cycle: same column → flip dir; new column → auto (rank/volume default).
      if (cur.col === col) {
        const next = cur.dir === "asc" ? "desc" : (cur.dir === "desc" ? "auto" : "asc");
        LocalState.sort = next === "auto" ? { col: null, dir: "auto" } : { col, dir: next };
      } else {
        LocalState.sort = { col, dir: defaultDirForColumn(col, rankMode) };
      }
      renderTopTable(agg, rankMode);
    });
  });

  tbody.innerHTML = top10.map((e, i) => rowHtml(e, i + 1, showPeriods, rankMode)).join("");
}

/**
 * Render a sortable <th>. `colKey` is what LocalState.sort.col will be set to.
 * Adds a small ▲ / ▼ glyph when this is the active sort column.
 */
function sortableTh(colKey, label, sortSpec, align, tooltip) {
  const cls = align === "num" ? "num" : "";
  const active = sortSpec.col === colKey;
  const arrow = active ? (sortSpec.dir === "asc" ? " ▲" : " ▼") : "";
  const cn = `${cls} sortable${active ? " is-active-sort" : ""}`.trim();
  const tip = tooltip ? ` title="${escapeHtml(tooltip)}"` : "";
  return `<th class="${cn}" data-sort-col="${escapeHtml(colKey)}"${tip}>${escapeHtml(label)}<span class="sort-arrow">${arrow}</span></th>`;
}

/**
 * Default direction when activating a sort column for the first time.
 *   keyword / category → asc (alphabetical)
 *   period column      → asc in rank mode, desc in volume mode (i.e., best
 *                        values first either way)
 */
function defaultDirForColumn(col, rankMode) {
  if (col === "keyword" || col === "category") return "asc";
  return rankMode ? "asc" : "desc";
}

/**
 * Resolve the live LocalState.sort into a (col, dir) pair, falling back to
 * "default" when the user hasn't picked anything: that's a sort by latest
 * period with the metric-appropriate direction.
 */
function resolveSortSpec(agg, rankMode) {
  const s = LocalState.sort || { col: null, dir: "auto" };
  if (s.col) return { col: s.col, dir: s.dir === "auto" ? defaultDirForColumn(s.col, rankMode) : s.dir };
  return { col: agg.latestPeriod, dir: rankMode ? "asc" : "desc", _isDefault: true };
}

/**
 * Sort the entries by the chosen column + direction. Nulls last regardless.
 */
function orderEntriesForSort(entries, sortSpec, rankMode) {
  const { col, dir } = sortSpec;
  const arr = entries.slice();
  arr.sort((a, b) => {
    if (col === "keyword") {
      const cmp = (a.keyword || "").localeCompare(b.keyword || "");
      return dir === "asc" ? cmp : -cmp;
    }
    if (col === "category") {
      const cmp = (a.category || "").localeCompare(b.category || "");
      return dir === "asc" ? cmp : -cmp;
    }
    // Period column.
    const av = a.periodValues.get(col) ?? null;
    const bv = b.periodValues.get(col) ?? null;
    if (av == null && bv == null) return (a.keyword || "").localeCompare(b.keyword || "");
    if (av == null) return 1;
    if (bv == null) return -1;
    return dir === "asc" ? (av - bv) : (bv - av);
  });
  return arr;
}

function rowHtml(entry, rank, showPeriods, rankMode) {
  let row = `<td class="rank">${rank}</td>`;
  row += `<td class="kw-cell">${escapeHtml(entry.keyword || "—")}</td>`;
  row += `<td class="cat-cell">${escapeHtml(entry.category || "—")}</td>`;
  for (const p of showPeriods) {
    const v = entry.periodValues.get(p);
    row += `<td class="num mono">${v == null ? "—" : fmtInt(v)}</td>`;
  }
  row += `<td class="num">${movementPill(entry, rankMode)}</td>`;
  return `<tr>${row}</tr>`;
}

function movementPill(e, rankMode) {
  if (e.movementDiff == null) return `<span class="pill pill--flat">—</span>`;
  if (e.movementDiff === 0)   return `<span class="pill pill--flat">→ 0</span>`;
  const cls = e.improved ? "pill--up" : "pill--down";
  const sign = e.improved ? "↑" : "↓";
  if (rankMode) {
    return `<span class="pill ${cls}">${sign} ${Math.abs(e.movementDiff)}</span>`;
  }
  const pctStr = e.movementPct == null ? "" : ` (${e.movementPct > 0 ? "+" : ""}${e.movementPct.toFixed(1)}%)`;
  return `<span class="pill ${cls}">${sign} ${fmtInt(Math.abs(e.movementDiff))}${pctStr}</span>`;
}

function renderTableMeta(agg) {
  const el = document.getElementById("search-table-meta");
  if (!el) return;
  if (!agg.latestPeriod) { el.textContent = ""; return; }
  const meta = agg.periodMeta.get(agg.latestPeriod);
  const range = meta?.range_display ? ` · ${meta.range_display}` : "";
  el.textContent = `${agg.periods.length} period(s) · Latest: ${agg.latestPeriod}${range}`;
}

/* ---------------------------------------------------------------- *
 * Keyword picker for trend chart
 * ---------------------------------------------------------------- */
let _keywordPicker = null;

function renderKeywordPicker(agg) {
  const slot = document.getElementById("search-keyword-picker-slot");
  if (!slot) return;

  const options = agg.keywordsSortedForLatest.map(k => ({ value: k, label: k }));

  // Default selection: top 5 keywords from the table on first build.
  const defaultSelected = agg.keywordsSortedForLatest.slice(0, 5);

  // Rebuild the picker when the option set has materially changed.
  // For simplicity, rebuild every render — it's a tiny widget.
  slot.innerHTML = "";
  _keywordPicker = createMultiSelect({
    id: "search.keywords",
    label: "",   // label is shown by the inline span outside
    options,
    defaultSelected,
    allowAll: false,
    maxSelected: KEYWORD_TREND_LIMIT,
    searchable: true,
    placeholder: "Pick keywords…",
  });
  // Trim the label group so it inlines flush.
  _keywordPicker.el.querySelector(".fl-lbl")?.remove();
  slot.appendChild(_keywordPicker.el);

  // Honor saved selection but clamp to current options.
  const sel = _keywordPicker.getSelected().filter(k => options.find(o => o.value === k));
  if (sel.length === 0 && defaultSelected.length) {
    _keywordPicker.setSelected(defaultSelected);
  }
  LocalState.selectedKeywords = _keywordPicker.getSelected();

  _keywordPicker.onChange(sel => {
    LocalState.selectedKeywords = sel;
    renderTrend(LocalState._agg, currentRankMode());
  });
}

/* ---------------------------------------------------------------- *
 * Trend chart
 * ---------------------------------------------------------------- */
function renderTrend(agg, rankMode) {
  const canvas = document.getElementById("search-trend-canvas");
  const legendEl = document.getElementById("search-trend-legend");
  if (!canvas) return;
  if (!agg.periods.length || LocalState.selectedKeywords.length === 0) {
    destroyChart(canvas);
    if (legendEl) legendEl.innerHTML = "";
    return;
  }
  const series = LocalState.selectedKeywords
    .slice(0, KEYWORD_TREND_LIMIT)
    .map(kw => {
      const entry = agg.byKeyword.get(kw);
      if (!entry) return null;
      const data = agg.periods.map(p => entry.periodValues.get(p) ?? null);
      return { label: kw, data };
    })
    .filter(Boolean);

  const chart = renderLineChart(canvas, {
    labels: agg.periods,
    series,
    yReverse: rankMode,
    yFormat: "int",
    yTitle: rankMode ? "Search rank (lower = better)" : "Search volume",
    hideLegend: true,
  });
  renderSideLegend(legendEl, chart);
}

/* ---------------------------------------------------------------- *
 * Full-list modal
 * ---------------------------------------------------------------- */
function openModal() {
  const agg = LocalState._agg;
  const rankMode = currentRankMode();
  if (!agg || !agg.latestPeriod) {
    toast("No data to show.");
    return;
  }
  const thead = document.querySelector("#search-full-tbl thead");
  const tbody = document.querySelector("#search-full-tbl tbody");
  const showPeriods = agg.visiblePeriods;
  const sortSpec = resolveSortSpec(agg, rankMode);
  const ordered = orderEntriesForSort(agg.sortedEntries, sortSpec, rankMode);

  let head = `<tr><th class="rank">#</th><th>Keyword</th><th>Category</th>`;
  for (const p of showPeriods) {
    const isLatest = (p === agg.latestPeriod);
    const meta = agg.periodMeta.get(p);
    const tip = meta?.range_display ? ` title="${escapeHtml(meta.range_display)}"` : "";
    head += `<th class="num"${tip}>${escapeHtml(isLatest ? p + " (latest)" : p)}</th>`;
  }
  head += `<th class="num">Movement</th></tr>`;
  thead.innerHTML = head;

  tbody.innerHTML = ordered
    .map((e, i) => rowHtml(e, i + 1, showPeriods, rankMode))
    .join("");

  document.getElementById("search-modal").hidden = false;
}
function closeModal() {
  document.getElementById("search-modal").hidden = true;
}

/* ---------------------------------------------------------------- *
 * Downloads
 * ---------------------------------------------------------------- */
function describeContext(rankMode) {
  const allCats  = new Set((State.data.metadata.categories || []));
  const allCatsCovered = LocalState.globalCategories.length === 0
    || LocalState.globalCategories.length >= allCats.size;
  return {
    "Tab": "Search Movement",
    "View": LocalState.view === "weekly" ? "Weekly" : "Daily",
    "Mode": rankMode ? "Rank (Amazon, lower = better)" : "Volume (higher = better)",
    "Date range": `${LocalState.range.from || "—"} to ${LocalState.range.to || "—"}`,
    "Platforms": LocalState.platforms,
    "Keyword type filter": LocalState.branded,
    "Categories": allCatsCovered ? "All" : LocalState.globalCategories,
    "Keywords filter": LocalState.globalKeywords.length === 0
      ? "All (no filter)"
      : LocalState.globalKeywords,
    "Sort": LocalState.sort.col
      ? `${LocalState.sort.col} (${LocalState.sort.dir})`
      : `${rankMode ? "rank ascending" : "volume descending"} on ${LocalState.range.to ? "latest period" : "latest period"}`,
    "Generated at": new Date().toISOString(),
  };
}

function topTableColumnsAndRows(limit) {
  const agg = LocalState._agg;
  if (!agg) return { columns: [], rows: [] };
  const rankMode = currentRankMode();
  const showPeriods = agg.visiblePeriods;
  const sortSpec = resolveSortSpec(agg, rankMode);
  const ordered = orderEntriesForSort(agg.sortedEntries, sortSpec, rankMode);
  const columns = [
    { key: "rank", label: "#" },
    { key: "keyword", label: "Keyword" },
    { key: "category", label: "Category" },
    { key: "subcategory", label: "Sub-category" },
    ...showPeriods.map(p => ({ key: `p_${p}`, label: p === agg.latestPeriod ? `${p} (latest)` : p })),
    { key: "movement", label: "Movement" },
  ];
  const entries = limit ? ordered.slice(0, limit) : ordered;
  const rows = entries.map((e, i) => {
    const row = {
      rank: i + 1,
      keyword: e.keyword,
      category: e.category,
      subcategory: e.subcategory,
      movement: e.movementDiff == null ? ""
        : (e.movementPct != null
            ? `${e.movementDiff > 0 ? "+" : ""}${e.movementDiff.toFixed(0)} (${e.movementPct > 0 ? "+" : ""}${e.movementPct.toFixed(1)}%)`
            : `${e.movementDiff > 0 ? "+" : ""}${e.movementDiff}`),
    };
    for (const p of showPeriods) {
      const v = e.periodValues.get(p);
      row[`p_${p}`] = v == null ? "" : v;
    }
    return row;
  });
  return { columns, rows };
}

function downloadTopTable(kind) {
  const { columns, rows } = topTableColumnsAndRows(10);
  if (!rows.length) { toast("Nothing to download."); return; }
  const fname = `nat-habit_top-keywords_${ts()}`;
  if (kind === "csv") return downloadCSV(`${fname}.csv`, columns, rows);
  const rankMode = currentRankMode();
  downloadXLSX(`${fname}.xlsx`, [
    { name: "Top 10", columns, rows },
    rawRowsSheet("Filtered rows"),
    filterContextSheet("Filter context", describeContext(rankMode)),
  ]);
}

function downloadFullTable(kind) {
  const { columns, rows } = topTableColumnsAndRows(null);
  if (!rows.length) { toast("Nothing to download."); return; }
  const fname = `nat-habit_all-keywords_${ts()}`;
  if (kind === "csv") return downloadCSV(`${fname}.csv`, columns, rows);
  const rankMode = currentRankMode();
  downloadXLSX(`${fname}.xlsx`, [
    { name: "All keywords", columns, rows },
    rawRowsSheet("Filtered rows"),
    filterContextSheet("Filter context", describeContext(rankMode)),
  ]);
}

function downloadTrend(kind) {
  const agg = LocalState._agg;
  if (!agg || !agg.periods.length) { toast("Nothing to download."); return; }
  const cols = [
    { key: "keyword", label: "Keyword" },
    ...agg.periods.map(p => ({ key: `p_${p}`, label: p })),
  ];
  const rows = LocalState.selectedKeywords
    .slice(0, KEYWORD_TREND_LIMIT)
    .map(kw => {
      const e = agg.byKeyword.get(kw);
      if (!e) return null;
      const row = { keyword: kw };
      for (const p of agg.periods) row[`p_${p}`] = e.periodValues.get(p) ?? "";
      return row;
    })
    .filter(Boolean);
  if (!rows.length) { toast("Pick at least one keyword."); return; }
  const fname = `nat-habit_keyword-trend_${ts()}`;
  if (kind === "csv") return downloadCSV(`${fname}.csv`, cols, rows);
  const rankMode = currentRankMode();
  downloadXLSX(`${fname}.xlsx`, [
    { name: "Trend (selected)", columns: cols, rows },
    rawRowsSheet("Filtered rows"),
    filterContextSheet("Filter context", describeContext(rankMode)),
  ]);
}

/** Build a sheet with the raw filtered rows from State.data for the active view. */
function rawRowsSheet(name) {
  const view = LocalState.view;
  const platSet = new Set(LocalState.platforms);
  const range = LocalState.range;
  const catSet = setOrNullForAll(LocalState.globalCategories);
  const kwSet  = setOrNullForAll(LocalState.globalKeywords);

  if (view === "weekly") {
    const weeks = State.data.weeks || [];
    const eligible = new Set(weeks
      .filter(w => (!range.from || w.start >= range.from) && (!range.to || w.end <= range.to))
      .map(w => w.week_num));
    const cols = [
      { key: "platform", label: "Platform" },
      { key: "week_num", label: "Week #" },
      { key: "search_query", label: "Keyword" },
      { key: "branded_bucket", label: "Type" },
      { key: "category", label: "Category" },
      { key: "subcategory", label: "Sub-category" },
      { key: "rank", label: "Rank" },
      { key: "volume", label: "Volume" },
      { key: "impressions", label: "Impressions" },
      { key: "brand_impression_share_pct", label: "Brand Impr Share %" },
      { key: "clicks", label: "Clicks" },
      { key: "brand_click_share_pct", label: "Brand Click Share %" },
    ];
    const rows = (State.data.weekly_sfr || []).filter(r =>
      platSet.has(r.platform) && eligible.has(r.week_num) &&
      (LocalState.branded === "both" || (r.branded_bucket || "Generic").toLowerCase() === LocalState.branded) &&
      (catSet == null || catSet.has(r.category)) &&
      (kwSet  == null || kwSet.has(r.search_query))
    );
    return { name, columns: cols, rows };
  }

  const cols = [
    { key: "platform", label: "Platform" },
    { key: "date", label: "Date" },
    { key: "keyword", label: "Keyword" },
    { key: "category", label: "Category" },
    { key: "subcategory", label: "Sub-category" },
    { key: "rank", label: "Rank" },
  ];
  const rows = (State.data.daily_sfr || []).filter(r =>
    platSet.has(r.platform) &&
    (!range.from || r.date >= range.from) &&
    (!range.to   || r.date <= range.to) &&
    (catSet == null || catSet.has(r.category)) &&
    (kwSet  == null || kwSet.has(r.keyword))
  );
  return { name, columns: cols, rows };
}

function ts() {
  const d = new Date();
  const pad = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
