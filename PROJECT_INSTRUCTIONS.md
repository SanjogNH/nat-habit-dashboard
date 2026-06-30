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

### 4.3 Branded / Generic bucketing — split by tab

The `Search Query Type` column is bucketed differently depending on
which tab consumes the row.

**Two-way bucket** — used by **Weekly SFR Movement**, **Search Movement
tab**, and **Impressions & Brand Share tab**:

- `Brand` → Branded
- anything else (`Generic`, `Comp`, blank) → Generic

Function: `to_branded_bucket` (Python) / `toBrandedBucket` (JS).

**Three-way bucket** — used **only by BCG Data → Spend tab**:

- `Brand` → Branded
- `Generic` → Generic
- anything else (`Comp`, blank, unknown labels) → **Other**

Function: `to_spend_bucket` (Python) / `toSpendBucket` (JS).

Spend tab charts have four lines — Branded, Generic, Other, Total — and
the table mirrors that with four value/Δ pairs. The Impressions and
Search Movement segmented controls remain three-option (Both / Branded /
Generic).

The JSON field name `branded_bucket` is reused for both schemes; its
domain depends on the source tab.

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
- **Frozen identifier columns.** For wide tables that scroll horizontally
  through many period columns (Search Movement Top Keywords, the All
  Keywords modal), the leading identifier columns (`#`, Keyword,
  Category) are CSS-sticky on the left. They remain visible while the
  user scrolls through Week15 → Week26 → …, with row-hover backgrounds
  matched and a subtle border separating the frozen zone. Driven by
  `sticky-col-{1,2,3}` classes on both header and body cells.
- **Active-filter chips above every table.** See §6.1 — when any filter
  is narrowed, a chip row appears above each table reflecting the
  current filter state, each chip clearable individually.

### 5.1 Search Movement (default landing tab)

- **Filter bar:** date range, granularity toggle (Daily / Weekly), platform
  multi-select, **category multi-select**, **keyword multi-select**
  (tab-wide, no cap), branded/generic filter (Both / Branded / Generic),
  rank/volume toggle (Weekly only, when Amazon is in the platform set).
- **Behaviour:**
  - Daily uses `Daily SFR` (only a subset of keywords exists daily).
    Weekly uses `Weekly SFR Movement`.
  - For Amazon, the metric is Search Frequency Rank (lower = better,
    y-axis reversed). For all other platforms, Search Query Volume
    (higher = better). Amazon cannot be combined with volume-based
    platforms in the same chart — show a warning and disable platform
    combinations that mix rank and volume.
  - The Category filter restricts which keywords are considered for
    both the Top Keywords table and the Keyword Trend chart.
  - The Keyword filter cascades from Category — its options refresh to
    show only keywords whose category passes the Category filter.
    Picking nothing (or everything) means "all keywords".
- **Panels (in order):**
  1. **Top Keywords table** — top 10 keywords by the active sort column.
     Default sort is the latest period (ascending in rank mode,
     descending in volume mode). Columns: `#`, Keyword, Category, one
     column per week/day in the **full** date range, Movement. The table
     is wrapped in a horizontal-scroll container so wider ranges remain
     readable. Every column header except `#` and `Movement` is
     clickable; clicking re-sorts the table and recomputes which 10
     keywords are shown (e.g., sorting by `Week21` shows the top 10 for
     Week 21). Clicking a sorted column again flips direction; clicking
     a third time reverts to default sort. A "View full list" button
     opens a modal with all keywords sharing the same column set and
     sort spec.
  2. **Keyword Trend chart** — multi-keyword overlay across the date range.
     **X-axis:** week / day labels (time, ascending left → right). **Y-axis:**
     the metric — rank for Amazon, search volume for other platforms.
     Neither axis is reversed; the line's direction matches the metric's
     natural direction:
     - **Rank mode** (Amazon): lower rank = better, so a **dropping** line
       means a keyword's rank is improving. The Y-axis does not start at
       zero — rank values cluster far from zero and a 0-floor would
       visually compress them.
     - **Volume mode**: higher = better, so a **rising** line means volume
       is increasing. Y-axis starts at zero (standard for amount charts).
     The chart's keyword picker (max 10) draws its option list from the
     keywords that pass the tab-wide Category + Keyword filters. Tooltip
     and table movement arrows still read semantically (↑ = improvement
     regardless of which direction that is for the metric in question),
     so `↑ 28` on the table still means "rank improved by 28 positions."
     CSV/Excel download of the underlying long-format data.

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
  / Category / Subcategory / SKU), **dimension multi-select**
  (searchable; visible when view-level ≠ Overall; multi-selection sums).
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
  / Category / Subcategory / Marketing Channel), **dimension
  multi-select** (searchable; appears when view-level ≠ Overall;
  multi-selection sums — picking three categories produces one set of
  lines summed across them).
