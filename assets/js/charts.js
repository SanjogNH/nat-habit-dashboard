/**
 * charts.js — Chart.js setup and reusable chart factories.
 *
 * Spec §7.5: distinct color-blind-friendly palette, Lakh/Crore axis ticks for
 * INR, tooltips show period + values + delta vs previous period, legend at
 * top with click-to-toggle. Chart.js instances are destroyed before recreation
 * to prevent memory leaks.
 */

import { fmtINR, fmtInt, fmtROAS } from "./util.js";

/* ---------------------------------------------------------------- *
 * Palette: brand first, then Okabe-Ito extensions. 10 colors total
 * which is exactly the keyword-trend chart cap.
 * ---------------------------------------------------------------- */
export const PALETTE = [
  "#BD5A35",  // brand terracotta
  "#9CAF99",  // brand sage
  "#0072B2",  // Okabe-Ito blue
  "#E69F00",  // Okabe-Ito orange
  "#CC79A7",  // Okabe-Ito pink
  "#56B4E9",  // Okabe-Ito sky
  "#D55E00",  // Okabe-Ito vermilion
  "#117733",  // Wong dark green
  "#882255",  // Tol wine
  "#6E3FCF",  // violet
];

/** Apply global Chart.js defaults. Idempotent — safe to call repeatedly. */
export function initChartDefaults() {
  if (!window.Chart) return;
  Chart.defaults.font.family = '"Nunito", system-ui, sans-serif';
  Chart.defaults.font.size = 12;
  Chart.defaults.color = "#1F2A22";
  Chart.defaults.borderColor = "rgba(31,42,34,0.06)";
}

/* ---------------------------------------------------------------- *
 * Tick formatters
 * ---------------------------------------------------------------- */
function tickInt(v) {
  const abs = Math.abs(v);
  if (abs >= 1e7) return `${(v / 1e7).toFixed(1)}Cr`;
  if (abs >= 1e5) return `${(v / 1e5).toFixed(1)}L`;
  if (abs >= 1000) return `${(v / 1000).toFixed(1)}K`;
  return Number(v).toLocaleString("en-IN");
}
function tickINR(v) { return `₹${tickInt(v)}`; }
function tickPct(v) { return `${Number(v).toFixed(0)}%`; }
function tickROAS(v) { return `${Number(v).toFixed(1)}x`; }

const FORMAT_TICKS = {
  int: tickInt,
  inr: tickINR,
  pct: tickPct,
  roas: tickROAS,
};
const FORMAT_VALUES = {
  int: fmtInt,
  inr: fmtINR,
  pct: (v) => v == null ? "—" : `${Number(v).toFixed(2)}%`,
  roas: fmtROAS,
};

/* ---------------------------------------------------------------- *
 * Chart instance management
 * ---------------------------------------------------------------- */
const _instances = new WeakMap();

function _destroyExisting(canvas) {
  // First check our own WeakMap (created by renderLineChart).
  const prev = _instances.get(canvas);
  if (prev) {
    try { prev.destroy(); } catch (e) { /* swallow */ }
    _instances.delete(canvas);
  }
  // Then check Chart.js's own registry — covers charts built directly with
  // `new Chart()` in other modules (e.g., tab-spend's renderColoredLineChart).
  if (typeof window.Chart !== "undefined" && window.Chart.getChart) {
    const existing = window.Chart.getChart(canvas);
    if (existing) {
      try { existing.destroy(); } catch (e) { /* swallow */ }
    }
  }
}

/**
 * Render a multi-series line chart. Always replaces any prior chart on the
 * same canvas to prevent leaks.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {object} opts
 * @param {string[]} opts.labels         category-axis labels (time periods)
 * @param {Array<{label, data}>} opts.series  one entry per line
 * @param {boolean} [opts.yReverse]      reverse the value axis (rare — most
 *                                       charts want natural orientation)
 * @param {boolean} [opts.yBeginAtZero]  whether the value axis starts at zero.
 *                                       Defaults to `!yReverse` for backward
 *                                       compatibility. Set explicitly to
 *                                       `false` for rank-style charts where
 *                                       values are clustered far from zero
 *                                       and a 0-floor would compress them.
 * @param {string}  [opts.yFormat]       "int" | "inr" | "pct" | "roas"
 * @param {string}  [opts.yTitle]        optional value-axis title
 * @param {boolean} [opts.horizontal]    when true, swaps orientation:
 *                                       category axis on Y, value axis on X.
 * @returns {Chart}
 */
