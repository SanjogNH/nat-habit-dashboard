/**
 * util.js — formatting and small UI helpers shared across modules.
 *
 * Pure functions only (toast is the one DOM-touching helper). No state.
 */

/** Format an Indian-style integer with comma grouping. */
export function fmtInt(n) {
  if (n == null || isNaN(n)) return "—";
  return Number(n).toLocaleString("en-IN", { maximumFractionDigits: 0 });
}

/** Format a number as INR with Lakh/Crore suffixes for big values. */
export function fmtINR(n) {
  if (n == null || isNaN(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 1e7)  return `₹${(n / 1e7).toFixed(2)} Cr`;
  if (abs >= 1e5)  return `₹${(n / 1e5).toFixed(2)} L`;
  return `₹${Number(n).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
}

/** Format ROAS as `1.85x`. Returns "—" if null/infinite. */
export function fmtROAS(n) {
  if (n == null || !isFinite(n)) return "—";
  return `${Number(n).toFixed(2)}x`;
}

/** Format a percentage. Already a percent value (not a fraction). */
export function fmtPct(n, decimals = 1) {
  if (n == null || !isFinite(n)) return "—";
  return `${Number(n).toFixed(decimals)}%`;
}

/** Percent change for a delta pill. */
export function pctChange(curr, prev) {
  if (prev == null || prev === 0 || curr == null) return null;
  return ((curr - prev) / Math.abs(prev)) * 100;
}

/** Render a "+5.4%" / "−2.1%" / "→ 0.0%" string. */
export function fmtDelta(pct) {
  if (pct == null || !isFinite(pct)) return "—";
  if (Math.abs(pct) < 0.05) return "→ 0.0%";
  const sign = pct > 0 ? "+" : "−";
  return `${sign}${Math.abs(pct).toFixed(1)}%`;
}

/** Escape HTML for safe insertion. */
export function escapeHtml(s) {
  if (s == null) return "";
  return String(s).replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[c]);
}

/** Briefly show a toast at the bottom-right. */
let toastTimer = null;
export function toast(msg) {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = msg;
  el.classList.add("is-visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("is-visible"), 2600);
}

/** Format "just now (live)" or whatever the metadata last_updated_display says. */
export function formatRelativeRefresh(metadata, source) {
  if (!metadata) return "—";
  if (source === "live") return "Updated: just now (live)";
  return `Updated: ${metadata.last_updated_display}`;
}