- **Chart + table pairs** (each chart shows four lines: Branded,
  Generic, **Other**, Total — per the 3-way Spend bucketing in §4.3):
  1. Spend (₹)
  2. Sales (₹, ad-attributable)
  3. ROAS (= Sales / Spend; null when Spend = 0)
- Tables alongside show all four values per period plus the deltas.
  When no rows fall into the Other bucket (e.g. the source only
  contains `Brand` and `Generic`), the Other line draws as flat / empty
  rather than disappearing — keeps the column structure stable.

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
- **Granularity:** where applicable — Daily / Weekly / Monthly. Always a
  segmented single-choice control (not multi-select — semantically a
  user can only be looking at one granularity at a time).
- **View level** (Business, Spend): segmented single-choice control for
  the same reason.
- **Multi-selects** (Platforms, Categories, Sub-categories, SKUs,
  Keywords, Influencers, Campaigns, dimension picker): all use the same
  widget factory in `filters.js` with these defaults:
  - **Searchable** — every dropdown has a sticky search box at the top.
  - **Select all / Clear all** action buttons in the same header row.
    With a search query active, both actions operate on just the
    currently-visible matches; cleared search means operate on the
    full option list.
  - Trigger label reflects selection count: "All X (N)", "1 selected",
    "K selected", or the placeholder when nothing's selected.
- **Category, Subcategory:** cascading multi-selects (selecting
  categories filters the subcategory list).
- **Cascading filters — general rule.** Wherever parallel filters for
  Category / Subcategory / SKU / Keyword exist on the same tab, the child
  filter's option list is computed from the actual data rows under the
  current parent selection (not a static mapping), so it tracks mapping
  changes in the source sheet. When a parent change orphans a child
  selection (e.g. user had "SKU X" picked under "Henna Total" and then
  switched to "Skincare"), the orphaned child auto-deselects and the
  user gets a toast: *"Removed N item(s) not in selected …"* with a
  sample of up to 3 names. Search Movement applies Cat → Keyword;
  Impressions applies Cat → Subcat → (implicit) SKU.
- **Active-filter chips above each table.** When any filter is narrowed
  from its "all" / default state, an interactive chip row appears above
  every table on the tab, showing the active filters as small pills:
  `Date: 01 Apr '26 – 27 Jun '26`, `Platforms: Amazon, NH.in`,
  `Categories: Henna Total`, etc. Each chip has an `×` that resets that
  single filter to its "all" state and re-renders. Chips are
  data-driven from `LocalState`, so they stay in sync with the filter
  bar regardless of which control was the source of the change. The
  Search Movement "All keywords" modal also carries chips so filter
  context is visible while drilling.
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
load on demand. In split mode, the main payload carries
`_external` sentinel objects (e.g. `"weekly_sfr": { "_external":
"weekly_sfr.json" }`) in place of the inline arrays.

**Sentinel resolution at boot.** `dashboard.js`'s `boot()` calls
`preloadSentinels()` immediately after the main payload loads. This
walks every known tab key (except `sales`, which stays lazy by design
for the Business tab) and, for any field that is an `_external`
sentinel, fetches its side file and **overwrites the sentinel in
`State.data` with the resolved array in-place**. The invariant
afterward: by the time any tab module touches `State.data.<key>`, that
field is guaranteed to be either an array or undefined — never an
object. This eliminates the class of bugs where
`for (const r of State.data.weekly_sfr || [])` would throw "object is
not iterable" because the `|| []` fallback doesn't kick in for a
truthy non-iterable. A `getRows(tabKey)` helper is also exported as
the canonical synchronous accessor for new code.

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
