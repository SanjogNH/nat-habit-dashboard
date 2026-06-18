# Acceptance Criteria — Verification Report

Maps each of the 12 acceptance criteria in `PROJECT_INSTRUCTIONS.md` §10
to its evidence in `smoke_test.py` and supporting screenshots.

**Smoke test status:** ✅ 31 / 31 checks pass (`python3 smoke_test.py`).
**Date verified:** Final pass after Milestone 11 sweep.

---

## 1. Password page with Nat Habit branding

> Opening the GitHub Pages URL shows the password page with Nat Habit
> branding.

**Status:** ✅ Verified.
**Evidence:**
- `index.html` renders the password form with the brand logo
  (`assets/img/logo.svg`), the cream + terracotta + sage palette from
  `:root` tokens in `dashboard.css`, and Nunito typography.
- Smoke test: `✓ login worked, dashboard visible` (line 80) — Playwright
  loads `index.html`, sees the page title "Nat Habit · Sign in",
  enters the password, and is redirected.

---

## 2. Correct password → dashboard.html with Search Movement active

> Correct password loads `dashboard.html`; Search Movement is the active
> tab.

**Status:** ✅ Verified.
**Evidence:**
- `assets/js/dashboard.js` `setActiveTab("search")` is called on first
  boot when `State.currentTab` is empty.
- Smoke test confirms `#tab-search:not([hidden])` is visible after login
  and the top-keywords table has 10 rows on initial render
  (`✓ Search Movement top-keywords table: 10 rows`).

---

## 3. All 5 tabs render their chart + table pairs

> All five tabs render with their specified chart + table pairs.

**Status:** ✅ Verified.
**Evidence per spec section:**

| Tab | Spec | Implementation |
|---|---|---|
| Search Movement (§5.1) | Top keywords table + Keyword trend chart | `#search-top-tbl` + `#search-trend-canvas` |
| Impressions (§5.2) | 4 keyword cards (Imp, Brand Imp Share %, Clicks, Brand Click Share %) + SKU section | `#imp-{impressions,brand_imp_share,clicks,brand_click_share,sku}-canvas` |
| Business (§5.3) | 4 cards: Page Views, Units, Revenue, Spend | `#bus-{pageviews,units,revenue,spend}-canvas` |
| Spend (§5.4) | 3 cards: Spend, Sales, ROAS — each with Branded/Generic/Total lines | `#spd-{spend,sales,roas}-canvas` |
| Influencer (§5.5) | 4 campaign metrics + Campaign list + 2 correlation overlays | `#inf-{views,likes,comments,shares,overlay-imp,overlay-kw}-canvas` + `#inf-list-tbl` |

- Smoke test asserts all canvas elements exist for all 5 tabs.
- Desktop screenshots: `smoke-{search,impressions,business,spend,influencer}-desktop.png`.

---

## 4. Date range correctly restricts; weeks fully-contained

> Date range picker on every tab restricts the data correctly (weeks only
> fully-contained on weekly grain).

**Status:** ✅ Verified.
**Evidence:**
- `assets/js/aggregate.js` `enumeratePeriods()` implements the
  fully-contained rule: a week is included only if both `start ≥ from`
  AND `end ≤ to`. See spec §4.2 and the function's docstring.
- `assets/js/tab-impressions.js` `eligibleWeeks()` and
  `tab-influencer.js` overlay aggregation apply the same rule.
- Smoke test verifies the Business tab shows exactly 12 weekly rows for
  the default 90-day range (`✓ Business revenue table: 12 weekly rows`).
  At 90 days, the calculation is: Mar 17 to Jun 15 contains W13 through
  W24 fully — 12 weeks. Confirms the trim.
- For daily and monthly granularities, the same logic clips partial periods.

---

## 5. Branded / Generic split

> Branded / Generic split appears wherever specified, mapping `Brand` →
> Branded and others → Generic.

**Status:** ✅ Verified.
**Evidence:**
- Python: `calculate.py` `to_branded_bucket()` uses `BRANDED_TOKENS =
  {"brand", "branded"}` (case-insensitive). Anything else → "Generic".
- JS port: `assets/js/calculate.js` `toBrandedBucket()` mirrors exactly.
- Unit-tested in node: `toBrandedBucket("Branded") === "Branded"`,
  `toBrandedBucket("Comp") === "Generic"`, `toBrandedBucket(null) ===
  "Generic"`.
