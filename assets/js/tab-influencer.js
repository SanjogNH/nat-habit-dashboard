/**
 * tab-influencer.js — Influencer tab.
 *
 * Spec §5.5. Three logical sections:
 *
 *   A. Campaign performance — chart + table pair per metric:
 *      Views / Likes / Comments / Shares.
 *
 *   B. Campaign list table — every campaign in the filtered date range
 *      with influencer, category, ad name, date, the four counts, and a
 *      computed Pre/Post Lift (7 days before vs 7 days after the campaign
 *      date, on impressions and revenue for the campaign's category).
 *
 *   C. Correlation overlay — two charts:
 *        1. Category-aggregated impressions across the date range, weekly.
 *        2. Search keyword trend (top keywords in the filtered categories).
 *      Both charts have vertical markers at every campaign date in the
 *      selected categories. Hover the marker → influencer + ad + views.
 *
 * Influencer Data is at daily, cross-platform granularity. There's no
 * platform field, so the platform multi-select is intentionally absent.
 *
 * Pre/Post Lift caveat: impressions are weekly in the source, so the
 * 7-day windows around a campaign approximate by counting the most recent
 * weekly buckets. Sales is daily and exact.
 */

import { State, loadTab } from "./dashboard.js";
import {
  createDateRange, createMultiSelect,
  renderChipsAcrossTab, buildDateChip, buildMultiSelectChip,
} from "./filters.js";
import { renderLineChart, destroyChart, PALETTE } from "./charts.js";
import { downloadCSV, downloadXLSX, filterContextSheet } from "./downloads.js";
import { escapeHtml, fmtInt, fmtINR, pctChange, toast , makeTableCollapsible, syncTableCollapseLabels, wireTableToggleAll } from "./util.js";
import {
  enumeratePeriods, pluralize, deltaPill, tsForFilename,
  lastIndexWithData, findPrevWithData,
} from "./aggregate.js";

/* ---------------------------------------------------------------- *
 * Constants
 * ---------------------------------------------------------------- */
const CAMPAIGN_METRICS = [
  { key: "views",    label: "Views",    fmt: fmtInt, yFormat: "int" },
  { key: "likes",    label: "Likes",    fmt: fmtInt, yFormat: "int" },
  { key: "comments", label: "Comments", fmt: fmtInt, yFormat: "int" },
  { key: "shares",   label: "Shares",   fmt: fmtInt, yFormat: "int" },
];

const TOP_KEYWORDS_FOR_OVERLAY = 6;
const MARKER_COLOR = "#BD5A35";  // terracotta dashed verticals

/* ---------------------------------------------------------------- *
 * Module-local state
 * ---------------------------------------------------------------- */
const LocalState = {
  range: { from: "", to: "" },
  categories: [],
  influencers: [],     // chosen influencer names; empty = all
  campaigns: [],       // chosen ad names; empty = all
  salesRows: null,
  filters: null,
  _aggCampaigns: null, // per-day rollup for campaign performance
  _campaignList: null, // list of campaigns in range with lifts
  _aggOverlay: null,   // {weeks, impByWeek, kwSeries, markers}
};

let _built = false;

/** Reset module state (called by Live Refresh to force a rebuild). */
export function reset() {
  _built = false;
}
let _markerPluginRegistered = false;

/* ---------------------------------------------------------------- *
 * Public entry
 * ---------------------------------------------------------------- */
export async function renderInfluencerTab() {
  const root = document.getElementById("content-influencer");
  if (!root || !State.data) return;
  if (!_built) {
    _built = true;
    registerMarkerPlugin();
    buildSkeleton(root);
    buildFilters();
  }
  // Lazy-load sales.json if we have campaigns to compute lifts against.
  const haveCampaigns = (State.data.influencer || []).length > 0;
  if (haveCampaigns && LocalState.salesRows == null) {
    try { LocalState.salesRows = await loadTab("sales"); }
    catch (err) { console.warn("Influencer: sales not loaded —", err.message); }
  }
  rerender();
}

/* ---------------------------------------------------------------- *
 * Skeleton
 * ---------------------------------------------------------------- */
