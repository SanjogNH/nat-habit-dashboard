"""
fetch_data.py — pull each tab of the Nat Habit Google Sheet as a DataFrame.

Two modes:
    fetch_all(sheet_id=...)           -- gviz CSV from a public Sheet
    fetch_all(local_xlsx="path.xlsx") -- read a downloaded copy (test / offline)

The pipeline's contract is just "give me a dict {logical_name: DataFrame}".
Tabs missing in the sheet come back as empty DataFrames -- never raise.
"""
from __future__ import annotations

import urllib.parse
from io import BytesIO, StringIO
from typing import Optional

import pandas as pd
import requests

from config import OPTIONAL_TABS, TABS

GVIZ_URL = (
    "https://docs.google.com/spreadsheets/d/{sid}/gviz/tq"
    "?tqx=out:csv&sheet={tab}"
)
REQUEST_TIMEOUT = 60  # seconds


def _fetch_one_gviz(sheet_id: str, tab_name: str) -> pd.DataFrame:
    """Fetch a single sheet tab as a DataFrame via the gviz CSV endpoint.

    Returns an empty DataFrame if the tab does not exist or has no rows.
    Raises requests.HTTPError on transient network failures so the caller can
    surface a clear error.
    """
    url = GVIZ_URL.format(sid=sheet_id, tab=urllib.parse.quote(tab_name))
    resp = requests.get(url, headers={"User-Agent": "nat-habit-dashboard/1.0"},
                        timeout=REQUEST_TIMEOUT)
    if resp.status_code in (400, 404):
        # gviz returns 400 for a missing/inaccessible tab.
        return pd.DataFrame()
    resp.raise_for_status()
    text = resp.content.decode("utf-8-sig", errors="replace")
    if not text.strip():
        return pd.DataFrame()
    try:
        df = pd.read_csv(StringIO(text), dtype=str,
                         keep_default_na=False, na_values=["", "NA", "NaN"])
    except pd.errors.EmptyDataError:
        return pd.DataFrame()
    return _clean(df)


def _fetch_one_xlsx(book: pd.ExcelFile, tab_name: str) -> pd.DataFrame:
    """Read a single sheet from an already-open xlsx workbook."""
    if tab_name not in book.sheet_names:
        return pd.DataFrame()
    df = pd.read_excel(book, sheet_name=tab_name, dtype=object)
    # Strings come in as objects; convert for parity with the gviz path.
    df = df.astype(object).where(pd.notna(df), None)
    return _clean(df)


def _clean(df: pd.DataFrame) -> pd.DataFrame:
    """Strip column whitespace and drop fully-blank rows."""
    if df.empty:
        return df
    df.columns = [str(c).strip() for c in df.columns]
    df = df.dropna(how="all")
    # Drop rows where every visible value is blank/whitespace.
    def _row_blank(row):
        for v in row:
            if v is None:
                continue
            if isinstance(v, float) and pd.isna(v):
                continue
            if str(v).strip() != "":
                return False
        return True
    mask = df.apply(_row_blank, axis=1)
    return df[~mask].reset_index(drop=True)


def fetch_all(sheet_id: Optional[str] = None,
              local_xlsx: Optional[str] = None) -> dict[str, pd.DataFrame]:
    """Return a {logical_name: DataFrame} mapping for every configured tab.

    Exactly one of sheet_id / local_xlsx must be provided.
    Optional mapping tabs are included under their logical keys when present.
    """
    if (sheet_id is None) == (local_xlsx is None):
        raise ValueError("fetch_all requires exactly one of sheet_id or local_xlsx")

    out: dict[str, pd.DataFrame] = {}
    all_tabs = {**TABS, **OPTIONAL_TABS}

    if local_xlsx:
        book = pd.ExcelFile(local_xlsx)
        for key, tab_name in all_tabs.items():
            out[key] = _fetch_one_xlsx(book, tab_name)
    else:
        for key, tab_name in all_tabs.items():
            out[key] = _fetch_one_gviz(sheet_id, tab_name)

    return out


def summarise(frames: dict[str, pd.DataFrame]) -> str:
    """Compact one-line summary of fetched row counts."""
    parts = [f"{k}={len(v)}" for k, v in frames.items()]
    return "  ".join(parts)


if __name__ == "__main__":
    # Tiny smoke test from the CLI.
    import sys
    from config import SHEET_ID
    if len(sys.argv) > 1 and sys.argv[1].endswith(".xlsx"):
        frames = fetch_all(local_xlsx=sys.argv[1])
    else:
        frames = fetch_all(sheet_id=SHEET_ID)
    print(summarise(frames))