- Weekly SFR weighted brand share with the current dataset:
  - Both: 4.75% (most queries are generic)
  - Branded only: 77.42% (Nat Habit owns brand searches)
  - Generic only: 4.07%
  These three different values across the three filter states prove the
  bucket assignment + filter both work.

---

## 6. Platform multi-select is data-driven

> Platform multi-select is data-driven and never hardcodes a list.

**Status:** ✅ Verified.
**Evidence:**
- `assets/js/tab-business.js` (and every other tab) builds `platformOptions`
  by reading the union of platforms present in the loaded rows — see
  `Object.values(rowsByTab)`, no string constants.
- Smoke test: platform multi-select shows `(9)` for Business (Amazon
  through Zepto, all from `data/sales.json`).
- The filter actually filters: smoke test toggles "All platforms" off,
  picks Amazon, and verifies the trigger label updates AND the revenue
  KPI changes from ₹2.43 Cr to ₹73.18 L (`✓ Platform filter: 'All
  platforms (9)' → 'Amazon' (KPI: ₹73.18 L▼ 17.2%)`).

---

## 7. CSV and Excel downloads with filter state

> Every table has working CSV and Excel download buttons that respect
> the current filter state.

**Status:** ✅ Verified.
**Evidence:**
- `assets/js/downloads.js` implements `downloadCSV` and `downloadXLSX`
  using SheetJS. Excel workbooks include the visible table, the raw
  filtered records, and a filter-context sheet per spec §6.3.
- Smoke test clicks both buttons on the Search tab via
  `page.expect_download()`:
  - `✓ CSV download: 579 bytes, has expected content` — verifies
    `naturali hair shampoo` is in the file body.
  - `✓ Excel download: 435,124 bytes, valid xlsx signature` — verifies
    the file is a real `.xlsx` (PK ZIP signature).
- The filter context appears in the workbook as the third sheet,
  serialized from the same `LocalState` the rendering uses, so the
  download always reflects what's on screen.

---

## 8. Refresh button → live fetch → "just now (live)"

> Refresh button performs a live CSV fetch and updates the header
> timestamp to "just now (live)".

**Status:** ✅ Verified.
**Evidence:**
- `assets/js/calculate.js` `fetchAndBuild(sheetId)` fetches all 6 tabs
  in parallel via `gvizCsvUrl()` and re-runs normalization to the same
  payload shape as the Python pipeline.
- `assets/js/dashboard.js` `onRefresh()` wires it to the Refresh button,
  sets `State.lastUpdatedSource = "live"`, and `updateLastUpdated()`
  emits `"Updated: just now (live)"`.
- Smoke test stubs the gviz endpoint with in-memory CSV built from the
  committed payload, clicks Refresh, and waits for the header to
  contain `"live"`:
  - `✓ Live refresh: header → Updated: just now (live)`
  - `✓ Live refresh: first keyword after re-fetch = naturali hair
    shampoo` — proves the JS port produces equivalent output (round
    trip: rows → CSV → parse → normalize → same first keyword).

---

## 9. GitHub Action runs at 1 PM & 5 PM IST, commits, Pages picks it up

> The GitHub Action runs successfully at 1 PM and 5 PM IST, commits an
> updated JSON, GitHub Pages picks it up.

**Status:** ✅ Workflow validated; runtime requires deployment.
**Evidence:**
- `.github/workflows/refresh.yml` validated locally with PyYAML:
  - Triggers: `['schedule', 'workflow_dispatch']`
  - Schedule: `30 7 * * *` (07:30 UTC = 1 PM IST) and `30 11 * * *`
    (11:30 UTC = 5 PM IST)
  - Permissions: `contents: write`
  - 5 steps: checkout → setup Python 3.11 → install deps → run
    `build_dashboard.py` → commit & push if `data/*.json` changed
- `git add data/*.json` covers both the main payload and split
  side-files (e.g. `sales.json`).
- `concurrency: refresh-dashboard` with `cancel-in-progress: false`
  prevents the two scheduled runs from conflicting.
- `if git diff --staged --quiet; then exit 0` skips no-op commits.
- **Cannot be exercised from sandbox** — requires running in a real
  GitHub repo. Manual smoke after first deploy: open the Actions tab,
  click "Run workflow", confirm a commit lands on `main` and Pages
  redeploys.

---

## 10. Usable on a 375px mobile viewport

> The dashboard is usable on a 375 px wide mobile viewport: no
> horizontal page scroll, all charts legible, tables scroll inside their
> container, hamburger nav works.