function buildSkeleton(root) {
  const campaignCards = CAMPAIGN_METRICS.map(m => `
    <section class="section-card" data-metric="${m.key}">
      <header class="section-head">
        <h2 class="section-title">${m.label}
          <span class="section-meta" id="inf-${m.key}-kpi"></span>
        </h2>
        <div class="section-actions">
          <span class="section-meta" id="inf-${m.key}-meta"></span>
          <button class="icon-btn" data-dl="csv" data-metric="${m.key}">CSV</button>
          <button class="icon-btn" data-dl="xlsx" data-metric="${m.key}">Excel</button>
        </div>
      </header>
      <div class="chart-box"><canvas id="inf-${m.key}-canvas"></canvas></div>
      <div class="tbl-wrap is-scroll-y">
        <table class="data-tbl" id="inf-${m.key}-tbl">
          <thead></thead><tbody></tbody>
        </table>
      </div>
    </section>
  `).join("");

  root.innerHTML = `
    <div id="inf-empty-banner" class="mode-notice" hidden>
      <div>
        <strong>No influencer campaigns in this dataset yet.</strong>
        Once campaigns are logged in the Influencer Data sheet, performance
        metrics, Pre/Post Lift, and correlation markers will populate here.
      </div>
    </div>

    <h3 class="tab-section-head">Campaign performance</h3>
    ${campaignCards}

    <h3 class="tab-section-head">Campaign list</h3>
    <section class="section-card" data-metric="campaign-list">
      <header class="section-head">
        <h2 class="section-title">Campaigns in range
          <span class="section-meta" id="inf-list-kpi"></span>
        </h2>
        <div class="section-actions">
          <button class="icon-btn" data-dl="csv" data-metric="campaign-list">CSV</button>
          <button class="icon-btn" data-dl="xlsx" data-metric="campaign-list">Excel</button>
        </div>
      </header>
      <div class="tbl-wrap is-scroll-y" style="max-height: 540px;">
        <table class="data-tbl" id="inf-list-tbl">
          <thead></thead><tbody></tbody>
        </table>
      </div>
      <p style="margin-top: 12px; font-size: var(--fs-xs); color: var(--brand-muted-2);">
        Pre/Post Lift = (sum 7 days after campaign date) – (sum 7 days before),
        for the campaign's category. Sales lift is exact daily; impressions
        lift approximates using weekly buckets.
      </p>
    </section>

    <h3 class="tab-section-head">Category correlation</h3>
    <section class="section-card">
      <header class="section-head">
        <h2 class="section-title">Impressions by week
          <span class="section-meta" id="inf-overlay-imp-kpi"></span>
        </h2>
        <div class="section-actions">
          <span class="section-meta" id="inf-overlay-imp-meta"></span>
        </div>
      </header>
      <div class="chart-box is-tall"><canvas id="inf-overlay-imp-canvas"></canvas></div>
    </section>
    <section class="section-card">
      <header class="section-head">
        <h2 class="section-title">Search trend by week
          <span class="section-meta" id="inf-overlay-kw-kpi"></span>
        </h2>
        <div class="section-actions">
          <span class="section-meta" id="inf-overlay-kw-meta"></span>
        </div>
      </header>
      <div class="chart-box is-tall"><canvas id="inf-overlay-kw-canvas"></canvas></div>
    </section>
  `;

  root.querySelectorAll("[data-dl]").forEach(btn => {
    btn.addEventListener("click", () => {
      downloadMetric(btn.dataset.metric, btn.dataset.dl);
    });
  });

  // Collapse the 4 campaign-metric tables by default; keep the campaign-list
  // table always visible since it's the headline content of the tab.
  root.querySelectorAll('.section-card:not([data-metric="campaign-list"]) > .tbl-wrap')
      .forEach(el => makeTableCollapsible(el));
}

/* ---------------------------------------------------------------- *
 * Filter bar
 *
 * No platform filter — Influencer Data has no platform field. Categories
 * drive the correlation join; influencer + campaign multi-selects refine
 * the campaign performance and list sections.
 * ---------------------------------------------------------------- */
