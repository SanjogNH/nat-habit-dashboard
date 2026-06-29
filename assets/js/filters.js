/**
 * filters.js — reusable filter widget factories.
 *
 * All filters persist per session via sessionStorage so users don't lose
 * their state when switching tabs. Each factory returns:
 *   { el, getValue() | getSelected() | getRange(), set..., onChange(fn) }
 *
 * Widgets are intentionally minimal — keyboard-accessible HTML controls in
 * brand-styled containers.
 */

import { escapeHtml } from "./util.js";

/* ---------------------------------------------------------------- *
 * Session persistence
 * ---------------------------------------------------------------- */
export const Persist = {
  get(key, fallback) {
    try {
      const v = sessionStorage.getItem(`nh_filter_${key}`);
      return v == null ? fallback : JSON.parse(v);
    } catch { return fallback; }
  },
  set(key, value) {
    try { sessionStorage.setItem(`nh_filter_${key}`, JSON.stringify(value)); }
    catch { /* quota / disabled — ignore */ }
  },
};

/* ---------------------------------------------------------------- *
 * Date range
 * ---------------------------------------------------------------- */

/**
 * Two side-by-side date inputs. Returns ISO strings (YYYY-MM-DD).
 *
 * @param {object} opts
 * @param {string} opts.id              persistence key
 * @param {string} opts.minDate         ISO bound
 * @param {string} opts.maxDate         ISO bound
 * @param {number} [opts.defaultDays=90]  default lookback in days
 */
export function createDateRange(opts) {
  const { id, minDate, maxDate, defaultDays = 90 } = opts;

  // Compute defaults.
  const max = maxDate;
  const fallback = (() => {
    if (!maxDate) return { from: "", to: "" };
    const d = new Date(maxDate + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() - defaultDays);
    let from = d.toISOString().slice(0, 10);
    if (minDate && from < minDate) from = minDate;
    return { from, to: max };
  })();

  // Restore persisted value, clamped to current data bounds.
  const saved = Persist.get(id, fallback) || fallback;
  let from = clampDate(saved.from || fallback.from, minDate, maxDate);
  let to   = clampDate(saved.to   || fallback.to,   minDate, maxDate);

  const handlers = [];

  const el = document.createElement("div");
  el.className = "fl-group fl-daterange";
  el.innerHTML = `
    <div class="fl-lbl">Date range</div>
    <div class="fl-dr-row">
      <input type="date" class="fl-date" data-which="from" min="${minDate || ""}" max="${maxDate || ""}" value="${from}" aria-label="From">
      <span class="fl-dr-sep" aria-hidden="true">→</span>
      <input type="date" class="fl-date" data-which="to" min="${minDate || ""}" max="${maxDate || ""}" value="${to}" aria-label="To">
    </div>
  `;

  el.querySelectorAll("input.fl-date").forEach(inp => {
    inp.addEventListener("change", () => {
      let f = el.querySelector('[data-which="from"]').value || fallback.from;
      let t = el.querySelector('[data-which="to"]').value || fallback.to;
      // Guard ordering.
      if (f && t && f > t) {
        if (inp.dataset.which === "from") f = t;
        else t = f;
        el.querySelector('[data-which="from"]').value = f;
        el.querySelector('[data-which="to"]').value = t;
      }
      from = f; to = t;
      Persist.set(id, { from, to });
      handlers.forEach(fn => fn({ from, to }));
    });
  });

  return {
    el,
    getRange() { return { from, to }; },
    onChange(fn) { handlers.push(fn); },
  };
}

function clampDate(d, lo, hi) {
  if (!d) return d;
  if (lo && d < lo) return lo;
  if (hi && d > hi) return hi;
  return d;
}

/* ---------------------------------------------------------------- *
 * Segmented control (e.g., granularity toggle)
 * ---------------------------------------------------------------- */

/**
 * @param {object} opts
 * @param {string} opts.id
 * @param {string} opts.label
 * @param {Array<{value, label}>} opts.options
 * @param {string} opts.defaultValue
 */
