# Nat Habit Sales & Marketing Analytics Dashboard — Project Instructions

> Source of truth for the dashboard build. Keep this file in the repo root.
> Any change to scope, calculations, or behavior must be reflected here first.

---

## 1. Purpose

A single, mobile-friendly web dashboard that pulls Nat Habit's sales and
marketing data from a Google Sheet, refreshes itself automatically twice a
day, and presents five views — Search Movement, Impressions & Brand Share,
Business, Spend, and Influencer — with date-range filters, drill-down by
platform / category / sub-category / SKU, downloadable tables, and a chart
per metric.

The audience is internal (marketing and leadership). It is gated by a
cosmetic password.

---

## 2. Architecture

### 2.1 Stack

- **Frontend:** static HTML + vanilla JavaScript + Chart.js. No React, no
  build step on the frontend. Hosted on GitHub Pages from the `main` branch.
- **Backend:** none at runtime. A Python pipeline runs in GitHub Actions,
  fetches the Google Sheet, computes derived fields, writes a JSON file, and
  commits it back to the repo.
- **Data source:** one Google Sheet with six tabs, made readable via
  "Anyone with the link → Viewer."
- **Refresh model (hybrid):**
  - **Scheduled:** GitHub Action runs at 1 PM IST and 5 PM IST every day.
  - **On-demand:** `workflow_dispatch` trigger so it can be re-run from
    the Actions tab.
  - **Live:** a "Refresh" button in the dashboard that fetches CSV
    directly from the sheet in the browser, bypassing the committed JSON,
    for users who want up-to-the-minute numbers.

### 2.2 File structure

```
repo-root/
├─ .github/
│  └─ workflows/
│     └─ refresh.yml             # Cron: 1 PM & 5 PM IST + workflow_dispatch
├─ data/
│  └─ dashboard_data.json        # Committed by the Action
├─ fetch_data.py                 # Pulls all six sheets via gviz CSV
├─ calculate.py                  # Normalizes + derives + writes JSON
├─ build_dashboard.py            # Orchestrator (calls fetch + calculate)
├─ config.py                     # Sheet ID, sheet tab names, constants
├─ requirements.txt              # pandas, requests
├─ index.html                    # Password gate (entry point)
├─ dashboard.html                # The 5-tab dashboard
├─ assets/
│  ├─ css/dashboard.css
│  ├─ js/dashboard.js
│  ├─ js/charts.js
│  ├─ js/downloads.js
│  ├─ js/filters.js
│  └─ img/logo.svg               # Nat Habit wordmark (placeholder until provided)
└─ README.md
```

### 2.3 Data flow

1. GitHub Action wakes up at 1 PM or 5 PM IST (or is triggered manually).
2. `build_dashboard.py` calls `fetch_data.py` → pulls all 6 tabs as CSV
   from Google Sheets.
3. `calculate.py` normalizes types, joins mapping tables, derives week
   numbers, branded/generic buckets, etc.
4. Output: `data/dashboard_data.json` (single file, ~1–10 MB depending on
   data volume).
5. Action commits the JSON back to `main`. GitHub Pages redeploys
   automatically.
6. User opens the site → sees `index.html` (password gate) → on success,
   `dashboard.html` loads `data/dashboard_data.json` and renders.
7. User clicks Refresh button → frontend fetches the 6 sheets live via
   gviz CSV endpoint, re-runs the same calculations in JS, replaces
   in-memory state. Does not commit anything.

---

## 3. Google Sheet structure

The sheet ID lives in `config.py` and is read by the Python pipeline. Tab
names must be exact.

### 3.1 Tab: `Daily SFR`

Daily search keyword data. Only a subset of keywords have daily data.

| Column | Type | Notes |
|---|---|---|
| Channel | string | Platform name |
| Date | date (DDMMYYYY) or Excel serial | Parser must handle both |
| Search Frequency Rank | int | Amazon = rank (lower = better, not summable); other platforms = volume (higher = better, summable at category/sub-category) |
| Search Term | string | The keyword |
| Category | string | |
| Subcategory | string | |
| (Other columns) | — | Ignored |

### 3.2 Tab: `Weekly SFR Movement`

Rich weekly keyword data. This is the analytical backbone of the
Impressions tab.

