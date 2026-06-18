"""
Nat Habit Dashboard — pipeline configuration.

Edit SHEET_ID below (or set the SHEET_ID env var in the GitHub Action secrets).
Everything else is conventions baked into the spec.
"""
from __future__ import annotations

import os

# ---------------------------------------------------------------------------
# Google Sheet
# ---------------------------------------------------------------------------
SHEET_ID = os.environ.get(
    "SHEET_ID",
    "1eDNRPCw2-WLfbjwdlF3Mjz8_xomQODrxI6B4PV6G6DU",  # Default; replace in production.
)

# Tab names — must match the Google Sheet exactly.
TABS = {
    "daily_sfr":         "Daily SFR",
    "weekly_sfr":        "Weekly SFR Movement",
    "weekly_catalogue":  "Weekly Catalogue Performance",
    "sales":             "Sales Data",
    "bcg_spend":         "BCG Data",
    "influencer":        "Influencer Data",
}

# Optional mapping tabs (PROJECT_INSTRUCTIONS §4.7 — present in some versions).
OPTIONAL_TABS = {
    "keyword_mapping": "Keyword Mapping",
    "sku_mapping":     "SKU Mapping",
}

# ---------------------------------------------------------------------------
# Week numbering anchor — PROJECT_INSTRUCTIONS §4.2
# Sunday 28-Dec-2025 = Week 1 of 2026.
# ---------------------------------------------------------------------------
WEEK1_START_ISO = "2025-12-28"

# ---------------------------------------------------------------------------
# Branded / Generic mapping — PROJECT_INSTRUCTIONS §4.3
# Source columns vary by tab: 'Search Query Type' (Weekly SFR), 'Keyword Type' (BCG).
# Values seen in the wild: Brand, Branded, Generic, Comp, blank.
# Spec rule: 'Brand'/'Branded' -> Branded; everything else -> Generic.
# ---------------------------------------------------------------------------
BRANDED_TOKENS = {"brand", "branded"}

# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------
OUTPUT_DIR = "data"
OUTPUT_MAIN = "dashboard_data.json"
# When a single payload exceeds this threshold, the orchestrator splits large
# row arrays into per-tab side-files (sales.json, bcg_spend.json, etc.) and the
# frontend loads them on demand. Threshold is bytes of the unified payload.
SPLIT_THRESHOLD_BYTES = 5 * 1024 * 1024  # 5 MB, per spec §8

# Heavy arrays are the ones likely to exceed the budget; we prefer to split
# these first.
SPLIT_CANDIDATES_ORDER = ["sales", "bcg_spend", "weekly_sfr", "daily_sfr",
                          "weekly_catalogue", "influencer"]

# Platform display order — Amazon always first (rank-based, special).
def platform_sort_key(p: str) -> tuple:
    p = (p or "").strip()
    return (0, "") if p == "Amazon" else (1, p.lower())