function buildFilters() {
  const bar = document.getElementById("filters-influencer");
  if (!bar) return;
  bar.innerHTML = "";

  const md = State.data.metadata;
  const dr = md.date_range || {};
  const infRows = State.data.influencer || [];

  const dateF = createDateRange({
    id: "inf.range",
    minDate: dr.min,
    maxDate: dr.max,
    defaultDays: 90,
  });
  bar.appendChild(dateF.el);

  // Categories — from union of influencer + weekly_sfr (since correlation
  // needs categories that exist in both worlds).
  const catSet = new Set();
  for (const r of infRows)                     if (r.category) catSet.add(r.category);
  for (const r of State.data.weekly_sfr || []) if (r.category) catSet.add(r.category);
  const catOptions = [...catSet].sort().map(c => ({ value: c, label: c }));
  const catsF = createMultiSelect({
    id: "inf.categories",
    label: "Categories",
    options: catOptions,
    defaultSelected: catOptions.map(o => o.value),
    allowAll: true,
  });
  bar.appendChild(catsF.el);

  // Influencers — from influencer table only.
  const infSet = new Set();
  for (const r of infRows) if (r.influencer_name) infSet.add(r.influencer_name);
  const infOptions = [...infSet].sort().map(n => ({ value: n, label: n }));
  const infF = createMultiSelect({
    id: "inf.influencers",
    label: "Influencers",
    options: infOptions,
    defaultSelected: infOptions.length ? infOptions.map(o => o.value) : [],
    allowAll: true,
    searchable: true,
  });
  bar.appendChild(infF.el);

  // Campaigns (ad names).
  const adSet = new Set();
  for (const r of infRows) if (r.ad_name) adSet.add(r.ad_name);
  const adOptions = [...adSet].sort().map(n => ({ value: n, label: n }));
  const adF = createMultiSelect({
    id: "inf.campaigns",
    label: "Campaigns",
    options: adOptions,
    defaultSelected: adOptions.length ? adOptions.map(o => o.value) : [],
    allowAll: true,
    searchable: true,
  });
  bar.appendChild(adF.el);

  const toggleBtn = document.createElement("button");
  toggleBtn.className = "fl-tbl-toggle";
  toggleBtn.textContent = "Show all tables";
  bar.appendChild(toggleBtn);
  wireTableToggleAll(toggleBtn, document.getElementById("content-influencer"));

  LocalState.filters = { dateF, catsF, infF, adF };
  syncFromFilters();
  dateF.onChange(() => { syncFromFilters(); rerender(); });
  catsF.onChange(() => { syncFromFilters(); rerender(); });
  infF.onChange (() => { syncFromFilters(); rerender(); });
  adF.onChange  (() => { syncFromFilters(); rerender(); });
}

function syncFromFilters() {
  const { dateF, catsF, infF, adF } = LocalState.filters;
  LocalState.range       = dateF.getRange();
  LocalState.categories  = catsF.getSelected();
  LocalState.influencers = infF.getSelected();
  LocalState.campaigns   = adF.getSelected();
}

/* ---------------------------------------------------------------- *
 * Vertical-markers Chart.js plugin
 *
 * Reads `options.plugins.verticalMarkers.markers = [{label, info}]`.
 * Draws dashed verticals at each label's x position.
 * ---------------------------------------------------------------- */
