/**
 * downloads.js — CSV and Excel export helpers.
 *
 * Every visible table on the dashboard gets two download buttons that call
 * into here. CSV is a plain dump of the visible table. Excel is a workbook
 * with at least three sheets: visible table, raw filtered data, filter
 * context (per spec §6.3).
 */

/* ---------------------------------------------------------------- *
 * CSV
 * ---------------------------------------------------------------- */

/** Escape one CSV cell value. */
function csvCell(v) {
  if (v == null) return "";
  const s = String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/**
 * Trigger a CSV download.
 * @param {string} filename
 * @param {Array<{key:string,label:string}>} columns
 * @param {Array<object>} rows
 */
export function downloadCSV(filename, columns, rows) {
  const header = columns.map(c => csvCell(c.label || c.key)).join(",");
  const lines = rows.map(r => columns.map(c => csvCell(r[c.key])).join(","));
  const body = [header, ...lines].join("\r\n");
  // Excel-friendly UTF-8 BOM so accented characters open right.
  const blob = new Blob(["\uFEFF" + body], { type: "text/csv;charset=utf-8" });
  triggerDownload(blob, filename);
}

/* ---------------------------------------------------------------- *
 * Excel (SheetJS)
 * ---------------------------------------------------------------- */

function rowsToAOA(columns, rows) {
  const header = columns.map(c => c.label || c.key);
  const body = rows.map(r => columns.map(c => {
    const v = r[c.key];
    return v == null ? "" : v;
  }));
  return [header, ...body];
}

/**
 * Trigger an Excel download.
 * @param {string} filename                     output filename (.xlsx)
 * @param {Array<{name, columns, rows}>} sheets one entry per sheet
 */
export function downloadXLSX(filename, sheets) {
  if (typeof XLSX === "undefined") {
    console.warn("SheetJS not loaded; falling back to CSV for first sheet.");
    if (sheets[0]) {
      const csvName = filename.replace(/\.xlsx?$/i, "") + ".csv";
      downloadCSV(csvName, sheets[0].columns, sheets[0].rows);
    }
    return;
  }
  const wb = XLSX.utils.book_new();
  for (const s of sheets) {
    const aoa = rowsToAOA(s.columns, s.rows);
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    // Reasonable column widths: header length, capped 40.
    ws["!cols"] = s.columns.map(c => ({
      wch: Math.min(40, Math.max(10, (c.label || c.key).length + 4)),
    }));
    // Bold the header row.
    const range = XLSX.utils.decode_range(ws["!ref"]);
    for (let C = range.s.c; C <= range.e.c; C++) {
      const addr = XLSX.utils.encode_cell({ r: 0, c: C });
      if (ws[addr]) ws[addr].s = { font: { bold: true } };
    }
    XLSX.utils.book_append_sheet(wb, ws, _safeSheetName(s.name));
  }
  XLSX.writeFile(wb, filename);
}

/** Excel sheet names: max 31 chars, no [ ] : * ? / \. */
function _safeSheetName(name) {
  return String(name || "Sheet")
    .replace(/[\[\]:*?/\\]/g, " ")
    .slice(0, 31)
    .trim() || "Sheet";
}

/**
 * Build a "Filter context" sheet describing what filters were applied.
 * Pass an object of {label: value} pairs; values become strings.
 */
export function filterContextSheet(label, contextPairs) {
  const columns = [{ key: "k", label: "Filter" }, { key: "v", label: "Value" }];
  const rows = Object.entries(contextPairs).map(([k, v]) => ({
    k, v: Array.isArray(v) ? v.join(", ") : String(v == null ? "" : v),
  }));
  return { name: label, columns, rows };
}

/* ---------------------------------------------------------------- *
 * Shared blob trigger
 * ---------------------------------------------------------------- */
function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    a.remove();
    URL.revokeObjectURL(url);
  }, 0);
}
