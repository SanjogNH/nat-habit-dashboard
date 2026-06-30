/**
 * dashboard.js — main bootstrap.
 *
 * Responsibilities for Milestone 2:
 *   - Gate the page on sessionStorage auth.
 *   - Load data/dashboard_data.json, resolve any _external sentinel files
 *     lazily (sales.json etc. only fetched when their tab is opened).
 *   - Tab routing (desktop + mobile drawer).
 *   - Logout, refresh button stub, toast helper.
 *
 * Later milestones import from this module for shared state.
 */

import { toast, formatRelativeRefresh } from "./util.js";
import { renderSearchTab,      reset as resetSearch }      from "./tab-search.js";
import { renderBusinessTab,    reset as resetBusiness }    from "./tab-business.js";
import { renderSpendTab,       reset as resetSpend }       from "./tab-spend.js";
import { renderImpressionsTab, reset as resetImpressions } from "./tab-impressions.js";
import { renderInfluencerTab,  reset as resetInfluencer }  from "./tab-influencer.js";
import { fetchAndBuild } from "./calculate.js";

/* ---------------------------------------------------------------- *
 * Auth gate
 * ---------------------------------------------------------------- */
if (sessionStorage.getItem("nh_authed") !== "true") {
  location.replace("index.html");
}

/* ---------------------------------------------------------------- *
 * App state — single shared object other modules will import.
 * ---------------------------------------------------------------- */
export const State = {
  // The main payload from dashboard_data.json. Heavy arrays may be sentinels
  // until lazy-loaded; resolve via loadTab(name).
  data: null,
  // Cache of already-loaded external arrays, keyed by tab name.
  externalCache: {},
  // Active tab.
  currentTab: "search",
  // 'committed' = last committed JSON; 'live' = after a Refresh.
  lastUpdatedSource: "committed",
};

/* ---------------------------------------------------------------- *
 * DOM refs
 * ---------------------------------------------------------------- */
const $ = (id) => document.getElementById(id);
const els = {
  bootLoading: $("boot-loading"),
  bootError: $("boot-error"),
  bootErrMsg: $("boot-err-msg"),
  bootRetry: $("boot-retry"),
  main: $("main"),
  lastUpdated: $("last-updated"),
  lastUpdatedM: $("last-updated-m"),
  refreshBtn: $("refresh-btn"),
  refreshBtnM: $("refresh-btn-m"),
  logoutBtn: $("logout-btn"),
  logoutBtnM: $("logout-btn-m"),
  hamburger: $("hamburger"),
  mobileMenu: $("mobile-menu"),
  tabsDesktop: document.querySelectorAll("#primary-tabs .tab"),
  tabsMobile: document.querySelectorAll("#mobile-menu .m-tab"),
  panels: document.querySelectorAll(".tab-panel"),
};

/* ---------------------------------------------------------------- *
 * Data loading
 * ---------------------------------------------------------------- */
const MAIN_JSON = "data/dashboard_data.json";

