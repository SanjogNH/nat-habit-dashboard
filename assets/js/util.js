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

/* ================================================================ *
 * Collapsible table helpers (used by Business, Spend, Impressions,
 * Influencer metric-card tables). Tables default to collapsed so the
 * page doesn't become a wall of rows; user opens what they want to see.
 * ================================================================ */

/**
 * Wrap a `.tbl-wrap` div in a <details>/<summary> for collapse-on-demand.
 * Idempotent — calling twice is a no-op. Returns the <details> element.
 */
export function makeTableCollapsible(tblWrapEl, opts = {}) {
  if (!tblWrapEl) return null;
  if (tblWrapEl.parentElement?.classList.contains("tbl-collapse")) {
    return tblWrapEl.parentElement;
  }
  const { label = "Show table" } = opts;
  const details = document.createElement("details");
  details.className = "tbl-collapse";
  const summary = document.createElement("summary");
  summary.className = "tbl-collapse-summary";
  summary.innerHTML = `<span class="tbl-collapse-chev">▸</span>` +
                      `<span class="tbl-collapse-lbl">${escapeHtml(label)}</span>`;
  const parent = tblWrapEl.parentElement;
  parent.insertBefore(details, tblWrapEl);
  details.appendChild(summary);
  details.appendChild(tblWrapEl);
  details.addEventListener("toggle", () => updateCollapseLabel(details));
  return details;
}

/** Update one details element's summary label based on current state + row count. */
function updateCollapseLabel(details) {
  const lblEl = details.querySelector(".tbl-collapse-lbl");
  if (!lblEl) return;
  if (details.open) { lblEl.textContent = "Hide table"; return; }
  const tbody = details.querySelector("tbody");
  const hasEmptyState = tbody?.querySelector(".empty-state");
  const n = (tbody && !hasEmptyState) ? tbody.children.length : 0;
  lblEl.textContent = n === 0
    ? "Show table"
    : `Show table (${n} row${n === 1 ? "" : "s"})`;
}

/**
 * Refresh labels for every collapsible table under `rootEl`. Call from a
 * tab's rerender after tbody contents change.
 */
export function syncTableCollapseLabels(rootEl) {
  if (!rootEl) return;
  for (const d of rootEl.querySelectorAll("details.tbl-collapse")) {
    updateCollapseLabel(d);
  }
}

/**
 * Wire a "Show all tables / Hide all tables" toggle button to a tab content.
 */
export function wireTableToggleAll(toggleBtnEl, tabContentEl) {
  if (!toggleBtnEl || !tabContentEl) return;
  const updateBtn = () => {
    const all = tabContentEl.querySelectorAll("details.tbl-collapse");
    if (!all.length) { toggleBtnEl.hidden = true; return; }
    toggleBtnEl.hidden = false;
    const allOpen = [...all].every(d => d.open);
    toggleBtnEl.textContent = allOpen ? "Hide all tables" : "Show all tables";
  };
  toggleBtnEl.addEventListener("click", () => {
    const all = tabContentEl.querySelectorAll("details.tbl-collapse");
    if (!all.length) return;
    const anyClosed = [...all].some(d => !d.open);
    all.forEach(d => { d.open = anyClosed; });
    updateBtn();
  });
  // toggle events don't bubble — use capture phase
  tabContentEl.addEventListener("toggle", (e) => {
    if (e.target?.classList?.contains?.("tbl-collapse")) updateBtn();
  }, true);
  setTimeout(updateBtn, 0);
}
