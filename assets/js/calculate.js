/**
 * calculate.js — JS port of the Python pipeline (calculate.py + fetch_data.py).
 *
 * Used by the Live Refresh button on the dashboard. Fetches the six Google
 * Sheet tabs via the gviz CSV endpoint, parses, normalizes, and builds the
 * same payload shape that the GitHub Action commits to data/dashboard_data.json.
 *
 * Pure JS — no external deps. CSV parser is RFC 4180-ish (quoted fields,
 * escaped quotes, embedded commas and newlines).
 *
 * Stable contract: buildPayloadFromCsvMap(csvMap, sheetId) returns the same
 * dict shape Python writes, so dashboard.js can drop it into State.data and
 * tabs render unchanged.
 */

/* ---------------------------------------------------------------- *
 * Constants — kept in sync with config.py
 * ---------------------------------------------------------------- */
export const TABS = {
  daily_sfr:         "Daily SFR",
  weekly_sfr:        "Weekly SFR Movement",
  weekly_catalogue:  "Weekly Catalogue Performance",
  sales:             "Sales Data",
  bcg_spend:         "BCG Data",
  influencer:        "Influencer Data",
};
export const TAB_ORDER = Object.keys(TABS);

const WEEK1_ANCHOR_ISO = "2025-12-28";
const WEEK1_MS = Date.UTC(2025, 11, 28);
const DAY_MS = 86400 * 1000;
const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30);
const BRANDED_TOKENS = new Set(["brand", "branded"]);
const MONTH_ABBR = ["Jan","Feb","Mar","Apr","May","Jun",
                    "Jul","Aug","Sep","Oct","Nov","Dec"];

/* ================================================================ *
 * 1. CSV parser
 * ================================================================ */

/**
 * Parse a CSV body into an array of row objects keyed by header.
 * Empty trailing fields preserved. Treats blank rows as separators.
 *
 * @param {string} text
 * @returns {Array<object>}
 */
export function parseCSV(text) {
  if (text == null) return [];
  // Strip UTF-8 BOM if present.
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const rows = [];
  let cur = "";
  let inQuote = false;
  let row = [];

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuote) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cur += '"'; i++; }     // escaped quote
        else inQuote = false;
      } else {
        cur += ch;
      }
      continue;
    }
    if (ch === '"') { inQuote = true; continue; }
    if (ch === ',') { row.push(cur); cur = ""; continue; }
    if (ch === '\r') {
      if (text[i + 1] === '\n') i++;   // CRLF → consume the LF too
      row.push(cur); cur = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
      continue;
    }
    if (ch === '\n') {
      row.push(cur); cur = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
      continue;
    }
    cur += ch;
  }
  // Last field / row.
  if (cur !== "" || row.length > 0) {
    row.push(cur);
    if (row.length > 1 || row[0] !== "") rows.push(row);
  }
  if (!rows.length) return [];

  const headers = rows[0].map(h => String(h || "").trim());
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (r.every(c => String(c).trim() === "")) continue;
    const obj = {};
    for (let j = 0; j < headers.length; j++) obj[headers[j]] = r[j] != null ? r[j] : "";
    out.push(obj);
  }
  return out;
}

/* ================================================================ *
 * 2. Type normalization helpers
 * ================================================================ */

/**
 * Parse a value into ISO YYYY-MM-DD or null.
 * Accepts ISO strings, DD/MM/YYYY, DD-MM-YYYY, Excel serial ints, and JS Dates.
 */
