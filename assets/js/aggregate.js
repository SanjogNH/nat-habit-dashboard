/**
 * aggregate.js — shared time bucketing helpers for tab modules.
 *
 * Pure functions only. No DOM, no global state.
 */

import { escapeHtml, fmtInt } from "./util.js";

export const WEEK_ANCHOR_MS = Date.UTC(2025, 11, 28);   // Sun Dec 28, 2025 = Week 1
export const DAY_MS = 86400 * 1000;
export const MONTH_ABBR = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/**
 * Map a date (ISO yyyy-mm-dd) to a period key for the chosen granularity.
 *   daily   → 'yyyy-mm-dd'
 *   weekly  → 'yyyy-mm-dd' (Sunday of that week)
 *   monthly → 'yyyy-mm'
 */
export function bucketKey(dateISO, gran) {
  if (gran === "daily") return dateISO;
  if (gran === "monthly") return dateISO.slice(0, 7);
  const d = new Date(dateISO + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - d.getUTCDay());
  return d.toISOString().slice(0, 10);
}

/**
 * Enumerate every period (in chronological order) fully contained in
 * [fromISO, toISO] at the chosen granularity.
 *
 * Spec §4.2: weeks and months that fall partially outside the range are
 * dropped — they'd otherwise produce misleading deltas.
 *
 * @returns {Array<{key:string, label:string}>}
 */
export function enumeratePeriods(fromISO, toISO, gran) {
  if (!fromISO || !toISO) return [];
  const start = new Date(fromISO + "T00:00:00Z");
  const end = new Date(toISO + "T00:00:00Z");
  const out = [];

  if (gran === "daily") {
    const cur = new Date(start);
    while (cur <= end) {
      out.push({ key: cur.toISOString().slice(0, 10), label: fmtDayLabel(cur) });
      cur.setUTCDate(cur.getUTCDate() + 1);
    }
    return out;
  }

  if (gran === "monthly") {
    const firstMonthStart = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
    const cur = (firstMonthStart.getTime() < start.getTime())
      ? new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1))
      : new Date(firstMonthStart);
    while (true) {
      const monthEnd = new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth() + 1, 0));
      if (monthEnd > end) break;
      out.push({
        key: `${cur.getUTCFullYear()}-${String(cur.getUTCMonth() + 1).padStart(2, "0")}`,
        label: `${MONTH_ABBR[cur.getUTCMonth()]} '${String(cur.getUTCFullYear()).slice(-2)}`,
      });
      cur.setUTCMonth(cur.getUTCMonth() + 1);
    }
    return out;
  }

  // Weekly — first Sunday >= start; stop when week-end would exceed `end`.
  const sun = new Date(start);
  const startDow = sun.getUTCDay();
  if (startDow !== 0) sun.setUTCDate(sun.getUTCDate() + (7 - startDow));
  while (true) {
    const wend = new Date(sun);
    wend.setUTCDate(wend.getUTCDate() + 6);
    if (wend > end) break;
    const wnum = Math.round((sun.getTime() - WEEK_ANCHOR_MS) / (7 * DAY_MS)) + 1;
    out.push({
      key: sun.toISOString().slice(0, 10),
      label: `W${wnum} · ${fmtShort(sun)}–${fmtShort(wend)}`,
    });
    sun.setUTCDate(sun.getUTCDate() + 7);
  }
  return out;
}

export function fmtDayLabel(d) {
  return `${String(d.getUTCDate()).padStart(2, "0")} ${MONTH_ABBR[d.getUTCMonth()]}`;
}
export function fmtShort(d) {
  return `${String(d.getUTCDate()).padStart(2, "0")} ${MONTH_ABBR[d.getUTCMonth()]}`;
}

/**
 * Walk an array of nullable numeric values from the right. Returns the index
 * of the most recent non-null entry, or -1 if there are none.
 */
export function lastIndexWithData(arr) {
  for (let i = arr.length - 1; i >= 0; i--) if (arr[i] != null) return i;
  return -1;
}
export function findPrevWithData(arr, idx) {
  for (let i = idx - 1; i >= 0; i--) if (arr[i] != null) return i;
  return -1;
}

/** Plural-aware label for granularity. */
export function pluralize(gran, n) {
  if (gran === "daily")   return n === 1 ? "day"   : "days";
  if (gran === "weekly")  return n === 1 ? "week"  : "weeks";
  if (gran === "monthly") return n === 1 ? "month" : "months";
  return "period(s)";
}

/** Render a delta pill given a percentage value. */
export function deltaPill(pct) {
  if (pct == null) return `<span class="pill pill--flat">—</span>`;
  if (Math.abs(pct) < 0.05) return `<span class="pill pill--flat">→ 0.0%</span>`;
  const cls = pct > 0 ? "pill--up" : "pill--down";
  const sign = pct > 0 ? "↑" : "↓";
  return `<span class="pill ${cls}">${sign} ${Math.abs(pct).toFixed(1)}%</span>`;
}

/** Filename-safe timestamp for downloads. */
export function tsForFilename() {
  const d = new Date();
  const pad = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
