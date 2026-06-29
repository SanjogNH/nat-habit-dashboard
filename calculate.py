"""
calculate.py — normalize raw fetched DataFrames into the JSON shape from §8.

Pure pandas + standard library. Produces a Python dict that callers serialize.
Every public function has a docstring describing its return contract.
"""
from __future__ import annotations

import math
import re
from datetime import datetime, timedelta, timezone
from typing import Any, Iterable

import numpy as np
import pandas as pd

from config import BRANDED_TOKENS, WEEK1_START_ISO, platform_sort_key

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
WEEK1_START = pd.Timestamp(WEEK1_START_ISO)
EXCEL_EPOCH = pd.Timestamp("1899-12-30")    # Google Sheets / Excel serial epoch
IST = timezone(timedelta(hours=5, minutes=30))

# ---------------------------------------------------------------------------
# Date parsing — §4.1
# Handles ISO strings, DD-MM-YYYY / DD/MM/YYYY, Excel serial integers, datetimes.
# ---------------------------------------------------------------------------
def parse_dates(series: pd.Series) -> pd.Series:
    """Convert a mixed-type series to pandas datetime64[ns]. Bad values -> NaT."""
    if series is None or len(series) == 0:
        return pd.Series([], dtype="datetime64[ns]")

    # If the column is already datetime-like (xlsx path), return cleanly.
    if pd.api.types.is_datetime64_any_dtype(series):
        return pd.to_datetime(series, errors="coerce")

    s = series.copy()

    # First pass: ISO YYYY-MM-DD.
    out = pd.to_datetime(s, errors="coerce", format="%Y-%m-%d")

    # Second pass: day-first strings.
    miss = out.isna() & s.notna() & s.astype(str).str.strip().ne("")
    if miss.any():
        out.loc[miss] = pd.to_datetime(s[miss], errors="coerce", dayfirst=True)

    # Third pass: pure Excel serial numbers (strings of digits or numeric).
    miss = out.isna() & s.notna()
    if miss.any():
        as_num = pd.to_numeric(s[miss], errors="coerce")
        good = as_num.notna() & (as_num > 20000) & (as_num < 80000)
        if good.any():
            serial_dates = EXCEL_EPOCH + pd.to_timedelta(as_num[good], unit="D")
            out.loc[serial_dates.index] = serial_dates

    return out


# ---------------------------------------------------------------------------
# Numeric coercion — §4.6
# ---------------------------------------------------------------------------
def to_num(series: pd.Series) -> pd.Series:
    """Strip ₹ and commas, return float; blanks/garbage -> NaN (not 0)."""
    if series is None or len(series) == 0:
        return pd.Series([], dtype=float)
    s = (series.astype(str)
                .str.replace(",", "", regex=False)
                .str.replace("\u20b9", "", regex=False)  # ₹
                .str.replace("%", "", regex=False)
                .str.strip()
                .replace({"": None, "nan": None, "NaN": None, "None": None}))
    return pd.to_numeric(s, errors="coerce")


# ---------------------------------------------------------------------------
# Week numbering — §4.2
# ---------------------------------------------------------------------------
def sunday_of(dates: pd.Series) -> pd.Series:
    """Return the Sunday on or before each date (Sunday-start weeks)."""
    # pandas weekday(): Monday=0 .. Sunday=6. We want days to *previous* Sunday.
    days_to_sun = (dates.dt.weekday + 1) % 7
    return dates - pd.to_timedelta(days_to_sun, unit="D")