function registerMarkerPlugin() {
  if (_markerPluginRegistered || typeof window.Chart === "undefined") return;
  _markerPluginRegistered = true;
  Chart.register({
    id: "verticalMarkers",
    afterDatasetsDraw(chart) {
      const opts = chart.options.plugins?.verticalMarkers;
      const markers = opts?.markers;
      if (!markers || !markers.length) return;
      const ctx = chart.ctx;
      const xScale = chart.scales.x;
      const yArea = chart.chartArea;
      ctx.save();
      for (const m of markers) {
        const i = chart.data.labels.indexOf(m.label);
        if (i < 0) continue;
        const x = xScale.getPixelForValue(i);
        ctx.strokeStyle = m.color || MARKER_COLOR;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(x, yArea.top);
        ctx.lineTo(x, yArea.bottom);
        ctx.stroke();
        // Small terracotta circle at top of the line.
        ctx.setLineDash([]);
        ctx.fillStyle = m.color || MARKER_COLOR;
        ctx.beginPath();
        ctx.arc(x, yArea.top + 4, 3, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    },
  });
}

/* ---------------------------------------------------------------- *
 * Aggregations
 * ---------------------------------------------------------------- */
function rerender() {
  const banner = document.getElementById("inf-empty-banner");
  banner.hidden = (State.data.influencer || []).length > 0;

  // Filter campaigns first.
  const campaigns = filteredCampaigns();

  // (A) Campaign performance — daily rollup of the four metrics.
  const campaignAgg = aggregateCampaignDaily(campaigns);
  LocalState._aggCampaigns = campaignAgg;
  for (const m of CAMPAIGN_METRICS) renderCampaignPanel(m, campaignAgg);

  // (B) Campaign list with Pre/Post Lift.
  const list = buildCampaignListWithLift(campaigns);
  LocalState._campaignList = list;
  renderCampaignList(list);

  // (C) Correlation overlay charts.
  const overlay = aggregateOverlay(campaigns);
  LocalState._aggOverlay = overlay;
  renderOverlayImpressions(overlay);
  renderOverlaySearch(overlay);

  syncTableCollapseLabels(document.getElementById("content-influencer"));
  // Active-filter chips above each table.
  renderChipsAcrossTab(document.getElementById("content-influencer"), buildChips());
}

/* ---------------------------------------------------------------- *
 * Active-filter chip spec
 * ---------------------------------------------------------------- */
function buildChips() {
  const chips = [];
  if (!LocalState.filters) return chips;
  const { dateF, catsF, infF, adF } = LocalState.filters;

  const dateChip = buildDateChip(dateF);
  if (dateChip) chips.push(dateChip);

  // Categories — "all" is the union of categories across influencer + weekly_sfr,
  // mirroring the option list built in buildFilters.
  const catSet = new Set();
  for (const r of (State.data?.influencer || [])) if (r.category) catSet.add(r.category);
  for (const r of (State.data?.weekly_sfr || [])) if (r.category) catSet.add(r.category);
  const allCats = [...catSet].sort();
  const catChip = buildMultiSelectChip(catsF, "Categories",
    () => allCats, { resetTo: allCats });
  if (catChip) chips.push(catChip);

  // Influencers.
  const infSet = new Set();
  for (const r of (State.data?.influencer || [])) if (r.influencer_name) infSet.add(r.influencer_name);
  const allInf = [...infSet].sort();
  const infChip = buildMultiSelectChip(infF, "Influencers",
    () => allInf, { resetTo: allInf });
  if (infChip) chips.push(infChip);

  // Campaigns (ad names).
  const adSet = new Set();
  for (const r of (State.data?.influencer || [])) if (r.ad_name) adSet.add(r.ad_name);
  const allAds = [...adSet].sort();
  const adChip = buildMultiSelectChip(adF, "Campaigns",
    () => allAds, { resetTo: allAds });
  if (adChip) chips.push(adChip);

  return chips;
}

/** Subset of influencer rows passing date + category + influencer + campaign filters. */
function filteredCampaigns() {
  const { range, categories, influencers, campaigns: ads } = LocalState;
  const catSet = new Set(categories);
  const infSet = new Set(influencers);
  const adSet  = new Set(ads);
  return (State.data.influencer || []).filter(r => {
    if (range.from && r.date < range.from) return false;
    if (range.to   && r.date > range.to)   return false;
    if (catSet.size && r.category   && !catSet.has(r.category))         return false;
    if (infSet.size && r.influencer_name && !infSet.has(r.influencer_name)) return false;
    if (adSet.size  && r.ad_name    && !adSet.has(r.ad_name))           return false;
    return true;
  });
}

/* (A) Per-day rollup of views/likes/comments/shares. */
function aggregateCampaignDaily(rows) {
  const { range } = LocalState;
  const periodList = enumeratePeriods(range.from, range.to, "daily");
  const map = new Map(periodList.map(p => [p.key, {
    key: p.key, label: p.label,
    views: null, likes: null, comments: null, shares: null,
    hasData: false,
  }]));
  for (const r of rows) {
    const e = map.get(r.date);
    if (!e) continue;
    if (!e.hasData) {
      e.views = 0; e.likes = 0; e.comments = 0; e.shares = 0;
      e.hasData = true;
    }
    e.views    += +r.views || 0;
    e.likes    += +r.likes || 0;
    e.comments += +r.comments || 0;
    e.shares   += +r.shares || 0;
  }
  return { periods: periodList.map(p => map.get(p.key)), rawRowCount: rows.length };
}

/* (B) Build campaign list with Pre/Post Lift per row. */
function buildCampaignListWithLift(rows) {
  // Build per-category daily sales index once for cheap repeated lookups.
  const sales = LocalState.salesRows || [];
  const dailySalesByCat = new Map();     // 'CATEGORY|YYYY-MM-DD' -> revenue
  for (const s of sales) {
    const k = `${s.category}|${s.date}`;
    dailySalesByCat.set(k, (dailySalesByCat.get(k) || 0) + (+s.revenue || 0));
  }

  // Build per-category weekly impressions index from weekly_sfr.
  const weeklyImpByCat = new Map();      // 'CATEGORY|week_num' -> impressions
  for (const r of State.data.weekly_sfr || []) {
    const k = `${r.category}|${r.week_num}`;
    weeklyImpByCat.set(k, (weeklyImpByCat.get(k) || 0) + (+r.impressions || 0));
  }
  const weekByNum = new Map((State.data.weeks || []).map(w => [w.week_num, w]));

  return rows.map(r => {
    const lift = computeLift(r, dailySalesByCat, weeklyImpByCat, weekByNum);
    return { ...r, ...lift };
  });
}

function computeLift(campaign, dailySalesByCat, weeklyImpByCat, weekByNum) {
  const out = {
    sales_pre: null, sales_post: null, sales_lift_pct: null,
    imp_pre: null,   imp_post: null,   imp_lift_pct: null,
  };
  if (!campaign.date || !campaign.category) return out;

  // 7-day windows around the campaign date.
  // Window-before = (date-7) … (date-1).
  // Window-after  = (date+1) … (date+7).
  const d = new Date(campaign.date + "T00:00:00Z");
  const addDays = (n) => {
    const x = new Date(d); x.setUTCDate(x.getUTCDate() + n);
    return x.toISOString().slice(0, 10);
  };

  // --- Sales (daily granularity, exact) ---
  let preS = 0, postS = 0;
  for (let i = -7; i <= -1; i++) preS  += dailySalesByCat.get(`${campaign.category}|${addDays(i)}`) || 0;
  for (let i =  1; i <=  7; i++) postS += dailySalesByCat.get(`${campaign.category}|${addDays(i)}`) || 0;
  out.sales_pre = preS;
  out.sales_post = postS;
  out.sales_lift_pct = preS > 0 ? ((postS - preS) / preS) * 100 : null;

  // --- Impressions (weekly, approximate) ---
  // For each day in window, attribute (weekly_imp / 7) to that day.
  const dailyImpForCat = (dateISO) => {
    const day = new Date(dateISO + "T00:00:00Z");
    const dow = day.getUTCDay();
    day.setUTCDate(day.getUTCDate() - dow);    // Sunday of that week
    const sundayISO = day.toISOString().slice(0, 10);
    // find week_num
    for (const w of State.data.weeks || []) {
      if (w.start === sundayISO) {
        return (weeklyImpByCat.get(`${campaign.category}|${w.week_num}`) || 0) / 7;
      }
    }
    return 0;
  };
  let preI = 0, postI = 0;
  for (let i = -7; i <= -1; i++) preI  += dailyImpForCat(addDays(i));
  for (let i =  1; i <=  7; i++) postI += dailyImpForCat(addDays(i));
  out.imp_pre = preI;
  out.imp_post = postI;
  out.imp_lift_pct = preI > 0 ? ((postI - preI) / preI) * 100 : null;

  return out;
}

/* (C) Overlay aggregation — weekly impressions per category + top-N keywords. */
function aggregateOverlay(campaigns) {
  const weeks = (State.data.weeks || []).filter(w => {
    if (LocalState.range.from && w.start < LocalState.range.from) return false;
    if (LocalState.range.to   && w.end   > LocalState.range.to)   return false;
    return true;
  });
  const weekByNum = new Map(weeks.map(w => [w.week_num, w]));
  const catSet = new Set(LocalState.categories);

  // Impressions per week, summed across selected categories.
  const impByWeek = new Map();
  for (const r of State.data.weekly_sfr || []) {
    if (catSet.size && !catSet.has(r.category)) continue;
    if (!weekByNum.has(r.week_num)) continue;
    impByWeek.set(r.week_num, (impByWeek.get(r.week_num) || 0) + (+r.impressions || 0));
  }

  // Search trend: pick top-N keywords (by volume in range) in selected categories.
  const kwTotals = new Map();
  for (const r of State.data.weekly_sfr || []) {
    if (catSet.size && !catSet.has(r.category)) continue;
    if (!weekByNum.has(r.week_num)) continue;
    const v = +r.volume || 0;
    kwTotals.set(r.search_query, (kwTotals.get(r.search_query) || 0) + v);
  }
  const topKws = [...kwTotals.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_KEYWORDS_FOR_OVERLAY)
    .map(([k]) => k);

  const kwByWeek = new Map();   // kw -> Map<week_num, volume>
  for (const r of State.data.weekly_sfr || []) {
    if (catSet.size && !catSet.has(r.category)) continue;
    if (!weekByNum.has(r.week_num)) continue;
    if (!topKws.includes(r.search_query)) continue;
    let m = kwByWeek.get(r.search_query);
    if (!m) { m = new Map(); kwByWeek.set(r.search_query, m); }
    m.set(r.week_num, (m.get(r.week_num) || 0) + (+r.volume || 0));
  }

  // Markers: campaign dates inside selected categories, mapped to week labels.
  const markers = [];
  for (const c of campaigns) {
    if (!c.date) continue;
    const w = weekContaining(c.date, weeks);
    if (!w) continue;
    markers.push({
      label: w.label,
      info: { date: c.date, influencer: c.influencer_name, ad: c.ad_name, views: c.views },
    });
  }

  return { weeks, impByWeek, topKws, kwByWeek, markers };
}

function weekContaining(dateISO, weeks) {
  for (const w of weeks) {
    if (dateISO >= w.start && dateISO <= w.end) return w;
  }
  return null;
}

/* ---------------------------------------------------------------- *
 * Render — campaign performance per metric
 * ---------------------------------------------------------------- */
function renderCampaignPanel(metric, agg) {
  const canvas = document.getElementById(`inf-${metric.key}-canvas`);
  const thead  = document.querySelector(`#inf-${metric.key}-tbl thead`);
  const tbody  = document.querySelector(`#inf-${metric.key}-tbl tbody`);
  const kpiEl  = document.getElementById(`inf-${metric.key}-kpi`);
  const metaEl = document.getElementById(`inf-${metric.key}-meta`);

  const values = agg.periods.map(p => p[metric.key]);
  const labels = agg.periods.map(p => p.label);

  renderLineChart(canvas, {
    labels, series: [{ label: metric.label, data: values }],
    yFormat: metric.yFormat, yTitle: metric.label,
  });

  const latIdx = lastIndexWithData(values);
  const prevIdx = findPrevWithData(values, latIdx);
  const latestVal = latIdx >= 0 ? values[latIdx] : null;
  const prevVal   = prevIdx >= 0 ? values[prevIdx] : null;
  const delta = pctChange(latestVal, prevVal);
  if (latestVal == null) {
    kpiEl.innerHTML = `<span style="color:var(--brand-muted-2)">No campaigns in range</span>`;
  } else {
    const dpart = delta == null
      ? `<span style="color:var(--brand-muted-2); margin-left:8px;">no prior day</span>`
      : `<span class="${delta > 0 ? "delta-up" : (delta < 0 ? "delta-down" : "")}" style="margin-left:8px;">${
            delta > 0 ? "▲" : (delta < 0 ? "▼" : "→")} ${Math.abs(delta).toFixed(1)}%</span>`;
    kpiEl.innerHTML = `<span class="kpi-val">${metric.fmt(latestVal)}</span>${dpart}`;
  }
  metaEl.textContent = `${agg.periods.length} ${pluralize("daily", agg.periods.length)} · ${agg.rawRowCount} campaign rows`;

  // Table — newest day first.
  thead.innerHTML = `<tr><th>Day</th><th class="num">${escapeHtml(metric.label)}</th><th class="num">Δ vs prev</th></tr>`;
  const rowsHTML = [];
  for (let i = agg.periods.length - 1; i >= 0; i--) {
    const p = agg.periods[i];
    const v = values[i];
    const prev = i > 0 ? values[i - 1] : null;
    rowsHTML.push(`<tr><td><strong>${escapeHtml(p.label)}</strong></td><td class="num mono">${v == null ? "—" : metric.fmt(v)}</td><td class="num">${deltaPill(pctChange(v, prev))}</td></tr>`);
  }
  tbody.innerHTML = rowsHTML.join("") || `<tr><td colspan="3" class="empty-state">No campaign days in range.</td></tr>`;
}

/* ---------------------------------------------------------------- *
 * Render — campaign list
 * ---------------------------------------------------------------- */
function renderCampaignList(list) {
  const thead = document.querySelector("#inf-list-tbl thead");
  const tbody = document.querySelector("#inf-list-tbl tbody");
  const kpiEl = document.getElementById("inf-list-kpi");

  kpiEl.innerHTML = list.length
    ? `<span class="kpi-val">${list.length}</span> <span style="color:var(--brand-muted); font-size:var(--fs-sm); margin-left:4px;">in range</span>`
    : `<span style="color:var(--brand-muted-2)">No campaigns in range</span>`;

  if (!list.length) {
    thead.innerHTML = "";
    tbody.innerHTML = `<tr><td class="empty-state">When campaigns are logged, each row here will include views, likes, comments, shares, and a Pre/Post Lift comparing the 7 days after to the 7 days before, by category.</td></tr>`;
    return;
  }

  thead.innerHTML = `<tr>
    <th>Date</th><th>Influencer</th><th>Ad</th><th>Category</th>
    <th class="num">Views</th><th class="num">Likes</th>
    <th class="num">Comments</th><th class="num">Shares</th>
    <th class="num">Sales lift</th><th class="num">Impressions lift</th>
  </tr>`;
  const sorted = [...list].sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  tbody.innerHTML = sorted.map(r => `
    <tr>
      <td><strong>${escapeHtml(r.date || "—")}</strong></td>
      <td>${escapeHtml(r.influencer_name || "—")}</td>
      <td>${escapeHtml(r.ad_name || "—")}</td>
      <td class="cat-cell">${escapeHtml(r.category || "—")}</td>
      <td class="num mono">${fmtInt(r.views)}</td>
      <td class="num mono">${fmtInt(r.likes)}</td>
      <td class="num mono">${fmtInt(r.comments)}</td>
      <td class="num mono">${fmtInt(r.shares)}</td>
      <td class="num">${liftCell(r.sales_lift_pct, r.sales_pre, r.sales_post, "inr")}</td>
      <td class="num">${liftCell(r.imp_lift_pct, r.imp_pre, r.imp_post, "int")}</td>
    </tr>
  `).join("");
}

function liftCell(pct, pre, post, fmt) {
  if (pre == null || post == null) return `<span class="pill pill--flat">—</span>`;
  const diff = post - pre;
  const fmtV = fmt === "inr" ? fmtINR : fmtInt;
  const pill = deltaPill(pct);
  return `<div style="display:inline-flex; flex-direction:column; align-items:flex-end; gap:2px;">
    <span class="mono">${fmtV(diff)}</span>${pill}
  </div>`;
}

/* ---------------------------------------------------------------- *
 * Render — correlation overlay
 * ---------------------------------------------------------------- */
function renderOverlayImpressions(overlay) {
  const canvas = document.getElementById("inf-overlay-imp-canvas");
  const kpi    = document.getElementById("inf-overlay-imp-kpi");
  const meta   = document.getElementById("inf-overlay-imp-meta");
  if (!overlay.weeks.length) {
    destroyChart(canvas);
    kpi.innerHTML = `<span style="color:var(--brand-muted-2)">No weeks in range</span>`;
    meta.textContent = "";
    return;
  }
  const labels = overlay.weeks.map(w => w.label);
  const values = overlay.weeks.map(w => overlay.impByWeek.get(w.week_num) ?? null);
  renderLineChartWithMarkers(canvas, {
    labels,
    series: [{ label: "Impressions (selected categories)", data: values }],
    yFormat: "int", yTitle: "Impressions",
    markers: overlay.markers,
  });
  const latIdx = lastIndexWithData(values);
  if (latIdx >= 0) {
    kpi.innerHTML = `<span class="kpi-val">${fmtInt(values[latIdx])}</span> <span style="color:var(--brand-muted); font-size:var(--fs-sm); margin-left:4px;">${escapeHtml(overlay.weeks[latIdx].label)}</span>`;
  } else {
    kpi.innerHTML = `<span style="color:var(--brand-muted-2)">No impressions in selected categories</span>`;
  }
  meta.textContent = `${overlay.weeks.length} weeks · ${overlay.markers.length} campaign marker${overlay.markers.length === 1 ? "" : "s"}`;
}

function renderOverlaySearch(overlay) {
  const canvas = document.getElementById("inf-overlay-kw-canvas");
  const kpi    = document.getElementById("inf-overlay-kw-kpi");
  const meta   = document.getElementById("inf-overlay-kw-meta");
  if (!overlay.weeks.length || !overlay.topKws.length) {
    destroyChart(canvas);
    kpi.innerHTML = `<span style="color:var(--brand-muted-2)">No keywords for selected categories</span>`;
    meta.textContent = "";
    return;
  }
  const labels = overlay.weeks.map(w => w.label);
  const series = overlay.topKws.map(kw => ({
    label: kw,
    data: overlay.weeks.map(w => overlay.kwByWeek.get(kw)?.get(w.week_num) ?? null),
  }));
  renderLineChartWithMarkers(canvas, {
    labels, series, yFormat: "int", yTitle: "Search volume",
    markers: overlay.markers,
  });
  kpi.innerHTML = `<span class="kpi-val">${overlay.topKws.length}</span> <span style="color:var(--brand-muted); font-size:var(--fs-sm); margin-left:4px;">top keywords</span>`;
  meta.textContent = `${overlay.weeks.length} weeks · ${overlay.markers.length} campaign marker${overlay.markers.length === 1 ? "" : "s"}`;
}

/**
 * Render a line chart with a vertical-markers overlay. Builds the chart from
 * scratch rather than reusing renderLineChart + update() — the latter
 * recursed inside Chart.js's plugin lifecycle on Chrome and threw stack
 * overflows. By passing markers in the initial config, the plugin sees them
 * on first draw with no second update needed.
 */
function renderLineChartWithMarkers(canvas, { labels, series, yFormat, yTitle, markers }) {
  destroyChart(canvas);
  if (typeof window.Chart === "undefined") return null;

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
    };
  });

  const tickFn = (v) => {
    const abs = Math.abs(v);
    if (yFormat === "inr") {
      if (abs >= 1e7) return `₹${(v / 1e7).toFixed(1)}Cr`;
      if (abs >= 1e5) return `₹${(v / 1e5).toFixed(1)}L`;
      if (abs >= 1000) return `₹${(v / 1000).toFixed(1)}K`;
      return `₹${v}`;
    }
    if (abs >= 1e7) return `${(v / 1e7).toFixed(1)}Cr`;
    if (abs >= 1e5) return `${(v / 1e5).toFixed(1)}L`;
    if (abs >= 1000) return `${(v / 1000).toFixed(1)}K`;
    return Number(v).toLocaleString("en-IN");
  };

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
          labels: { boxWidth: 8, boxHeight: 8, padding: 14,
                    font: { size: 12, weight: 600 }, usePointStyle: true },
        },
        tooltip: {
          backgroundColor: "rgba(31,42,34,0.95)",
          titleColor: "#fff", bodyColor: "#fff",
          padding: 10, cornerRadius: 8, displayColors: true,
          boxPadding: 4, boxWidth: 6, boxHeight: 6,
        },
        // Plugin reads from here on every draw — passed in on first paint.
        verticalMarkers: { markers: markers || [] },
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
}