export function createSegmented(opts) {
  const { id, label, options, defaultValue } = opts;
  let value = Persist.get(id, defaultValue) || defaultValue;
  if (!options.find(o => o.value === value)) value = defaultValue;

  const handlers = [];
  const el = document.createElement("div");
  el.className = "fl-group";
  el.innerHTML = `
    <div class="fl-lbl">${escapeHtml(label)}</div>
    <div class="fl-seg" role="tablist">
      ${options.map(o => `
        <button type="button" role="tab" data-v="${escapeHtml(o.value)}"
                class="${o.value === value ? "is-active" : ""}"
                aria-selected="${o.value === value ? "true" : "false"}">${escapeHtml(o.label)}</button>
      `).join("")}
    </div>
  `;

  el.querySelectorAll("button").forEach(btn => {
    btn.addEventListener("click", () => {
      value = btn.dataset.v;
      el.querySelectorAll("button").forEach(b => {
        const on = b.dataset.v === value;
        b.classList.toggle("is-active", on);
        b.setAttribute("aria-selected", on ? "true" : "false");
      });
      Persist.set(id, value);
      handlers.forEach(fn => fn(value));
    });
  });

  return {
    el,
    getValue() { return value; },
    setValue(v) {
      if (!options.find(o => o.value === v)) return;
      value = v;
      el.querySelectorAll("button").forEach(b => {
        const on = b.dataset.v === value;
        b.classList.toggle("is-active", on);
        b.setAttribute("aria-selected", on ? "true" : "false");
      });
      Persist.set(id, value);
    },
    onChange(fn) { handlers.push(fn); },
  };
}

/* ---------------------------------------------------------------- *
 * Multi-select popover
 *
 * Generic checkbox list inside a trigger button + dropdown.
 * Used for: platforms, keywords, categories, subcategories.
 * ---------------------------------------------------------------- */

/**
 * @param {object} opts
 * @param {string} opts.id
 * @param {string} opts.label
 * @param {Array<{value, label, group?}>} opts.options
 * @param {string[]} [opts.defaultSelected]   defaults to all options
 * @param {boolean} [opts.allowAll=true]      enables the "Select all" action
 * @param {number}  [opts.maxSelected]        cap selections; null = unlimited
 * @param {boolean} [opts.searchable=true]    show a search input at the top
 * @param {string}  [opts.placeholder="Select…"]
 * @param {(value, currentlySelected) => string|null} [opts.validate]
 *     Called whenever the user toggles an item. Returning a string aborts
 *     the toggle and shows that string as a transient warning.
 */