export function renderLineChart(canvas, opts) {
  if (typeof window.Chart === "undefined") {
    console.warn("Chart.js not loaded; skipping chart render.");
    return null;
  }
  _destroyExisting(canvas);
  const {
    labels, series,
    yReverse = false,
    yBeginAtZero,                          // resolved below
    rankMode = false,   // true = lower value is better (rank); flips tooltip delta arrows
    yFormat = "int",
    yTitle = "",
    hideLegend = false,
    horizontal = false,
  } = opts;
  // Default beginAtZero to !yReverse for backward compat. Callers that want
  // natural-scale (no-zero-floor) without reversing the axis pass it explicitly.
  const beginAtZero = (yBeginAtZero === undefined) ? !yReverse : !!yBeginAtZero;

  const tickFn = FORMAT_TICKS[yFormat] || tickInt;
  const valueFn = FORMAT_VALUES[yFormat] || fmtInt;

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

  // Axis configurations depend on orientation.
  //   Vertical (default): X = category (labels), Y = value.
  //   Horizontal:         X = value, Y = category (labels).
  // In both modes, `yReverse` applies to the VALUE axis (so "best is up" stays
  // "best is right" when rotated).
  const valueAxisCfg = {
    beginAtZero,
    reverse: yReverse,
    grid: { color: "rgba(31,42,34,0.06)" },
    ticks: { font: { size: 11 }, callback: tickFn },
    title: yTitle ? {
      display: true, text: yTitle,
      font: { size: 11, weight: 600 },
      color: "#7A7268",
    } : undefined,
  };
  const categoryAxisCfg = {
    grid: { display: false },
    ticks: { maxRotation: 0, autoSkip: true, autoSkipPadding: 12,
             font: { size: 11 } },
  };

  const config = {
    type: "line",
    data: { labels, datasets },
    options: {
      indexAxis: horizontal ? "y" : "x",
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: hideLegend ? { display: false } : {
          position: "top",
          align: "end",
          labels: {
            boxWidth: 8, boxHeight: 8, padding: 14,
            font: { size: 12, weight: 600 },
            usePointStyle: true,
          },
          onClick: Chart.defaults.plugins.legend.onClick,
        },
        tooltip: {
          backgroundColor: "rgba(31,42,34,0.95)",
          titleColor: "#fff",
          bodyColor: "#fff",
          padding: 10,
          cornerRadius: 8,
          displayColors: true,
          boxPadding: 4, boxWidth: 6, boxHeight: 6,
          callbacks: {
            label(ctx) {
              // In horizontal mode the parsed value lives on .x, not .y.
              const v = horizontal ? ctx.parsed.x : ctx.parsed.y;
              if (v == null) return `${ctx.dataset.label}: —`;
              const valueStr = valueFn(v);
              // Delta vs previous data point in the same series.
              const idx = ctx.dataIndex;
              const arr = ctx.dataset.data;
              const prev = idx > 0 ? arr[idx - 1] : null;
              let deltaStr = "";
              if (prev != null && prev !== 0) {
                const diff = v - prev;
                if (rankMode) {
                  // Rank: lower is better. Improvement is negative diff.
                  const sign = diff < 0 ? "↑" : (diff > 0 ? "↓" : "→");
                  deltaStr = `  ${sign}${Math.abs(diff)}`;
                } else {
                  const pct = (diff / Math.abs(prev)) * 100;
                  const sign = pct > 0 ? "+" : "";
                  deltaStr = `  (${sign}${pct.toFixed(1)}%)`;
                }
              }
              return `${ctx.dataset.label}: ${valueStr}${deltaStr}`;
            },
          },
        },
      },
      scales: horizontal
        ? { x: valueAxisCfg, y: categoryAxisCfg }
        : { x: categoryAxisCfg, y: valueAxisCfg },
    },
  };

  initChartDefaults();
  const chart = new Chart(canvas, config);
  _instances.set(canvas, chart);
  return chart;
}

/** Destroy any chart bound to a canvas, e.g., when switching tabs. */
export function destroyChart(canvas) {
  _destroyExisting(canvas);
}

/**
 * Render a custom side-legend for a Chart.js instance. Used when the default
 * top legend would wrap into many rows (e.g. SKU Impressions, Keyword Trend
 * where labels are long product names).
 *
 * The list is scrollable when items overflow; each item is click-toggleable
 * (mirrors Chart.js's default legend behavior). Hover any item to see the
 * full label via title tooltip.
 *
 * @param {HTMLElement} legendEl  Container to populate
 * @param {Chart}       chart      Live Chart.js instance returned by renderLineChart
 */
export function renderSideLegend(legendEl, chart) {
  if (!legendEl || !chart || !chart.data?.datasets) return;
  legendEl.innerHTML = "";
  const datasets = chart.data.datasets;
  for (let i = 0; i < datasets.length; i++) {
    const ds = datasets[i];
    const label = ds.label || `Series ${i + 1}`;
    const color = ds.borderColor || "#888";
    const hidden = chart.getDatasetMeta(i).hidden;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "csl-item" + (hidden ? " is-hidden" : "");
    btn.title = label;
    btn.setAttribute("aria-label", `Toggle ${label}`);
    btn.innerHTML =
      `<span class="csl-swatch" style="background:${color}"></span>` +
      `<span class="csl-label"></span>`;
    btn.querySelector(".csl-label").textContent = label;
    btn.addEventListener("click", () => {
      const meta = chart.getDatasetMeta(i);
      const newHidden = !meta.hidden;
      chart.setDatasetVisibility(i, !newHidden);
      chart.update();
      btn.classList.toggle("is-hidden", newHidden);
    });
    legendEl.appendChild(btn);
  }
}