/** Fetch the main payload with a cache-buster so refreshes pick up new commits. */
async function loadMainPayload() {
  const url = `${MAIN_JSON}?t=${Date.now()}`;
  const resp = await fetch(url, { cache: "no-store" });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} loading ${MAIN_JSON}`);
  return await resp.json();
}

/**
 * Resolve a tab's row array. If the payload field is the `_external` sentinel
 * (split-file mode), fetch the side file once and cache it. Otherwise return
 * the inline array.
 *
 * Crucially, when an `_external` sentinel is resolved, we also REPLACE
 * `State.data[tabKey]` with the resolved array. This means callers that touch
 * `State.data.weekly_sfr` directly (with the historical `|| []` pattern) won't
 * crash on a non-iterable object — by the time renderers run, every tab key
 * is guaranteed to be either an array (possibly empty) or undefined.
 *
 * @param {string} tabKey  one of: daily_sfr, weekly_sfr, weekly_catalogue,
 *                                  sales, bcg_spend, influencer
 * @returns {Promise<Array<object>>}
 */
export async function loadTab(tabKey) {
  if (State.externalCache[tabKey]) return State.externalCache[tabKey];
  const field = State.data?.[tabKey];
  if (Array.isArray(field)) {
    State.externalCache[tabKey] = field;
    return field;
  }
  if (field && typeof field === "object" && field._external) {
    const url = `data/${field._external}?t=${Date.now()}`;
    const resp = await fetch(url, { cache: "no-store" });
    if (!resp.ok) throw new Error(`HTTP ${resp.status} loading ${url}`);
    const arr = await resp.json();
    State.externalCache[tabKey] = arr;
    State.data[tabKey] = arr;            // overwrite the sentinel in-place
    return arr;
  }
  // Missing entirely — return empty so callers can render an empty state.
  // Also normalize State.data[tabKey] to [] so downstream `|| []` patterns
  // never run for-of on a stray object.
  if (State.data) State.data[tabKey] = [];
  return [];
}

/**
 * Synchronous accessor for tab row arrays. Always returns an array. Safe to
 * call after boot() has finished, regardless of whether the payload uses
 * inline arrays or _external sentinels.
 *
 * Prefer this in NEW code over the historical `State.data.<key> || []`
 * pattern, which crashes when `<key>` is a sentinel object rather than an
 * array. The old pattern is now also safe because `loadTab` overwrites
 * sentinels with arrays, but `getRows` is the canonical way going forward.
 */
export function getRows(tabKey) {
  const v = State.data?.[tabKey];
  if (Array.isArray(v)) return v;
  const cached = State.externalCache?.[tabKey];
  if (Array.isArray(cached)) return cached;
  return [];
}

/* Tab keys whose payload fields may be inline arrays OR _external sentinels.
 * Pre-resolved during boot so direct iteration in tab modules never throws.
 * NOTE: `sales` is intentionally excluded — it's huge and stays lazy (the
 * Business tab awaits its own loadTab("sales") on first render). */
const PRELOAD_TAB_KEYS = [
  "weekly_sfr", "daily_sfr", "weekly_catalogue", "bcg_spend", "influencer",
];

/** Resolve every preload tab whose field is a sentinel. No-op for inline arrays. */
async function preloadSentinels() {
  if (!State.data) return;
  const jobs = [];
  for (const k of PRELOAD_TAB_KEYS) {
    const f = State.data[k];
    if (f && !Array.isArray(f) && typeof f === "object" && f._external) {
      jobs.push(
        loadTab(k).catch(e => {
          console.warn(`[nh] preload of ${k} failed:`, e);
          // Force a safe empty array so downstream code doesn't trip.
          State.data[k] = [];
        })
      );
    } else if (!Array.isArray(f) && f != null) {
      // Defensive: any non-array, non-sentinel field gets normalized to [].
      console.warn(`[nh] unexpected shape for ${k}, coercing to [].`);
      State.data[k] = [];
    }
  }
  if (jobs.length) await Promise.all(jobs);
}

/* ---------------------------------------------------------------- *
 * Boot sequence
 * ---------------------------------------------------------------- */
async function boot() {
  els.bootError.hidden = true;
  els.bootLoading.hidden = false;
  els.main.hidden = true;

  try {
    State.data = await loadMainPayload();
    State.externalCache = {};            // wipe lazy cache on every boot
    State.lastUpdatedSource = "committed";
    // Resolve any _external sentinels in the main payload BEFORE any tab
    // module touches State.data. Without this step, the synchronous
    // `for (const r of State.data.weekly_sfr || [])` patterns in tab modules
    // throw "object is not iterable" when the field is a sentinel object.
    await preloadSentinels();
    updateLastUpdated();
    renderActiveTab();
    els.bootLoading.hidden = true;
    els.main.hidden = false;
  } catch (err) {
    console.error("Boot failed:", err);
    els.bootErrMsg.textContent =
      `${err.message}. Check that data/dashboard_data.json exists and the site is being served over HTTP, not file://.`;
    els.bootLoading.hidden = true;
    els.bootError.hidden = false;
  }
}

/* ---------------------------------------------------------------- *
 * Header timestamp
 * ---------------------------------------------------------------- */
function updateLastUpdated() {
  const md = State.data?.metadata;
  let text;
  if (!md) text = "—";
  else if (State.lastUpdatedSource === "live") text = "Updated: just now (live)";
  else text = `Updated: ${md.last_updated_display}`;
  els.lastUpdated.textContent = text;
  if (els.lastUpdatedM) els.lastUpdatedM.textContent = text;
  if (md) els.lastUpdated.title = `ISO: ${md.last_updated_iso}`;
}

/* ---------------------------------------------------------------- *
 * Tab routing
 * ---------------------------------------------------------------- */
function setActiveTab(tabKey) {
  State.currentTab = tabKey;

  els.tabsDesktop.forEach(b => {
    const active = b.dataset.tab === tabKey;
    b.classList.toggle("is-active", active);
    b.setAttribute("aria-selected", active ? "true" : "false");
  });
  els.tabsMobile.forEach(b => {
    b.classList.toggle("is-active", b.dataset.tab === tabKey);
  });
  els.panels.forEach(p => {
    const match = p.id === `tab-${tabKey}`;
    p.hidden = !match;
    p.classList.toggle("is-active", match);
  });

  // Close mobile drawer after a pick.
  closeMobileMenu();
  renderActiveTab();
}

/** Each tab's render entry point. Milestones 3+ replace these stubs. */
function renderActiveTab() {
  const renderers = {
    search:      renderSearchTab,
    impressions: renderImpressionsTab,
    business:    renderBusinessTab,
    spend:       renderSpendTab,
    influencer:  renderInfluencerTab,
  };
  (renderers[State.currentTab] || (() => {}))();
}