export function parseDate(value) {
  if (value == null) return null;
  if (value instanceof Date) {
    return isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  }
  const s = String(value).trim();
  if (!s) return null;

  // ISO yyyy-mm-dd
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

  // ISO with timestamp
  const isoTs = s.match(/^(\d{4}-\d{2}-\d{2})[T ]/);
  if (isoTs) return isoTs[1];

  // DD/MM/YYYY or DD-MM-YYYY (day-first)
  const m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (m) {
    const dd = +m[1], mm = +m[2];
    let yy = +m[3];
    if (yy < 100) yy = 2000 + yy;
    if (mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31) {
      return `${yy}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
    }
  }

  // Excel serial number (sane range — guards against years being parsed as serials)
  const num = Number(s);
  if (isFinite(num) && num > 20000 && num < 80000 && Number.isInteger(Math.floor(num))) {
    const d = new Date(EXCEL_EPOCH_MS + Math.floor(num) * DAY_MS);
    if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }

  // Last resort: native Date parsing (handles "Jun 17 2026" etc).
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return null;
}

/**
 * Coerce to number. Strips ₹, %, commas. Blanks/garbage return null (not 0).
 */
export function toNum(value) {
  if (value == null || value === "") return null;
  if (typeof value === "number") return isFinite(value) ? value : null;
  const cleaned = String(value)
    .replace(/,/g, "")
    .replace(/\u20b9/g, "")   // ₹
    .replace(/%/g, "")
    .trim();
  if (!cleaned) return null;
  const low = cleaned.toLowerCase();
  if (low === "nan" || low === "none" || low === "null") return null;
  const n = parseFloat(cleaned);
  return isFinite(n) ? n : null;
}

/**
 * Map a "Search Query Type" or "Keyword Type" value to "Branded" or "Generic".
 * Anything not in BRANDED_TOKENS — including null, blank, "Comp", "Generic" —
 * is Generic. Source-tag-only classifier — used by BCG which has no keyword
 * column. For keyword-aware tabs (Weekly SFR), use classifyBranded.
 */
export function toBrandedBucket(value) {
  if (value == null) return "Generic";
  const s = String(value).trim().toLowerCase();
  return BRANDED_TOKENS.has(s) ? "Branded" : "Generic";
}

/** Tokens that mark a keyword as Branded by its text alone. */
const BRAND_NAME_TOKENS = ["nat habit", "nathabit"];

/**
 * Branded if EITHER:
 *   - source tag is in BRANDED_TOKENS, OR
 *   - keyword text contains "nat habit" or "nathabit" (case-insensitive).
 * Otherwise Generic. Mirror of calculate.py::classify_branded.
 */
export function classifyBranded(keyword, sourceTag) {
  if (sourceTag != null) {
    const s = String(sourceTag).trim().toLowerCase();
    if (BRANDED_TOKENS.has(s)) return "Branded";
  }
  if (keyword != null) {
    const kwLc = String(keyword).toLowerCase();
    for (const tok of BRAND_NAME_TOKENS) {
      if (kwLc.includes(tok)) return "Branded";
    }
  }
  return "Generic";
}

/** Parse a "Week23" string into 23. */
export function weekNumFromLabel(label) {
  if (!label) return null;
  const m = String(label).match(/^\s*Week\s*(\d+)\s*$/i);
  return m ? parseInt(m[1], 10) : null;
}

/** Sunday on or before the given ISO date. */
export function sundayOfISO(dateISO) {
  if (!dateISO) return null;
  const d = new Date(dateISO + "T00:00:00Z");
  if (isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() - d.getUTCDay());
  return d.toISOString().slice(0, 10);
}

/** Week number for an ISO date (W1 = the week containing WEEK1_ANCHOR_ISO). */
export function weekNumFromDate(dateISO) {
  const sun = sundayOfISO(dateISO);
  if (!sun) return null;
  const ms = new Date(sun + "T00:00:00Z").getTime();
  return Math.round((ms - WEEK1_MS) / (7 * DAY_MS)) + 1;
}

/** Build the metadata.weeks entry for a given week number. */
export function weekMetaFromNum(n) {
  if (n == null || n < 1) return null;
  const startMs = WEEK1_MS + (n - 1) * 7 * DAY_MS;
  const start = new Date(startMs);
  const end = new Date(startMs + 6 * DAY_MS);
  const fmtDay = d => `${String(d.getUTCDate()).padStart(2, "0")} ${MONTH_ABBR[d.getUTCMonth()]}`;
  return {
    week_num: n,
    label: `Week${n}`,
    start: start.toISOString().slice(0, 10),
    end: end.toISOString().slice(0, 10),
    range_display: `${fmtDay(start)} – ${fmtDay(end)} '${String(end.getUTCFullYear()).slice(-2)}`,
  };
}

/* ================================================================ *
 * 3. Column normalization
 * ================================================================ */

const SUBCAT_VARIANTS = ["Subcategory", "Sub-Category", "Sub Category",
                         "SubCategory", "Sub-category"];

/** Pick a value from a row using the first matching key. */
function rowGet(row, ...keys) {
  for (const k of keys) {
    if (row[k] !== undefined) return row[k];
  }
  return null;
}

/** Strip + null-coerce a cell. */
function clean(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

function platformOf(row) {
  return clean(rowGet(row, "Channel", "Platform"));
}
function subcategoryOf(row) {
  return clean(rowGet(row, ...SUBCAT_VARIANTS));
}

/* ================================================================ *
 * 4. Per-tab processors — mirrors calculate.py exactly
 *    Each returns {rows: out, raw: filteredRows}. raw is kept around
 *    so metadata aggregation can use it without re-walking the JSON.
 * ================================================================ */

function processDailySfr(raw) {
  const out = [];
  for (const r of raw) {
    const platform = platformOf(r);
    const date = parseDate(rowGet(r, "Date"));
    if (!platform || !date) continue;
    let rank = toNum(rowGet(r, "Search Frequency Rank"));
    if (rank != null && rank <= 0) rank = null;       // Amazon sentinel
    out.push({
      platform, date,
      keyword:     clean(rowGet(r, "Search Term")),
      category:    clean(rowGet(r, "Category")),
      subcategory: subcategoryOf(r),
      rank,
    });
  }
  return out;
}

function processWeeklySfr(raw) {
  const out = [];
  for (const r of raw) {
    const platform = platformOf(r);
    const week_num = weekNumFromLabel(rowGet(r, "Week"));
    if (!platform || week_num == null) continue;
    let rank = toNum(rowGet(r, "Search Frequency Rank"));
    if (rank != null && rank <= 0) rank = null;
    out.push({
      platform, week_num,
      search_query:  clean(rowGet(r, "Search Query")),
      branded_bucket: classifyBranded(
        rowGet(r, "Search Query"),
        rowGet(r, "Search Query Type")
      ),
      category:      clean(rowGet(r, "Category")),
      subcategory:   subcategoryOf(r),
      rank,
      volume:        toNum(rowGet(r, "Search Query Volume")),
      impressions:   toNum(rowGet(r, "Impressions: Total Count")),
      brand_impression_share_pct: toNum(rowGet(r, "Impressions: Brand Share %")),
      clicks:        toNum(rowGet(r, "Clicks: Total Count")),
      brand_click_share_pct:      toNum(rowGet(r, "Clicks: Brand Share %")),
    });
  }
  return out;
}

function processWeeklyCatalogue(raw) {
  const out = [];
  for (const r of raw) {
    const platform = platformOf(r);
    const week_num = weekNumFromLabel(rowGet(r, "Week"));
    if (!platform || week_num == null) continue;
    out.push({
      platform, week_num,
      short_code:  clean(rowGet(r, "Short Code")),
      nh_sku:      clean(rowGet(r, "NH SKU")),
      category:    clean(rowGet(r, "Category")),
      subcategory: subcategoryOf(r),
      impressions: toNum(rowGet(r, "Impressions: Impressions")),
    });
  }
  return out;
}

function processSales(raw) {
  const out = [];
  for (const r of raw) {
    const platform = platformOf(r);
    const date = parseDate(rowGet(r, "Date"));
    if (!platform || !date) continue;
    out.push({
      platform, date,
      nh_sku:      clean(rowGet(r, "NH SKU")),
      category:    clean(rowGet(r, "Category")),
      subcategory: subcategoryOf(r),
      glance_views: toNum(rowGet(r, "Glance Views")),
      gross_units:  toNum(rowGet(r, "Gross Units")),
      revenue:      toNum(rowGet(r, "Revenue")),
    });
  }
  return out;
}

function processBcgSpend(raw) {
  const out = [];
  for (const r of raw) {
    const platform = platformOf(r);
    const date = parseDate(rowGet(r, "Date"));
    if (!platform || !date) continue;
    // Bucket source can be "Keyword Type" (BCG) or "Search Query Type" (legacy fallback).
    const bucketSrc = rowGet(r, "Keyword Type") ?? rowGet(r, "Search Query Type");
    out.push({
      platform, date,
      category:      clean(rowGet(r, "Category")),
      subcategory:   subcategoryOf(r),
      branded_bucket: toBrandedBucket(bucketSrc),
      marketing_channel: clean(rowGet(r, "Marketing Channel")),
      spend: toNum(rowGet(r, "Spend")),
      sales: toNum(rowGet(r, "Sales")),
    });
  }
  return out;
}

function processInfluencer(raw) {
  const out = [];
  for (const r of raw) {
    const date = parseDate(rowGet(r, "Date"));
    if (!date) continue;
    out.push({
      date,
      influencer_name: clean(rowGet(r, "Influencer Name")),
      category:        clean(rowGet(r, "Category")),
      ad_name:         clean(rowGet(r, "Ad Name")),
      views:    toNum(rowGet(r, "Views")),
      likes:    toNum(rowGet(r, "Likes")),
      comments: toNum(rowGet(r, "Comments")),
      shares:   toNum(rowGet(r, "Shares")),
    });
  }
  return out;
}

const PROCESSORS = {
  daily_sfr:         processDailySfr,
  weekly_sfr:        processWeeklySfr,
  weekly_catalogue:  processWeeklyCatalogue,
  sales:             processSales,
  bcg_spend:         processBcgSpend,
  influencer:        processInfluencer,
};

/* ================================================================ *
 * 5. Metadata aggregation
 * ================================================================ */

function platformSortKey(p) {
  if (p === "Amazon") return [0, ""];
  return [1, String(p || "").toLowerCase()];
}

function collectPlatforms(rowsByTab) {
  const found = new Set();
  for (const rows of Object.values(rowsByTab)) {
    for (const r of rows) if (r.platform) found.add(r.platform);
  }
  return [...found].sort((a, b) => {
    const [ka, sa] = platformSortKey(a);
    const [kb, sb] = platformSortKey(b);
    return ka - kb || sa.localeCompare(sb);
  });
}

function collectCategoryTree(rowsByTab) {
  const pairs = new Set();    // "cat|sub" strings
  for (const rows of Object.values(rowsByTab)) {
    for (const r of rows) {
      if (!r.category) continue;
      pairs.add(`${r.category}|${r.subcategory || ""}`);
    }
  }
  const tree = {};
  for (const p of pairs) {
    const [c, s] = p.split("|");
    if (!tree[c]) tree[c] = [];
    if (s && !tree[c].includes(s)) tree[c].push(s);
  }
  const cats = Object.keys(tree).sort();
  for (const c of cats) tree[c].sort();
  return { cats, tree };
}

function collectDateRange(rowsByTab) {
  let min = null, max = null;
  for (const rows of Object.values(rowsByTab)) {
    for (const r of rows) {
      if (!r.date) continue;
      if (min === null || r.date < min) min = r.date;
      if (max === null || r.date > max) max = r.date;
    }
  }
  return { min, max };
}

function collectWeeks(rowsByTab) {
  const nums = new Set();
  for (const rows of Object.values(rowsByTab)) {
    for (const r of rows) {
      if (r.week_num != null) nums.add(r.week_num);
      else if (r.date) {
        const wn = weekNumFromDate(r.date);
        if (wn != null) nums.add(wn);
      }
    }
  }
  return [...nums].sort((a, b) => a - b).map(weekMetaFromNum).filter(Boolean);
}

/* ================================================================ *
 * 6. Top-level payload builder
 * ================================================================ */

/**
 * Build a complete payload from a map of raw CSV row arrays.
 * @param {Object<string, Array<object>>} rawByTab  e.g. {daily_sfr: [...], ...}
 * @param {string} sheetId
 * @returns {object} payload matching the Python pipeline output
 */
/**
 * Add a `branded_bucket` field to each row in dailyRows. Daily SFR doesn't
 * carry a Search Query Type column; we classify by looking the keyword up
 * in weekly SFR (case-insensitive), with a deterministic fallback for the
 * rare case where a daily keyword isn't in the weekly data.
 *
 * Mirror of calculate.py::_enrich_daily_branded so live refresh produces
 * the same classification as the scheduled commit.
 */
function enrichDailyBranded(dailyRows, weeklyRows) {
  // Set of keyword (lowercased) that weekly has already classified as Branded.
  const weeklyBranded = new Set();
  for (const r of weeklyRows) {
    if (r.search_query && r.branded_bucket === "Branded") {
      weeklyBranded.add(r.search_query.trim().toLowerCase());
    }
  }
  for (const r of dailyRows) {
    const kw = (r.keyword || "").trim();
    if (!kw) { r.branded_bucket = "Generic"; continue; }
    // Substring rule first (keyword-only classification).
    const byRule = classifyBranded(kw, null);
    if (byRule === "Branded") {
      r.branded_bucket = "Branded";
      continue;
    }
    // Otherwise inherit from weekly if classified Branded there.
    r.branded_bucket = weeklyBranded.has(kw.toLowerCase()) ? "Branded" : "Generic";
  }
}

export function buildPayloadFromRows(rawByTab, sheetId) {
  const rowsByTab = {};
  const rowCounts = {};
  for (const key of TAB_ORDER) {
    const fn = PROCESSORS[key];
    const raw = rawByTab[key] || [];
    const out = fn(raw);
    rowsByTab[key] = out;
    rowCounts[key] = out.length;
  }
  // Enrich daily SFR rows with branded_bucket derived from weekly classifications.
  enrichDailyBranded(rowsByTab.daily_sfr, rowsByTab.weekly_sfr);

  const platforms = collectPlatforms(rowsByTab);
  const { cats, tree } = collectCategoryTree(rowsByTab);
  const dateRange = collectDateRange(rowsByTab);
  const weeks = collectWeeks(rowsByTab);

  // IST timestamp (UTC+5:30) — match Python output for consistency.
  const nowMs = Date.now();
  const ist = new Date(nowMs + (5 * 60 + 30) * 60 * 1000);
  const pad = n => String(n).padStart(2, "0");
  const last_updated_iso =
    `${ist.getUTCFullYear()}-${pad(ist.getUTCMonth() + 1)}-${pad(ist.getUTCDate())}T` +
    `${pad(ist.getUTCHours())}:${pad(ist.getUTCMinutes())}:${pad(ist.getUTCSeconds())}+05:30`;
  let hour = ist.getUTCHours();
  const ampm = hour >= 12 ? "PM" : "AM";
  hour = hour % 12; if (hour === 0) hour = 12;
  const last_updated_display = `${ist.getUTCDate()} ${MONTH_ABBR[ist.getUTCMonth()]} ${ist.getUTCFullYear()}, ${hour}:${pad(ist.getUTCMinutes())} ${ampm} IST`;
  const preview = sheetId.length > 10
    ? `${sheetId.slice(0, 4)}...${sheetId.slice(-4)}`
    : sheetId;

  const metadata = {
    last_updated_iso,
    last_updated_display,
    sheet_id: sheetId,
    sheet_id_preview: preview,
    row_counts: rowCounts,
    date_range: dateRange,
    platforms,
    categories: cats,
    subcategories_by_category: tree,
  };

  return { metadata, weeks, ...rowsByTab };
}

/**
 * Convenience: take a map of CSV-text bodies and produce a payload.
 */
export function buildPayloadFromCsvMap(csvByTab, sheetId) {
  const rawByTab = {};
  for (const key of TAB_ORDER) {
    rawByTab[key] = parseCSV(csvByTab[key] || "");
  }
  return buildPayloadFromRows(rawByTab, sheetId);
}

/* ================================================================ *
 * 7. Live fetcher (Google Sheets gviz CSV endpoint)
 * ================================================================ */

/**
 * Build the gviz CSV URL for a given sheet ID and tab name.
 * Sheet must be shared "Anyone with the link can view".
 */
export function gvizCsvUrl(sheetId, tabName) {
  return `https://docs.google.com/spreadsheets/d/${encodeURIComponent(sheetId)}/gviz/tq` +
         `?tqx=out:csv&sheet=${encodeURIComponent(tabName)}`;
}

/**
 * Fetch and parse a single sheet tab. Returns parsed row objects.
 *
 * @throws if HTTP fails (bad sheet ID, private sheet, network).
 */
export async function fetchSheetTab(sheetId, tabName) {
  const url = gvizCsvUrl(sheetId, tabName);
  const resp = await fetch(url, { cache: "no-store" });
  if (!resp.ok) {
    throw new Error(`Sheet tab "${tabName}" returned HTTP ${resp.status}. ` +
                    `Verify the sheet is shared "Anyone with the link can view".`);
  }
  const text = await resp.text();
  return parseCSV(text);
}

/**
 * Fetch all configured tabs in parallel and assemble a payload.
 *
 * @param {string} sheetId
 * @param {(progress: {done:number, total:number, tab:string}) => void} [onProgress]
 * @returns {Promise<object>} full payload
 */
export async function fetchAndBuild(sheetId, onProgress) {
  if (!sheetId) throw new Error("Sheet ID is missing from metadata. Cannot refresh live.");
  const keys = TAB_ORDER;
  let done = 0;
  const rawByTab = {};
  // Fetch in parallel but still report progress per tab.
  await Promise.all(keys.map(async (k) => {
    rawByTab[k] = await fetchSheetTab(sheetId, TABS[k]);
    done++;
    if (onProgress) onProgress({ done, total: keys.length, tab: TABS[k] });
  }));
  return buildPayloadFromRows(rawByTab, sheetId);
}