/* ---------------------------------------------------------------- *
 * Downloads
 * ---------------------------------------------------------------- */
function describeContext() {
  return {
    "Tab": "Influencer",
    "Date range": `${LocalState.range.from || "—"} to ${LocalState.range.to || "—"}`,
    "Categories":  LocalState.categories,
    "Influencers": LocalState.influencers,
    "Campaigns":   LocalState.campaigns,
    "Generated at": new Date().toISOString(),
  };
}

function downloadMetric(metricKey, kind) {
  if (metricKey === "campaign-list") return downloadCampaignList(kind);
  const metric = CAMPAIGN_METRICS.find(m => m.key === metricKey);
  const agg = LocalState._aggCampaigns;
  if (!metric || !agg || !agg.periods.length) { toast("Nothing to download."); return; }

  const cols = [
    { key: "day", label: "Day" },
    { key: "value", label: metric.label },
    { key: "delta", label: "Δ vs prev (%)" },
  ];
  const values = agg.periods.map(p => p[metric.key]);
  const rows = [];
  for (let i = agg.periods.length - 1; i >= 0; i--) {
    const v = values[i];
    const prev = i > 0 ? values[i - 1] : null;
    const dlt = pctChange(v, prev);
    rows.push({
      day: agg.periods[i].label,
      value: v == null ? "" : v,
      delta: dlt == null ? "" : Number(dlt.toFixed(2)),
    });
  }
  const fname = `nat-habit_influencer-${metricKey}_${tsForFilename()}`;
  if (kind === "csv") return downloadCSV(`${fname}.csv`, cols, rows);
  downloadXLSX(`${fname}.xlsx`, [
    { name: metric.label, columns: cols, rows },
    rawCampaignSheet(),
    filterContextSheet("Filter context", describeContext()),
  ]);
}