/* ---------------------------------------------------------------- *
 * Refresh — live fetch from Google Sheets via gviz CSV.
 *
 * Falls back to re-pulling the committed JSON if the live fetch fails
 * (e.g., sheet is private, no network, bad sheet ID).
 * ---------------------------------------------------------------- */
async function onRefresh() {
  els.refreshBtn.classList.add("is-busy");
  const originalLabel = els.refreshBtn.querySelector(".refresh-label")?.textContent;
  const setLabel = (s) => {
    const el = els.refreshBtn.querySelector(".refresh-label");
    if (el) el.textContent = s;
  };

  const sheetId = State.data?.metadata?.sheet_id;
  if (!sheetId) {
    // Old JSON without sheet_id — fall back to re-pulling the committed file.
    try { await boot(); toast("Reloaded committed data"); }
    catch (err) { toast(`Refresh failed: ${err.message}`); }
    els.refreshBtn.classList.remove("is-busy");
    if (originalLabel) setLabel(originalLabel);
    return;
  }

  setLabel("0/6");
  try {
    const payload = await fetchAndBuild(sheetId, ({ done, total }) => {
      setLabel(`${done}/${total}`);
    });
    State.data = payload;
    State.externalCache = {};                  // bust the lazy-load cache
    State.lastUpdatedSource = "live";
    // Live-built payloads come from fetchAndBuild as inline arrays already
    // (no _external sentinels), but run the pass anyway for parity with boot
    // — cheap and keeps the invariant uniform.
    await preloadSentinels();
    updateLastUpdated();
    // Force a hard rebuild of every tab so per-tab module state
    // (filter selections, cached aggregations) refreshes against new data.
    _forceTabRebuild();
    // Clear filter-bar DOM so the tab's first render after reset() will
    // recreate its filter widgets cleanly.
    for (const id of ["filters-search", "filters-impressions",
                      "filters-business", "filters-spend", "filters-influencer"]) {
      const el = document.getElementById(id);
      if (el) el.innerHTML = "";
    }
    renderActiveTab();
    toast("Refreshed live from Google Sheet");
  } catch (err) {
    console.error("Live refresh failed:", err);
    toast(`Live refresh failed: ${err.message}. Reloading committed data…`);
    try { await boot(); }
    catch (e2) { toast(`Fallback failed too: ${e2.message}`); }
  } finally {
    els.refreshBtn.classList.remove("is-busy");
    if (originalLabel) setLabel(originalLabel);
  }
}

/**
 * Force every tab to rebuild on next render. Called after live refresh so
 * filter-bar option lists pick up new platforms / categories / SKUs from
 * the fresh payload.
 */
function _forceTabRebuild() {
  resetSearch();
  resetBusiness();
  resetSpend();
  resetImpressions();
  resetInfluencer();
}

/* ---------------------------------------------------------------- *
 * Logout
 * ---------------------------------------------------------------- */
function logout() {
  sessionStorage.removeItem("nh_authed");
  location.replace("index.html");
}

/* ---------------------------------------------------------------- *
 * Mobile menu
 * ---------------------------------------------------------------- */
function openMobileMenu() {
  els.mobileMenu.hidden = false;
  els.mobileMenu.classList.add("is-open");
  els.hamburger.setAttribute("aria-expanded", "true");
}
function closeMobileMenu() {
  els.mobileMenu.classList.remove("is-open");
  els.mobileMenu.hidden = true;
  els.hamburger.setAttribute("aria-expanded", "false");
}
function toggleMobileMenu() {
  if (els.mobileMenu.classList.contains("is-open")) closeMobileMenu();
  else openMobileMenu();
}

/* ---------------------------------------------------------------- *
 * Wire it up
 * ---------------------------------------------------------------- */
els.bootRetry.addEventListener("click", boot);
els.refreshBtn.addEventListener("click", onRefresh);
els.refreshBtnM?.addEventListener("click", () => { closeMobileMenu(); onRefresh(); });
els.logoutBtn.addEventListener("click", logout);
els.logoutBtnM.addEventListener("click", logout);
els.hamburger.addEventListener("click", toggleMobileMenu);
els.tabsDesktop.forEach(b => b.addEventListener("click", () => setActiveTab(b.dataset.tab)));
els.tabsMobile.forEach(b => {
  if (b.id === "logout-btn-m" || b.id === "refresh-btn-m") return;
  b.addEventListener("click", () => setActiveTab(b.dataset.tab));
});

// Re-expose for debugging in the console.
window.NH = { State, loadTab, getRows };

// Wrap boot in DOMContentLoaded as a safety net against fast post-login
// redirects where the module may begin executing before the full DOM is
// painted. ES modules are deferred by spec, but the extra guard costs nothing.
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