| Column | Type | Notes |
|---|---|---|
| Channel | string | |
| Week | string | Format `Week23` (2026 W1 = Sunday 28-Dec-2025 to Saturday 3-Jan-2026) |
| Search Query | string | |
| Search Query Type | string | Values: `Brand`, `Comp`, `Generic`. Map to two-way split: `Brand` → Branded; `Comp` + `Generic` → Generic |
| Category | string | |
| Subcategory | string | |
| Search Frequency Rank | int | Amazon only; blank for others |
| Search Query Volume | int | |
| Impressions: Total Count | int | |
| Impressions: Brand Share % | float | |
| Clicks: Total Count | int | |
| Clicks: Brand Share % | float | |
| (Many other columns) | — | Ignored for v1; preserved in JSON in case of future use |

### 3.3 Tab: `Weekly Catalogue Performance`

Weekly impressions per SKU.

| Column | Type | Notes |
|---|---|---|
| Channel | string | |
| Week | string | Same week format as 3.2 |
| Short Code | string | Product display name |
| NH SKU | string | Unique SKU code |
| Category | string | |
| Subcategory | string | |
| Impressions: Impressions | int | |
| (Other columns) | — | Ignored |

### 3.4 Tab: `Influencer Data`

Daily influencer campaign performance. No platform field — reel views are
cross-platform.

| Column | Type | Notes |
|---|---|---|
| Date | date | |
| Influencer Name | string | |
| Category | string | The category the campaign was about |
| Ad Name | string | Campaign name |
| Views | int | |
| Likes | int | |
| Comments | int | |
| Shares | int | |

### 3.5 Tab: `Sales Data`

Daily SKU-level sales.

| Column | Type | Notes |
|---|---|---|
| Platform | string | |
| Date | date | |
| NH SKU | string | |
| Category | string | |
| Subcategory | string | |
| Glance Views | int | a.k.a. page views |
| Gross Units | int | |
| Revenue | float | ₹ |

### 3.6 Tab: `BCG Data`

Daily spend and ad-attributable sales.

| Column | Type | Notes |
|---|---|---|
| Channel | string | |
| Date | date | |
| Category | string | |
| Subcategory | string | |
| Search Query Type | string | `Brand` → Branded; other values → Generic |
| Marketing Channel | string | |
| Spend | float | ₹ |
| Sales | float | ₹ (ad-attributable sales, used for ROAS) |

---

## 4. Data normalization rules

These run inside `calculate.py` before writing JSON.

### 4.1 Dates

- Accept both `DD-MM-YYYY` / `DD/MM/YYYY` strings and Excel serial integers
  (e.g. `46188`).
- Normalize to ISO `YYYY-MM-DD` in the JSON output.
- Excel serial epoch: 30-Dec-1899 (correct for Google Sheets export).

### 4.2 Week numbering

- Anchor: Sunday 28-Dec-2025 = Week 1 of 2026.
- For any date, compute the Sunday of that week, then
  `(sunday - anchor).days // 7 + 1`.
- Output for each week:
  `{ "week_num": 23, "label": "Week23", "start": "2026-06-07", "end": "2026-06-13", "range_display": "07 Jun – 13 Jun '26" }`.
- When a date-range filter is applied to weekly data: include only weeks
  fully contained in the range (both `start` and `end` inside the picker's
  from–to).

### 4.3 Branded vs Generic (two-way split)

- Source columns: `Search Query Type` (Weekly SFR Movement, BCG Data).
- `Brand` → Branded.
- Anything else (`Comp`, `Generic`, blank) → Generic.

### 4.4 Subcategory naming

Standardize column name to `Subcategory` (one word) throughout JSON and
UI, regardless of how the sheet spells it (`Sub-Category`, `Sub category`,
etc.).

### 4.5 Platform list