export function createMultiSelect(opts) {
  const {
    id, label,
    defaultSelected = null,
    allowAll = true,
    maxSelected = null,
    searchable = true,
    placeholder = "Select…",
    validate = null,
  } = opts;

  // options + allValues are mutable so setOptions can swap them at runtime
  // (used by Search Movement: the platforms list filters to rank-capable
  // platforms when "View by: Rank" is toggled).
  let options = opts.options.slice();
  let allValues = options.map(o => o.value);
  const initial = defaultSelected || allValues.slice();
  const saved = Persist.get(id, initial);
  // Clamp saved to current options.
  let selected = new Set((saved || initial).filter(v => allValues.includes(v)));
  if (selected.size === 0 && initial.length > 0) selected = new Set(initial);

  const handlers = [];
  let searchText = "";

  const el = document.createElement("div");
  el.className = "fl-group";
  el.innerHTML = `
    <div class="fl-lbl">${escapeHtml(label)}</div>
    <div class="fl-ms-wrap">
      <button type="button" class="fl-ms-trigger" aria-haspopup="true" aria-expanded="false">
        <span class="fl-ms-label"></span>
        <span class="fl-ms-chev" aria-hidden="true">▾</span>
      </button>
      <div class="fl-ms-pop" hidden></div>
      <div class="fl-ms-warn" role="status" aria-live="polite" hidden></div>
    </div>
  `;

  const trigger = el.querySelector(".fl-ms-trigger");
  const pop = el.querySelector(".fl-ms-pop");
  const labelEl = el.querySelector(".fl-ms-label");
  const warnEl = el.querySelector(".fl-ms-warn");

  function updateLabel() {
    if (selected.size === 0) labelEl.textContent = placeholder;
    else if (selected.size === options.length && allowAll) labelEl.textContent = `All ${label.toLowerCase()} (${options.length})`;
    else if (selected.size === 1) labelEl.textContent = options.find(o => o.value === [...selected][0])?.label || "1 selected";
    else labelEl.textContent = `${selected.size} selected`;
  }

  function showWarn(msg) {
    warnEl.textContent = msg;
    warnEl.hidden = false;
    clearTimeout(showWarn._t);
    showWarn._t = setTimeout(() => { warnEl.hidden = true; }, 3500);
  }

  function renderPop() {
    const filtered = searchText
      ? options.filter(o => o.label.toLowerCase().includes(searchText.toLowerCase()))
      : options;

    // Group rendering — group: "Rank-based" / "Volume-based" / undefined
    const groups = new Map();
    for (const o of filtered) {
      const g = o.group || "";
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(o);
    }

    // Sticky header: search box + action buttons.
    // - Select all is shown only when allowAll AND no maxSelected cap.
    // - Clear all is always available.
    const hasSearch = !!searchable;
    const showSelectAll = allowAll && (maxSelected == null);
    let header = "";
    if (hasSearch || showSelectAll || true /* always show Clear */) {
      const selectedCount = selected.size;
      header = `<div class="fl-ms-header">`;
      if (hasSearch) {
        header += `<input type="text" class="fl-ms-searchbox" placeholder="Search…" value="${escapeHtml(searchText)}" autocomplete="off" spellcheck="false">`;
      }
      header += `<div class="fl-ms-actions">`;
      if (showSelectAll) {
        header += `<button type="button" class="fl-ms-act" data-act="all">Select all</button>`;
        header += `<span class="fl-ms-actsep" aria-hidden="true">·</span>`;
      }
      header += `<button type="button" class="fl-ms-act" data-act="clear" ${selectedCount === 0 ? "disabled" : ""}>Clear all</button>`;
      header += `</div></div>`;
      header += `<div class="fl-ms-sep"></div>`;
    }

    let html = header;
    for (const [groupName, items] of groups) {
      if (groupName) {
        html += `<div class="fl-ms-grouphead">${escapeHtml(groupName)}</div>`;
      }
      for (const o of items) {
        const checked = selected.has(o.value);
        html += `<label class="fl-ms-row">
          <input type="checkbox" data-v="${escapeHtml(o.value)}" ${checked ? "checked" : ""}>
          <span>${escapeHtml(o.label)}</span>
        </label>`;
      }
    }
    if (filtered.length === 0) {
      html += `<div class="fl-ms-empty">No matches</div>`;
    }
    pop.innerHTML = html;
    bindPop();
  }

  function bindPop() {
    // Search input — sticky behavior: keep focus + caret on input.
    const s = pop.querySelector(".fl-ms-searchbox");
    if (s) {
      s.addEventListener("input", (e) => {
        searchText = e.target.value;
        const caret = e.target.selectionStart;
        renderPop();
        const ns = pop.querySelector(".fl-ms-searchbox");
        if (ns) { ns.focus(); try { ns.setSelectionRange(caret, caret); } catch {} }
      });
      s.addEventListener("click", e => e.stopPropagation());
      s.addEventListener("keydown", e => {
        // Stop the outside-click handler from swallowing typing.
        e.stopPropagation();
        if (e.key === "Escape") { searchText = ""; renderPop(); }
      });
    }

    // Select all / Clear all action buttons.
    pop.querySelectorAll(".fl-ms-act").forEach(btn => {
      btn.addEventListener("click", e => {
        e.stopPropagation();
        const act = btn.dataset.act;
        if (act === "all") {
          // Respect search filter — selecting "all" while a search is
          // active selects only the currently visible matches (in
          // addition to whatever was already selected).
          const filtered = searchText
            ? options.filter(o => o.label.toLowerCase().includes(searchText.toLowerCase()))
            : options;
          const next = new Set(selected);
          for (const o of filtered) next.add(o.value);
          if (maxSelected != null && next.size > maxSelected) {
            showWarn(`Maximum ${maxSelected} can be selected at a time.`);
            return;
          }
          selected = next;
        } else if (act === "clear") {
          // Same logic — if search is active, only clear the visible matches.
          if (searchText) {
            const visible = new Set(options
              .filter(o => o.label.toLowerCase().includes(searchText.toLowerCase()))
              .map(o => o.value));
            selected = new Set([...selected].filter(v => !visible.has(v)));
          } else {
            selected = new Set();
          }
        }
        Persist.set(id, [...selected]);
        updateLabel();
        renderPop();
        handlers.forEach(fn => fn([...selected]));
      });
    });

    // Per-item checkbox toggles.
    pop.querySelectorAll('.fl-ms-row input[type="checkbox"]').forEach(cb => {
      cb.addEventListener("change", () => {
        const v = cb.dataset.v;
        const next = new Set(selected);
        if (cb.checked) next.add(v); else next.delete(v);
        if (validate) {
          const err = validate(v, next);
          if (err) {
            cb.checked = !cb.checked;  // revert
            showWarn(err);
            return;
          }
        }
        if (maxSelected != null && next.size > maxSelected) {
          cb.checked = false;
          showWarn(`Maximum ${maxSelected} can be selected at a time.`);
          return;
        }
        selected = next;
        Persist.set(id, [...selected]);
        updateLabel();
        // Re-render to refresh action-button disabled state.
        renderPop();
        handlers.forEach(fn => fn([...selected]));
      });
    });
  }

  function toggle(open) {
    const wantOpen = open ?? pop.hidden;
    pop.hidden = !wantOpen;
    trigger.setAttribute("aria-expanded", wantOpen ? "true" : "false");
    if (wantOpen) {
      renderPop();
      // Close on outside click
      const onDoc = (e) => {
        if (!el.contains(e.target)) {
          toggle(false);
          document.removeEventListener("click", onDoc);
        }
      };
      setTimeout(() => document.addEventListener("click", onDoc), 0);
    }
  }

  trigger.addEventListener("click", (e) => { e.stopPropagation(); toggle(); });

  updateLabel();

  return {
    el,
    getSelected() { return [...selected]; },
    setSelected(arr) {
      selected = new Set(arr.filter(v => allValues.includes(v)));
      Persist.set(id, [...selected]);
      updateLabel();
      if (!pop.hidden) renderPop();
    },
    /**
     * Swap the option list at runtime. Any currently-selected items that
     * are no longer in the new options are dropped. Returns the array of
     * dropped values so the caller can show a toast/explanation.
     *
     * The default fallback param is used when the new options exist but
     * the post-clamp selection would be empty — picks the first value of
     * `fallbackSelected` (if any of those are in the new options) so the
     * UI never shows an empty selection.
     */
    setOptions(newOptions, fallbackSelected = null) {
      options = newOptions.slice();
      allValues = options.map(o => o.value);
      const dropped = [...selected].filter(v => !allValues.includes(v));
      selected = new Set([...selected].filter(v => allValues.includes(v)));
      if (selected.size === 0) {
        const fb = (fallbackSelected || []).find(v => allValues.includes(v));
        if (fb) selected.add(fb);
        else if (allValues.length) selected.add(allValues[0]);
      }
      Persist.set(id, [...selected]);
      updateLabel();
      if (!pop.hidden) renderPop();
      return dropped;
    },
    onChange(fn) { handlers.push(fn); },
    refresh() { updateLabel(); if (!pop.hidden) renderPop(); },
  };
}