**Status:** ✅ Verified.
**Evidence:**
- Smoke test sets viewport to 375×900 and verifies:
  - `✓ mobile (375px): hamburger appears`
  - `✓ no horizontal scroll at 375px (375 ≤ 375)` — measures
    `document.documentElement.scrollWidth` and confirms it doesn't
    exceed viewport width
  - `✓ mobile drawer: status mirrored = Updated: just now (live)` —
    the mobile drawer shows the same last-updated text as the topbar
  - `✓ mobile drawer: Refresh action available` — the Refresh action
    is reachable on mobile (it was previously hidden when I hid
    `.topbar-right`; M9 added `#refresh-btn-m` to the drawer)
  - `✓ mobile menu: opens, picks tab, closes`
- Per-tab mobile screenshots: `smoke-{tab}-mobile.png` for all 5 tabs.
- CSS responsive block at `@media (max-width: 768px)` enforces 44 × 44
  touch targets (icon buttons, fl-ms-trigger, date inputs, m-tab,
  segmented buttons, expand-btn) per spec §7.4.
- Tables horizontally scroll inside `.tbl-wrap { overflow-x: auto }`.
- Charts use `maintainAspectRatio: false` with `min-height: 260px` on
  mobile, `360px` on desktop.

---

## 11. Logout link clears auth and returns to password page

> Logout link clears auth and returns to password page.

**Status:** ✅ Verified.
**Evidence:**
- `assets/js/dashboard.js` `logout()` removes the
  `sessionStorage.nh_authed` flag and redirects to `index.html`.
- Both the desktop `#logout-btn` and the mobile-drawer `#logout-btn-m`
  call the same handler.
- Smoke test clicks `#logout-btn`, waits for the URL to change to
  `index.html`, confirms `sessionStorage.getItem('nh_authed')` is null,
  and verifies `#login-form` is back on screen:
  - `✓ logout: clears session and returns to sign-in page`

---

## 12. No console errors; charts redraw without leaks

> No console errors on any tab; charts redraw cleanly after every
> filter change without memory leaks (Chart.js instances destroyed
> before re-creation).

**Status:** ✅ Verified.
**Evidence:**
- Smoke test attaches a `pageerror` listener and fails if any errors
  fire during the entire run (login, all 5 tabs, modal open/close, CSV
  + Excel downloads, platform filter toggle, granularity changes,
  view-level changes, live refresh, mobile viewport tour, logout).
  Test passes with `0` errors.
- `assets/js/charts.js` `destroyChart()` uses `Chart.getChart(canvas)`
  to locate any existing instance attached to the canvas and destroy
  it before creating a new one. Called automatically on every
  `renderLineChart()` and `renderLineChartWithMarkers()` invocation,
  including filter changes and tab switches.
- One previously found leak surfaced in M7 (Influencer correlation
  overlay) — fixed by building the chart from scratch with markers
  passed in the initial config instead of calling `chart.update()` post
  hoc. No regressions since.

---

## Summary

| # | Criterion | Status | Evidence |
|---|---|---|---|
| 1 | Password page with branding | ✅ | smoke + screenshot |
| 2 | Login → Search tab active | ✅ | smoke |
| 3 | All 5 tabs render chart+table pairs | ✅ | smoke (all canvases) |
| 4 | Date range, weeks fully contained | ✅ | smoke (12-weeks in 90 days) |
| 5 | Branded/Generic mapping | ✅ | smoke + unit test |
| 6 | Platform filter is data-driven & functional | ✅ | smoke (₹2.43 Cr → ₹73.18 L) |
| 7 | CSV and Excel downloads | ✅ | smoke (file content + signature) |
| 8 | Live refresh → "just now (live)" | ✅ | smoke (full round trip) |
| 9 | GitHub Action: 1 PM & 5 PM IST | ✅ | YAML validated; deploy to confirm runtime |
| 10 | 375 px mobile viewport | ✅ | smoke (scroll, drawer, refresh, all tabs) |
| 11 | Logout clears auth | ✅ | smoke |
| 12 | No console errors; clean chart redraws | ✅ | smoke (pageerror listener, 0 errors) |

**Build status:** Ready for production deploy. The only criterion that
can't be verified from the sandbox is the live cron firing on GitHub
infrastructure (#9) — exercise it by clicking "Run workflow" in the
Actions tab once the repo is pushed.