Read dynamically from the data. Never hardcode. Sort order: alphabetical,
except put `Amazon` first if present (it's rank-based and special).

### 4.6 Numbers

Strip commas and `₹` symbols before parsing. Treat blanks and non-numeric
as `null`, not `0`. The chart layer decides whether to `spanGaps` or show
zero.

### 4.7 Joining mapping tables

`Keyword Mapping` and `SKU Mapping` exist in some versions of the sheet.
If present, join Category / Subcategory from them onto the corresponding
rows. If absent, use whatever the data tabs themselves carry. Document any
rows where the join produces a category mismatch.

---

## 5. The five tabs — detailed specifications

Layout for every tab:

- Top: filter bar (date range, granularity, platform multi-select, plus
  tab-specific filters).
- Below: a stack of chart + table pairs, one pair per metric. Each chart
  is followed by its own table; each table has its own CSV + Excel
  download button.
- Tables show newest period first by default.
- Charts are continuous line graphs across the selected date range at the
  chosen granularity. Missing data points = null with `spanGaps: true`.

### 5.1 Search Movement (default landing tab)

- **Filter bar:** date range, granularity toggle (Daily / Weekly), platform
  multi-select, branded/generic filter (Branded / Generic / Both),
  search-keyword multi-select (max 10 for the trend chart).
- **Behaviour:**
  - Daily uses `Daily SFR` (only a subset of keywords exists daily).
    Weekly uses `Weekly SFR Movement`.
  - For Amazon, the metric is Search Frequency Rank (lower = better,
    y-axis reversed). For all other platforms, Search Query Volume
    (higher = better). Amazon cannot be combined with volume-based
    platforms in the same chart — show a warning and disable platform
    combinations that mix rank and volume.
- **Panels (in order):**
  1. **Top Keywords table** — current period's top 10 by rank (Amazon) or
     volume (others), with their movement vs previous period (delta +
     arrow). Includes a "View full list" expand button.
  2. **Keyword Trend chart** (the "old-fashioned" multi-keyword overlay)
     — line chart with up to 10 selected keywords as separate lines,
     x-axis = the chosen granularity over the date range. CSV/Excel
     download of the underlying long-format data.

### 5.2 Impressions & Brand Share

Source: Weekly SFR Movement (keyword level) + Weekly Catalogue Performance
(SKU level). **Weekly granularity only.**

- **Filter bar:** date range, platform multi-select, branded/generic
  filter (applies to keyword section), category multi-select, subcategory
  multi-select.

- **Section A — Keyword-level (top):**
  - Chart + table pair: Total Impressions over weeks (sum across keywords
    in current filter).
  - Chart + table pair: Brand Impression Share % over weeks (weighted
    average by Total Impressions).
  - Chart + table pair: Total Clicks over weeks.
  - Chart + table pair: Brand Click Share % over weeks (weighted by Total
    Clicks).
  - Below each: the per-week table with delta-vs-prev-week pill.

- **Section B — SKU-level (bottom):**
  - Chart + table pair: SKU Impressions over weeks. The chart can show
    top-N SKUs (default 10) as separate lines, with a "show more"
    affordance. Filter by SKU multi-select.

### 5.3 Business

Source: Sales Data + Spend total from BCG Data (joined on date + platform
+ category/subcategory where possible). Spend is only available at
Category / Subcategory level, not SKU, so at SKU view the Spend chart
shows "N/A at SKU level."

- **Filter bar:** date range, granularity toggle (Daily / Weekly /
  Monthly), platform multi-select, view-level segmented control (Overall
  / Category / Subcategory / SKU), dimension dropdown (visible when
  view-level ≠ Overall).
- **Chart + table pairs (in order):**
  1. Page Views (Glance Views)
  2. Units Sold (Gross Units)
  3. Revenue (₹)
  4. Spend (₹) — hidden / shown as "N/A at SKU level" when SKU is
     selected
- Each pair has its own download buttons.

### 5.4 Spend

Source: BCG Data.

- **Filter bar:** date range, granularity toggle (Daily / Weekly /
  Monthly), platform multi-select, view-level segmented control (Overall
  / Category / Subcategory / Marketing Channel), dimension dropdown.
- **Chart + table pairs** (each chart shows three lines: Branded,
  Generic, Total):
  1. Spend (₹)
  2. Sales (₹, ad-attributable)
  3. ROAS (= Sales / Spend; null when Spend = 0)
- Tables alongside show all three values per period plus the deltas.

### 5.5 Influencer

Source: Influencer Data + (for correlation) Weekly SFR Movement and Sales
Data joined on Category.

- **Filter bar:** date range, category multi-select (drives the
  correlation join), influencer multi-select (optional), campaign
  multi-select (optional).
- **Panel layout:**
  1. **Campaign performance** — chart + table pairs for:
     - Views
     - Likes
     - Comments
     - Shares
  2. **Campaign list table** — every campaign in the filtered range with
     influencer, category, ad name, date, the four counts, and a computed
     Pre/Post Lift. CSV + Excel download.
  3. **Correlation overlay** — two charts:
     - Impressions movement for the selected categories over the date
       range, with vertical markers at each campaign date in those
       categories (hover marker → tooltip showing influencer + ad name +
       views).
     - Search keyword movement for the selected categories — line chart
       of the top keywords in those categories, same campaign markers
       overlaid.
- **Pre/Post lift calculation:** for each campaign, compare the 7 days
  before the campaign date vs the 7 days after, on (a) Impressions sum
  for the campaign's category and (b) Sales revenue sum for the
  campaign's category. Output as a delta and a % change. Show in the
  campaign list table.

---

## 6. Cross-cutting features

### 6.1 Filters

- **Date range:** from–to date picker. Default = last 90 days. Min/max
  bounded by data extent.
- **Granularity:** where applicable — Daily / Weekly / Monthly.
- **Platform:** multi-select with "All" option, dynamic from data.
- **Category, Subcategory:** cascading multi-selects (selecting categories
  filters the subcategory list).
- All filters persist within a session (sessionStorage) and reset on
  logout/refresh.

### 6.2 Refresh button

Visible in the top nav once logged in. Behaviour:

- Shows a spinner + "Refreshing" label.
- Fetches all 6 sheets live via the gviz CSV endpoint.
- Re-runs the same calculations as the Python pipeline (JS port in
  `calculate.js`).
- Replaces in-memory state, re-renders everything.
- Updates the "Last updated" timestamp in the header to "just now (live)".
- Does NOT commit anything.

The header also shows the JSON file's `last_updated` value as
"Last refresh: 17 Jun, 1:00 PM IST" so the user knows the baseline.

### 6.3 Downloads

Every visible table has two buttons:

- **CSV** — flat dump of the filtered table.
- **Excel** — formatted `.xlsx`. For complex tabs (Spend, Business), the
  workbook contains:
  - Sheet 1: the visible table.
  - Sheet 2: the raw filtered records for that tab.
  - Sheet 3: filter context (what date range, platforms, etc. were
    applied).

Use the `SheetJS` (xlsx) library, loaded from CDN, for client-side Excel
generation. If a workbook generation exceeds 3 seconds, fall back to a
plain `.xlsx` of just the visible table.

### 6.4 Login

- `index.html` is a password page. Input field, submit button, Nat Habit
  branding, error state on wrong password.
- Password is hardcoded in a JS constant (cosmetic only — accepted
  limitation). Optionally hashed with SHA-256 so the cleartext isn't
  obvious in source.
- On success, set `sessionStorage.setItem('authed', 'true')` and redirect
  to `dashboard.html`.
- `dashboard.html` checks the flag on load; if missing, redirect back to
  `index.html`.
- A "Logout" link in the top nav clears the flag and redirects.

---

## 7. Design & branding

### 7.1 Color palette (starting point — tune to logo if needed)

| Token | Hex | Usage |
|---|---|---|
| `--brand-primary` | `#BD5A35` | Terracotta. Buttons, active states, primary chart line |
| `--brand-secondary` | `#9CAF99` | Sage. Secondary chart line, success states |
| `--brand-accent` | `#F2E1CF` | Warm cream. Soft backgrounds, hover states |
| `--brand-deep` | `#1F2A22` | Deep forest. Headlines, body text |
| `--brand-bg` | `#FDFBF7` | Off-white page background |
| `--brand-border` | `#E8E0D5` | Subtle dividers |
| `--brand-muted` | `#7A7268` | Secondary text, captions |
| `--up` | `#3F8A5C` | Positive delta |
| `--down` | `#C04A3A` | Negative delta (warmer than red to match palette) |

### 7.2 Typography

- Body and UI: **Nunito** (Google Fonts) — warm, friendly, rounded
  sans-serif that matches the Nat Habit voice.
- Numbers in tables/KPIs: Nunito with `font-feature-settings: 'tnum'` for
  tabular figures.
- Headings: same Nunito at heavier weights (600–700).
- If the user later supplies a brand font, swap by changing one CSS
  variable.

### 7.3 Logo

Use lowercase wordmark "nat habit" with "BREATHE LIFE" tagline below it
in the top-left of the nav. Provide an SVG placeholder; replace with the
official asset when available.

### 7.4 Mobile design

- Breakpoint: `< 768px` = mobile.
- Top nav collapses to a hamburger that opens the tab switcher as a
  vertical list.
- Filter bar wraps to a single column.
- Charts use `maintainAspectRatio: false` and a min-height of 260px on
  mobile, 360px on desktop.
- Tables scroll horizontally inside a container — never overflow the
  viewport.
- Touch-friendly tap targets: minimum 44 × 44 px for buttons.

### 7.5 Chart readability requirements

- Use distinct, color-blind-friendly palette for multi-series charts
  (Okabe-Ito or similar).
- Axes: always show units (`₹`, `%`, `units`, `views`).
- Y-axis tick formatting: `1L`, `1.2 Cr` for INR amounts > 1 lakh.
- Hover tooltip: shows period label + all series values + their deltas
  vs previous period.
- Legend at top, with click-to-toggle series visibility.
- For each chart, a small "ⓘ" icon explains the metric definition in a
  tooltip.

---

## 8. JSON output schema

`data/dashboard_data.json`:

```jsonc
{
  "metadata": {
    "last_updated_iso": "2026-06-17T13:00:00+05:30",
    "last_updated_display": "17 Jun 2026, 1:00 PM IST",
    "sheet_id_preview": "1tbd...d0w",
    "row_counts": { "daily_sfr": 12450, "weekly_sfr": 3210, /* ... */ },
    "date_range": { "min": "2025-12-28", "max": "2026-06-17" },
    "platforms": ["Amazon", "NH.in", "Flipkart", "Nykaa", "Blinkit", "Instamart", "Zepto"],
    "categories": ["Henna", "Skincare", "Haircare", "..."],
    "subcategories_by_category": { "Henna": ["Henna Total"], "...": "..." }
  },
  "weeks": [
    { "week_num": 23, "label": "Week23", "start": "2026-06-07", "end": "2026-06-13", "range_display": "07 Jun – 13 Jun '26" }
  ],
  "daily_sfr": [ /* normalized rows */ ],
  "weekly_sfr": [ /* normalized rows */ ],
  "weekly_catalogue": [ /* normalized rows */ ],
  "influencer": [ /* normalized rows */ ],
  "sales": [ /* normalized rows */ ],
  "bcg_spend": [ /* normalized rows */ ]
}
```

If file size exceeds 5 MB, split into separate JSON files per tab and
load on demand.

---

## 9. GitHub Actions workflow

`.github/workflows/refresh.yml`:

```yaml
name: Refresh dashboard data

on:
  schedule:
    # 1 PM IST = 07:30 UTC; 5 PM IST = 11:30 UTC
    - cron: '30 7 * * *'
    - cron: '30 11 * * *'
  workflow_dispatch: {}

permissions:
  contents: write

jobs:
  refresh:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: '3.11'
          cache: pip
      - run: pip install -r requirements.txt
      - run: python build_dashboard.py
      - name: Commit updated data
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git add data/dashboard_data.json
          if ! git diff --staged --quiet; then
            git commit -m "Refresh dashboard — $(date -u '+%d %b %Y %H:%M UTC')"
            git push
          fi
```

---

## 10. Acceptance criteria

The build is "done" when:

1. Opening the GitHub Pages URL shows the password page with Nat Habit
   branding.
2. Correct password loads `dashboard.html`; Search Movement is the active
   tab.
3. All five tabs render with their specified chart + table pairs.
4. Date range picker on every tab restricts the data correctly (weeks
   only fully-contained on weekly grain).
5. Branded / Generic split appears wherever specified, mapping `Brand` →
   Branded and others → Generic.
6. Platform multi-select is data-driven and never hardcodes a list.
7. Every table has working CSV and Excel download buttons that respect
   the current filter state.
8. Refresh button performs a live CSV fetch and updates the header
   timestamp to "just now (live)".
9. The GitHub Action runs successfully at 1 PM and 5 PM IST, commits an
   updated JSON, GitHub Pages picks it up.
10. The dashboard is usable on a 375 px wide mobile viewport: no
    horizontal page scroll, all charts legible, tables scroll inside
    their container, hamburger nav works.
11. Logout link clears auth and returns to password page.
12. No console errors on any tab; charts redraw cleanly after every
    filter change without memory leaks (Chart.js instances destroyed
    before re-creation).

---

## 11. Known limitations & future work

- **Login is cosmetic.** A determined viewer can inspect the JS and read
  the data URL. For real protection, move to a Cloudflare Worker auth
  proxy in front of the sheet.
- **Live refresh re-runs all calculations in JS.** If the dataset grows
  beyond ~50k rows, live refresh may become slow on mobile. At that
  point, split the JSON into per-tab files and consider Web Workers.
- **Influencer correlation is at Category level only** — Influencer Data
  has no Subcategory or Platform. Adding either upstream would let us
  drill further.
- **Pre/post lift uses a fixed 7-day window.** Make this configurable in v2.
- **No comparison view** (e.g., "this month vs last month side by side").
  Deferred to v2.

---

*End of instructions. Update this document before changing scope.*
