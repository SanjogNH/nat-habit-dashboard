/**
 * tab-search.js — Search Movement tab.
 *
 * Spec §5.1. Renders:
 *   - Filter bar: date range, granularity (Weekly/Daily), platforms,
 *     branded/generic (Weekly only), keyword multi-select (max 10).
 *   - Top Keywords table — top 10 by rank (Amazon, lower=better) or volume
 *     (others, higher=better) in the latest period of the filtered range.
 *     Movement vs previous period. CSV + Excel downloads. View-full-list modal.
 *   - Keyword Trend chart — multi-line overlay (up to 10 keywords) across the
 *     filtered range. Y-axis reversed in rank mode.
 */

import { State, loadTab } from "./dashboard.js";
import { createDateRange, createSegmented, createMultiSelect } from "./filters.js";
import { renderLineChart, destroyChart, PALETTE } from "./charts.js";
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
  selectedKeywords: [],
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
      <div class="chart-box is-tall"><canvas id="search-trend-canvas"></canvas></div>
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

  // Platforms — partitioned into rank-based and volume-based.
  const platformOptions = (md.platforms || []).map(p => ({
    value: p, label: p,
    group: RANK_PLATFORMS.has(p) ? "Rank-based" : "Volume-based",
  }));
  const platsF = createMultiSelect({
    id: "search.platforms",
    label: "Platforms",
    options: platformOptions,
    defaultSelected: platformOptions.some(o => o.value === "Amazon") ? ["Amazon"] : platformOptions.slice(0, 1).map(o => o.value),
    allowAll: false,
    validate: (value, nextSet) => {
      // Reject mixing Amazon (rank) with non-Amazon (volume).
      const hasAmazon = nextSet.has("Amazon");
      const hasOther = [...nextSet].some(v => v !== "Amazon");
      if (hasAmazon && hasOther) {
        return "Amazon (rank) can't be combined with volume-based platforms. Deselect one side first.";
      }
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
  bar.appendChild(brandedF.el);

  // Wire change events.
  LocalState.filters = { dateF, viewF, platsF, brandedF };
  syncFromFilters();
  dateF.onChange(() => { syncFromFilters(); rerender(); });
  viewF.onChange(() => { syncFromFilters(); rerender(); });
  platsF.onChange(() => { syncFromFilters(); rerender(); });
  brandedF.onChange(() => { syncFromFilters(); rerender(); });
}

function syncFromFilters() {
  const { dateF, viewF, platsF, brandedF } = LocalState.filters;
  LocalState.range = dateF.getRange();
  LocalState.view = viewF.getValue();
  LocalState.platforms = platsF.getSelected();
  LocalState.branded = brandedF.getValue();
  // Toggle visibility of the Branded segment based on view.
  brandedF.el.style.display = (LocalState.view === "weekly") ? "" : "none";
}

/* ---------------------------------------------------------------- *
 * Re-render everything that depends on filter state
 * ---------------------------------------------------------------- */
function rerender() {
  // Determine mode: rank if any selected platform is rank-based, otherwise volume.
  const rankMode = LocalState.platforms.some(p => RANK_PLATFORMS.has(p));

  // Mode notice.
  const notice = document.getElementById("search-mode-notice");
  if (rankMode) {
    notice.innerHTML = `<strong>Rank mode (Amazon)</strong> — lower numbers are better. Movement arrows show rank changes.`;
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
  return aggregateDaily({ range, platforms, rankMode });
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

  // Filter rows: platform, week, branded.
  const platSet = new Set(platforms);
  const brandedFilter = branded;
  const filtered = allRows.filter(r =>
    platSet.has(r.platform) &&
    weekNumSet.has(r.week_num) &&
    (brandedFilter === "both" || (r.branded_bucket || "Generic").toLowerCase() === brandedFilter)
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

function aggregateDaily({ range, platforms, rankMode }) {
  const allRows = State.data.daily_sfr;
  if (!Array.isArray(allRows)) return emptyAgg();

  const platSet = new Set(platforms);
  const filtered = allRows.filter(r => {
    if (!platSet.has(r.platform)) return false;
    if (range.from && r.date < range.from) return false;
    if (range.to   && r.date > range.to)   return false;
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
  // If that period is mid-range, the table shows the 5 leading up to it.
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

  // The visible window for table columns: last 5 periods ending at latest.
  const visibleEnd = latestIdx >= 0 ? latestIdx + 1 : periodLabels.length;
  const visiblePeriods = periodLabels.slice(Math.max(0, visibleEnd - 5), visibleEnd);

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

  // Sort keywords by latest period value (ascending for rank, descending for volume).
  // Keywords missing in latest period go last.
  const arr = [...byKeyword.values()];
  arr.sort((a, b) => {
    const av = a.latestValue, bv = b.latestValue;
    if (av == null && bv == null) return a.keyword.localeCompare(b.keyword);
    if (av == null) return 1;
    if (bv == null) return -1;
    return rankMode ? (av - bv) : (bv - av);
  });

  return {
    periods: periodLabels,
    visiblePeriods,
    periodMeta,
    latestPeriod, prevPeriod,
    byKeyword,
    keywordsSortedForLatest: arr.map(e => e.keyword),
    sortedEntries: arr,
  };
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
 * Top-10 table
 * ---------------------------------------------------------------- */
function renderTopTable(agg, rankMode) {
  const thead = document.querySelector("#search-top-tbl thead");
  const tbody = document.querySelector("#search-top-tbl tbody");

  if (!agg.sortedEntries.length || !agg.latestPeriod) {
    thead.innerHTML = "";
    tbody.innerHTML = `<tr><td class="empty-state">No keyword data in the selected range. Adjust filters above.</td></tr>`;
    return;
  }

  const showPeriods = agg.visiblePeriods;        // 5 periods ending at latest-with-data
  const isWeekly = (LocalState.view === "weekly");

  let head = `<tr><th class="rank">#</th><th>Keyword</th><th>Category</th>`;
  for (const p of showPeriods) {
    const isLatest = (p === agg.latestPeriod);
    const meta = agg.periodMeta.get(p);
    const tip = meta?.range_display ? ` title="${escapeHtml(meta.range_display)}"` : "";
    const label = isLatest ? `${p} (latest)` : p;
    head += `<th class="num"${tip}>${escapeHtml(label)}</th>`;
  }
  head += `<th class="num">Movement</th></tr>`;
  thead.innerHTML = head;

  const top10 = agg.sortedEntries.slice(0, 10);
  tbody.innerHTML = top10.map((e, i) => rowHtml(e, i + 1, showPeriods, rankMode)).join("");
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
    renderTrend(LocalState._agg, LocalState.platforms.some(p => RANK_PLATFORMS.has(p)));
  });
}

/* ---------------------------------------------------------------- *
 * Trend chart
 * ---------------------------------------------------------------- */
function renderTrend(agg, rankMode) {
  const canvas = document.getElementById("search-trend-canvas");
  if (!canvas) return;
  if (!agg.periods.length || LocalState.selectedKeywords.length === 0) {
    destroyChart(canvas);
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

  renderLineChart(canvas, {
    labels: agg.periods,
    series,
    yReverse: rankMode,
    yFormat: "int",
    yTitle: rankMode ? "Search rank (lower = better)" : "Search volume",
  });
}

/* ---------------------------------------------------------------- *
 * Full-list modal
 * ---------------------------------------------------------------- */
function openModal() {
  const agg = LocalState._agg;
  const rankMode = LocalState.platforms.some(p => RANK_PLATFORMS.has(p));
  if (!agg || !agg.latestPeriod) {
    toast("No data to show.");
    return;
  }
  const thead = document.querySelector("#search-full-tbl thead");
  const tbody = document.querySelector("#search-full-tbl tbody");
  const showPeriods = agg.visiblePeriods;

  let head = `<tr><th class="rank">#</th><th>Keyword</th><th>Category</th>`;
  for (const p of showPeriods) {
    const isLatest = (p === agg.latestPeriod);
    const meta = agg.periodMeta.get(p);
    const tip = meta?.range_display ? ` title="${escapeHtml(meta.range_display)}"` : "";
    head += `<th class="num"${tip}>${escapeHtml(isLatest ? p + " (latest)" : p)}</th>`;
  }
  head += `<th class="num">Movement</th></tr>`;
  thead.innerHTML = head;

  tbody.innerHTML = agg.sortedEntries
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
  return {
    "Tab": "Search Movement",
    "View": LocalState.view === "weekly" ? "Weekly" : "Daily",
    "Mode": rankMode ? "Rank (Amazon, lower = better)" : "Volume (higher = better)",
    "Date range": `${LocalState.range.from || "—"} to ${LocalState.range.to || "—"}`,
    "Platforms": LocalState.platforms,
    "Keyword type filter": LocalState.view === "weekly" ? LocalState.branded : "n/a (daily)",
    "Generated at": new Date().toISOString(),
  };
}

function topTableColumnsAndRows(limit) {
  const agg = LocalState._agg;
  if (!agg) return { columns: [], rows: [] };
  const showPeriods = agg.visiblePeriods;
  const columns = [
    { key: "rank", label: "#" },
    { key: "keyword", label: "Keyword" },
    { key: "category", label: "Category" },
    { key: "subcategory", label: "Sub-category" },
    ...showPeriods.map(p => ({ key: `p_${p}`, label: p === agg.latestPeriod ? `${p} (latest)` : p })),
    { key: "movement", label: "Movement" },
  ];
  const entries = limit ? agg.sortedEntries.slice(0, limit) : agg.sortedEntries;
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
  const rankMode = LocalState.platforms.some(p => RANK_PLATFORMS.has(p));
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
  const rankMode = LocalState.platforms.some(p => RANK_PLATFORMS.has(p));
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
  const rankMode = LocalState.platforms.some(p => RANK_PLATFORMS.has(p));
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
      (LocalState.branded === "both" || (r.branded_bucket || "Generic").toLowerCase() === LocalState.branded)
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
    (!range.to   || r.date <= range.to)
  );
  return { name, columns: cols, rows };
}

function ts() {
  const d = new Date();
  const pad = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