function downloadCampaignList(kind) {
  const list = LocalState._campaignList || [];
  if (!list.length) { toast("No campaigns to download."); return; }
  const cols = [
    { key: "date",            label: "Date" },
    { key: "influencer_name", label: "Influencer" },
    { key: "ad_name",         label: "Ad" },
    { key: "category",        label: "Category" },
    { key: "views",           label: "Views" },
    { key: "likes",           label: "Likes" },
    { key: "comments",        label: "Comments" },
    { key: "shares",          label: "Shares" },
    { key: "sales_pre",       label: "Sales 7d pre (₹)" },
    { key: "sales_post",      label: "Sales 7d post (₹)" },
    { key: "sales_lift_pct",  label: "Sales lift %" },
    { key: "imp_pre",         label: "Impressions 7d pre (approx)" },
    { key: "imp_post",        label: "Impressions 7d post (approx)" },
    { key: "imp_lift_pct",    label: "Impressions lift %" },
  ];
  const sorted = [...list].sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  const rows = sorted.map(r => {
    const out = { ...r };
    for (const k of ["sales_pre", "sales_post", "imp_pre", "imp_post"]) {
      out[k] = r[k] == null ? "" : Number(Number(r[k]).toFixed(2));
    }
    for (const k of ["sales_lift_pct", "imp_lift_pct"]) {
      out[k] = r[k] == null ? "" : Number(r[k].toFixed(2));
    }
    return out;
  });
  const fname = `nat-habit_influencer-campaigns_${tsForFilename()}`;
  if (kind === "csv") return downloadCSV(`${fname}.csv`, cols, rows);
  downloadXLSX(`${fname}.xlsx`, [
    { name: "Campaign list", columns: cols, rows },
    rawCampaignSheet(),
    filterContextSheet("Filter context", describeContext()),
  ]);
}

function rawCampaignSheet() {
  const { range, categories, influencers, campaigns: ads } = LocalState;
  const catSet = new Set(categories);
  const infSet = new Set(influencers);
  const adSet  = new Set(ads);
  const cols = [
    { key: "date", label: "Date" },
    { key: "influencer_name", label: "Influencer" },
    { key: "ad_name", label: "Ad" },
    { key: "category", label: "Category" },
    { key: "views", label: "Views" },
    { key: "likes", label: "Likes" },
    { key: "comments", label: "Comments" },
    { key: "shares", label: "Shares" },
  ];
  const rows = (State.data.influencer || []).filter(r =>
    (!range.from || r.date >= range.from) &&
    (!range.to   || r.date <= range.to)   &&
    (!catSet.size || (r.category && catSet.has(r.category))) &&
    (!infSet.size || (r.influencer_name && infSet.has(r.influencer_name))) &&
    (!adSet.size  || (r.ad_name && adSet.has(r.ad_name)))
  );
  return { name: "Filtered campaign rows", columns: cols, rows };
}