def week_num_from_dates(dates: pd.Series) -> pd.Series:
    """Compute the week number (W1 = the week containing WEEK1_START)."""
    sundays = sunday_of(dates)
    return ((sundays - WEEK1_START).dt.days // 7 + 1).astype("Int64")


def week_meta_from_num(n: int | None) -> dict | None:
    """Return the full week metadata dict for a given week number, or None."""
    if n is None or pd.isna(n) or int(n) < 1:
        return None
    n = int(n)
    start = WEEK1_START + pd.Timedelta(days=(n - 1) * 7)
    end = start + pd.Timedelta(days=6)
    return {
        "week_num": n,
        "label": f"Week{n}",
        "start": start.strftime("%Y-%m-%d"),
        "end": end.strftime("%Y-%m-%d"),
        "range_display": f"{start.strftime('%d %b')} – {end.strftime('%d %b')} '{end.strftime('%y')}",
    }


def week_num_from_label(label: str | None) -> int | None:
    """Parse a 'Week23' string from the sheet into an integer."""
    if not label:
        return None
    m = re.match(r"^\s*Week\s*(\d+)\s*$", str(label), flags=re.IGNORECASE)
    return int(m.group(1)) if m else None


# ---------------------------------------------------------------------------
# Bucket mapping — §4.3
# ---------------------------------------------------------------------------
def to_branded_bucket(value: Any) -> str:
    """Map a 'Search Query Type' / 'Keyword Type' cell to 'Branded' or 'Generic'.

    Source-tag-only classifier — 2-way (used outside the Spend tab).
    For keyword-aware classification use classify_branded() instead.
    """
    if value is None:
        return "Generic"
    if isinstance(value, float) and math.isnan(value):
        return "Generic"
    return "Branded" if str(value).strip().lower() in BRANDED_TOKENS else "Generic"


# Tokens that classify a row as 'Generic' (specifically, not Branded and not
# Other). Used by the 3-way Spend bucketing only.
GENERIC_TOKENS = {"generic"}


def to_spend_bucket(value: Any) -> str:
    """Map BCG Data 'Search Query Type' to 'Branded' | 'Generic' | 'Other'.

    Spend-tab only: the Spend tab shows four lines (Branded / Generic /
    Other / Total). Anything that isn't explicitly Brand or Generic — Comp,
    blank, unknown labels — falls into 'Other'.
    """
    if value is None:
        return "Other"
    if isinstance(value, float) and math.isnan(value):
        return "Other"
    s = str(value).strip().lower()
    if s in BRANDED_TOKENS:
        return "Branded"
    if s in GENERIC_TOKENS:
        return "Generic"
    return "Other"


# Keyword tokens that mark a search term as Branded by definition.
BRAND_NAME_TOKENS = ("nat habit", "nathabit")


def classify_branded(keyword: Any, source_tag: Any = None) -> str:
    """Classify a search term as 'Branded' or 'Generic'.

    Branded if EITHER:
      - the source tag column (Search Query Type / Keyword Type) is in
        BRANDED_TOKENS, OR
      - the keyword text contains "nat habit" or "nathabit" (case-insensitive).

    Otherwise Generic. Used everywhere a keyword text is available so Daily
    and Weekly use the same definition (spec §4.3 + custom rule of thumb).
    """
    # Source-tag check first.
    if source_tag is not None and not (isinstance(source_tag, float) and math.isnan(source_tag)):
        if str(source_tag).strip().lower() in BRANDED_TOKENS:
            return "Branded"
    # Substring rule.
    if keyword is not None and not (isinstance(keyword, float) and math.isnan(keyword)):
        kw_lc = str(keyword).lower()
        for tok in BRAND_NAME_TOKENS:
            if tok in kw_lc:
                return "Branded"
    return "Generic"


# ---------------------------------------------------------------------------
# Column normalization — §4.4 and platform handling
# ---------------------------------------------------------------------------
SUBCAT_VARIANTS = ("Sub-Category", "Sub Category", "SubCategory", "Sub-category", "Subcategory")

def ensure_subcategory(df: pd.DataFrame) -> pd.DataFrame:
    """Rename any subcategory variant to 'Subcategory' (one word)."""
    if df.empty:
        return df
    for v in SUBCAT_VARIANTS:
        if v in df.columns and v != "Subcategory":
            df = df.rename(columns={v: "Subcategory"})
            break
    return df


def get_platform(df: pd.DataFrame) -> pd.Series:
    """Return the platform column regardless of whether it's named Channel or Platform."""
    if "Channel" in df.columns:
        return df["Channel"].astype("string").str.strip()
    if "Platform" in df.columns:
        return df["Platform"].astype("string").str.strip()
    return pd.Series([None] * len(df), index=df.index, dtype="string")


# ---------------------------------------------------------------------------
# Cell value sanitizer for JSON
# ---------------------------------------------------------------------------
def _safe(v: Any) -> Any:
    """Make a single value JSON-safe: NaN -> None; numpy scalars unboxed."""
    if v is None:
        return None
    if isinstance(v, float) and math.isnan(v):
        return None
    if isinstance(v, (np.integer,)):
        return int(v)
    if isinstance(v, (np.floating,)):
        f = float(v)
        return None if math.isnan(f) else f
    if isinstance(v, pd.Timestamp):
        return None if pd.isna(v) else v.strftime("%Y-%m-%d")
    if isinstance(v, str):
        s = v.strip()
        return s if s != "" else None
    return v


def _records(df: pd.DataFrame, columns: list[str]) -> list[dict]:
    """Return df[columns] as a list of dicts with JSON-safe values."""
    if df.empty:
        return []
    out = []
    sub = df[columns]
    for row in sub.itertuples(index=False, name=None):
        out.append({c: _safe(v) for c, v in zip(columns, row)})
    return out


# ===========================================================================
# Per-tab processors. Each returns a (rows: list[dict], df: DataFrame) tuple --
# the DataFrame is retained so metadata aggregation can use it.
# ===========================================================================

# ---- Daily SFR -------------------------------------------------------------
def process_daily_sfr(raw: pd.DataFrame) -> tuple[list[dict], pd.DataFrame]:
    """Daily search keyword performance. Amazon is rank-based."""
    if raw.empty:
        return [], raw
    df = ensure_subcategory(raw.copy())
    df["platform"] = get_platform(df)
    df["date"] = parse_dates(df.get("Date"))
    df = df[df["date"].notna() & df["platform"].notna()].copy()
    df["rank"] = to_num(df.get("Search Frequency Rank")) if "Search Frequency Rank" in df.columns else pd.NA
    # Amazon uses rank=0 to mean "not in the ranked set this week", not a literal rank.
    if "rank" in df.columns:
        df.loc[df["rank"].fillna(1) <= 0, "rank"] = pd.NA
    df["keyword"] = df.get("Search Term", pd.Series([None] * len(df))).astype("string").str.strip()
    df["category"] = df.get("Category", pd.Series([None] * len(df))).astype("string").str.strip()
    df["subcategory"] = df.get("Subcategory", pd.Series([None] * len(df))).astype("string").str.strip()
    cols = ["platform", "date", "keyword", "category", "subcategory", "rank"]
    return _records(df, cols), df

# ---- Weekly SFR Movement ---------------------------------------------------
def process_weekly_sfr(raw: pd.DataFrame) -> tuple[list[dict], pd.DataFrame]:
    """Weekly keyword performance — backbone of the Impressions tab."""
    if raw.empty:
        return [], raw
    df = ensure_subcategory(raw.copy())
    df["platform"] = get_platform(df)
    df["week_num"] = df.get("Week", pd.Series([None] * len(df))).map(week_num_from_label)
    df = df[df["platform"].notna() & df["week_num"].notna()].copy()
    df["week_num"] = df["week_num"].astype(int)
    df["search_query"] = df.get("Search Query", pd.Series([None] * len(df))).astype("string").str.strip()
    df["category"] = df.get("Category", pd.Series([None] * len(df))).astype("string").str.strip()
    df["subcategory"] = df.get("Subcategory", pd.Series([None] * len(df))).astype("string").str.strip()
    df["branded_bucket"] = [
        classify_branded(kw, st)
        for kw, st in zip(
            df.get("Search Query", pd.Series([None] * len(df))),
            df.get("Search Query Type", pd.Series([None] * len(df))),
        )
    ]
    df["rank"] = to_num(df.get("Search Frequency Rank")) if "Search Frequency Rank" in df.columns else pd.NA
    # Amazon SFR uses 0 as "not in the ranked set this week"; treat as missing.
    if "rank" in df.columns:
        df.loc[df["rank"].fillna(1) <= 0, "rank"] = pd.NA
    df["volume"] = to_num(df.get("Search Query Volume")) if "Search Query Volume" in df.columns else pd.NA
    df["impressions"] = to_num(df.get("Impressions: Total Count")) if "Impressions: Total Count" in df.columns else pd.NA
    df["brand_impression_share_pct"] = to_num(df.get("Impressions: Brand Share %")) if "Impressions: Brand Share %" in df.columns else pd.NA
    df["clicks"] = to_num(df.get("Clicks: Total Count")) if "Clicks: Total Count" in df.columns else pd.NA
    df["brand_click_share_pct"] = to_num(df.get("Clicks: Brand Share %")) if "Clicks: Brand Share %" in df.columns else pd.NA
    cols = ["platform", "week_num", "search_query", "branded_bucket", "category", "subcategory",
            "rank", "volume", "impressions", "brand_impression_share_pct",
            "clicks", "brand_click_share_pct"]
    return _records(df, cols), df

# ---- Weekly Catalogue Performance -----------------------------------------
def process_weekly_catalogue(raw: pd.DataFrame) -> tuple[list[dict], pd.DataFrame]:
    """Weekly SKU-level impressions."""
    if raw.empty:
        return [], raw
    df = ensure_subcategory(raw.copy())
    df["platform"] = get_platform(df)
    df["week_num"] = df.get("Week", pd.Series([None] * len(df))).map(week_num_from_label)
    df = df[df["platform"].notna() & df["week_num"].notna()].copy()
    df["week_num"] = df["week_num"].astype(int)
    df["short_code"] = df.get("Short Code", pd.Series([None] * len(df))).astype("string").str.strip()
    df["nh_sku"] = df.get("NH SKU", pd.Series([None] * len(df))).astype("string").str.strip()
    df["category"] = df.get("Category", pd.Series([None] * len(df))).astype("string").str.strip()
    df["subcategory"] = df.get("Subcategory", pd.Series([None] * len(df))).astype("string").str.strip()
    df["impressions"] = to_num(df.get("Impressions: Impressions")) if "Impressions: Impressions" in df.columns else pd.NA
    cols = ["platform", "week_num", "short_code", "nh_sku", "category", "subcategory", "impressions"]
    return _records(df, cols), df

# ---- Sales Data ------------------------------------------------------------
def process_sales(raw: pd.DataFrame) -> tuple[list[dict], pd.DataFrame]:
    """Daily SKU-level sales."""
    if raw.empty:
        return [], raw
    df = ensure_subcategory(raw.copy())
    df["platform"] = get_platform(df)
    df["date"] = parse_dates(df.get("Date"))
    df = df[df["date"].notna() & df["platform"].notna()].copy()
    df["nh_sku"] = df.get("NH SKU", pd.Series([None] * len(df))).astype("string").str.strip()
    df["category"] = df.get("Category", pd.Series([None] * len(df))).astype("string").str.strip()
    df["subcategory"] = df.get("Subcategory", pd.Series([None] * len(df))).astype("string").str.strip()
    df["glance_views"] = to_num(df.get("Glance Views")) if "Glance Views" in df.columns else pd.NA
    df["gross_units"] = to_num(df.get("Gross Units")) if "Gross Units" in df.columns else pd.NA
    df["revenue"] = to_num(df.get("Revenue")) if "Revenue" in df.columns else pd.NA
    cols = ["platform", "date", "nh_sku", "category", "subcategory",
            "glance_views", "gross_units", "revenue"]
    return _records(df, cols), df

# ---- BCG Data (spend) ------------------------------------------------------
def process_bcg_spend(raw: pd.DataFrame) -> tuple[list[dict], pd.DataFrame]:
    """Daily spend + ad-attributable sales."""
    if raw.empty:
        return [], raw
    df = ensure_subcategory(raw.copy())
    df["platform"] = get_platform(df)
    df["date"] = parse_dates(df.get("Date"))
    df = df[df["date"].notna() & df["platform"].notna()].copy()
    df["category"] = df.get("Category", pd.Series([None] * len(df))).astype("string").str.strip()
    df["subcategory"] = df.get("Subcategory", pd.Series([None] * len(df))).astype("string").str.strip()
    bucket_src = df["Keyword Type"] if "Keyword Type" in df.columns else df.get("Search Query Type")
    df["branded_bucket"] = bucket_src.map(to_spend_bucket) if bucket_src is not None else "Other"
    df["marketing_channel"] = df.get("Marketing Channel", pd.Series([None] * len(df))).astype("string").str.strip()
    df["spend"] = to_num(df.get("Spend")) if "Spend" in df.columns else pd.NA
    df["sales"] = to_num(df.get("Sales")) if "Sales" in df.columns else pd.NA
    cols = ["platform", "date", "category", "subcategory", "branded_bucket",
            "marketing_channel", "spend", "sales"]
    return _records(df, cols), df

# ---- Influencer Data -------------------------------------------------------
def process_influencer(raw: pd.DataFrame) -> tuple[list[dict], pd.DataFrame]:
    """Daily influencer campaign performance. No platform field."""
    if raw.empty:
        return [], raw
    df = raw.copy()
    df["date"] = parse_dates(df.get("Date"))
    df = df[df["date"].notna()].copy()
    df["influencer_name"] = df.get("Influencer Name", pd.Series([None] * len(df))).astype("string").str.strip()
    df["category"] = df.get("Category", pd.Series([None] * len(df))).astype("string").str.strip()
    df["ad_name"] = df.get("Ad Name", pd.Series([None] * len(df))).astype("string").str.strip()
    df["views"] = to_num(df.get("Views")) if "Views" in df.columns else pd.NA
    df["likes"] = to_num(df.get("Likes")) if "Likes" in df.columns else pd.NA
    df["comments"] = to_num(df.get("Comments")) if "Comments" in df.columns else pd.NA
    df["shares"] = to_num(df.get("Shares")) if "Shares" in df.columns else pd.NA
    cols = ["date", "influencer_name", "category", "ad_name", "views", "likes", "comments", "shares"]
    return _records(df, cols), df


# ---------------------------------------------------------------------------
# Metadata aggregation — §8
# ---------------------------------------------------------------------------
def _collect_platforms(processed_dfs: dict[str, pd.DataFrame]) -> list[str]:
    """Union of platforms across every tab that has one, sorted Amazon-first."""
    found: set[str] = set()
    for name, df in processed_dfs.items():
        if df is None or df.empty or "platform" not in df.columns:
            continue
        for p in df["platform"].dropna().unique():
            p = str(p).strip()
            if p:
                found.add(p)
    return sorted(found, key=platform_sort_key)


def _collect_category_tree(processed_dfs: dict[str, pd.DataFrame]) -> tuple[list[str], dict[str, list[str]]]:
    """Union of (category, subcategory) pairs across all tabs."""
    pairs: set[tuple[str, str | None]] = set()
    for df in processed_dfs.values():
        if df is None or df.empty or "category" not in df.columns:
            continue
        sub = df["subcategory"] if "subcategory" in df.columns else pd.Series([None] * len(df), index=df.index)
        for c, s in zip(df["category"], sub):
            c = str(c).strip() if c is not None and not (isinstance(c, float) and math.isnan(c)) else None
            s = str(s).strip() if s is not None and not (isinstance(s, float) and math.isnan(s)) else None
            if not c:
                continue
            pairs.add((c, s or None))
    cats = sorted({c for c, _ in pairs})
    tree: dict[str, list[str]] = {c: [] for c in cats}
    for c, s in pairs:
        if s and s not in tree[c]:
            tree[c].append(s)
    for c in tree:
        tree[c].sort()
    return cats, tree


def _collect_date_range(processed_dfs: dict[str, pd.DataFrame]) -> dict[str, str | None]:
    """Min/max ISO date across every tab that has a date column."""
    mins, maxs = [], []
    for df in processed_dfs.values():
        if df is None or df.empty or "date" not in df.columns:
            continue
        d = pd.to_datetime(df["date"], errors="coerce")
        if d.notna().any():
            mins.append(d.min())
            maxs.append(d.max())
    if not mins:
        return {"min": None, "max": None}
    return {"min": min(mins).strftime("%Y-%m-%d"),
            "max": max(maxs).strftime("%Y-%m-%d")}


def _collect_weeks(processed_dfs: dict[str, pd.DataFrame]) -> list[dict]:
    """Distinct week_meta dicts seen across weekly tabs and date-based tabs."""
    nums: set[int] = set()
    for df in processed_dfs.values():
        if df is None or df.empty:
            continue
        if "week_num" in df.columns:
            for v in df["week_num"].dropna().astype(int).unique():
                nums.add(int(v))
        if "date" in df.columns:
            wn = week_num_from_dates(pd.to_datetime(df["date"], errors="coerce"))
            for v in wn.dropna().astype(int).unique():
                nums.add(int(v))
    weeks = [week_meta_from_num(n) for n in sorted(nums)]
    return [w for w in weeks if w]


# ---------------------------------------------------------------------------
# Top-level entry point
# ---------------------------------------------------------------------------
def _enrich_daily_branded(daily_rows: list[dict], weekly_rows: list[dict]) -> None:
    """Add a 'branded_bucket' field to each row in daily_rows.

    A daily keyword is Branded if EITHER:
      1. its text contains "nat habit" or "nathabit" (case-insensitive), OR
      2. the same keyword appears in weekly_sfr and is classified as Branded
         there (which itself already encodes the substring rule + source tag).

    Otherwise Generic.

    Mutates `daily_rows` in place. Mirror of calculate.js::enrichDailyBranded.
    """
    weekly_branded = set()
    for r in weekly_rows:
        kw = r.get("search_query")
        if kw and r.get("branded_bucket") == "Branded":
            weekly_branded.add(kw.strip().lower())

    for r in daily_rows:
        kw = (r.get("keyword") or "").strip()
        if not kw:
            r["branded_bucket"] = "Generic"
            continue
        # Use the same classifier — keyword-only path. Then OR-in weekly inheritance.
        bucket = classify_branded(kw, None)
        if bucket == "Branded":
            r["branded_bucket"] = "Branded"
            continue
        r["branded_bucket"] = "Branded" if kw.lower() in weekly_branded else "Generic"


def build_payload(raw_frames: dict[str, pd.DataFrame], sheet_id: str) -> dict:
    """Process every raw frame and assemble the final JSON-ready dict per §8."""
    processors = {
        "daily_sfr":         process_daily_sfr,
        "weekly_sfr":        process_weekly_sfr,
        "weekly_catalogue":  process_weekly_catalogue,
        "sales":             process_sales,
        "bcg_spend":         process_bcg_spend,
        "influencer":        process_influencer,
    }

    rows_by_tab: dict[str, list[dict]] = {}
    dfs_by_tab: dict[str, pd.DataFrame] = {}
    row_counts: dict[str, int] = {}

    for key, fn in processors.items():
        raw = raw_frames.get(key, pd.DataFrame())
        rows, df = fn(raw)
        rows_by_tab[key] = rows
        dfs_by_tab[key] = df
        row_counts[key] = len(rows)

    # Enrich daily SFR rows with a branded_bucket field, derived from weekly
    # SFR classifications (primary) plus a substring fallback (safety net).
    _enrich_daily_branded(rows_by_tab["daily_sfr"], rows_by_tab["weekly_sfr"])

    platforms = _collect_platforms(dfs_by_tab)
    cats, tree = _collect_category_tree(dfs_by_tab)
    date_range = _collect_date_range(dfs_by_tab)
    weeks = _collect_weeks(dfs_by_tab)

    now = datetime.now(IST)
    metadata = {
        "last_updated_iso": now.isoformat(timespec="seconds"),
        "last_updated_display": now.strftime("%d %b %Y, %I:%M %p IST").lstrip("0"),
        "sheet_id": sheet_id,    # full id so the frontend can refetch live
        "sheet_id_preview": f"{sheet_id[:4]}...{sheet_id[-4:]}" if len(sheet_id) > 10 else sheet_id,
        "row_counts": row_counts,
        "date_range": date_range,
        "platforms": platforms,
        "categories": cats,
        "subcategories_by_category": tree,
    }

    payload = {"metadata": metadata, "weeks": weeks, **rows_by_tab}
    return payload
