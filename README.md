# Nat Habit — Sales & Marketing Analytics Dashboard

A static, mobile-friendly internal dashboard that reads from a Google Sheet
and presents five views: **Search Movement**, **Impressions & Brand Share**,
**Business**, **Spend**, and **Influencer**. Refreshes twice a day from a
GitHub Action and also supports on-demand live refresh from the browser.

Hosted on **GitHub Pages**. No backend at runtime.

---

## How it works (one minute)

1. A Python pipeline (`build_dashboard.py`) pulls all six tabs from your
   Google Sheet via the public CSV endpoint, normalizes types, computes
   derived fields, and writes `data/dashboard_data.json`. Heavy arrays
   (like daily sales) are split into side-files when the main payload
   exceeds 5 MB.
2. A **GitHub Action** runs the pipeline at **1 PM and 5 PM IST** every day
   and commits the refreshed JSON back to `main`. GitHub Pages auto-redeploys.
3. The **frontend** (`index.html` → `dashboard.html`) reads `dashboard_data.json`
   on load and renders the dashboard with Chart.js.
4. A **Refresh button** in the top nav re-fetches the six sheets live in the
   browser, re-runs the same normalization in JS (`assets/js/calculate.js`),
   and updates the dashboard without going through Git. Useful when you want
   numbers fresher than the last scheduled commit.

Audience is internal (marketing + leadership). A cosmetic password gate
sits in front of the dashboard.

---

## Quick start (deploying for the first time)

### 1. Fork / clone this repo

You need a GitHub repo so the Action can commit refreshed data and Pages can
serve the site.

### 2. Get your Google Sheet ID and share it

From the sheet URL `https://docs.google.com/spreadsheets/d/THIS_PART/edit`,
copy `THIS_PART`. Then in Sheets click **Share → General access → "Anyone
with the link" → Viewer**.

### 3. Tell the pipeline which sheet to read

Two options — pick one:

**Option A (recommended): edit `config.py`.** Find the line:

```python
SHEET_ID = os.environ.get("SHEET_ID", "1tbdYMPGgsj9ZGunZejnGKRWOxJcSvHH53vZV5Nsed0w")
```

Replace the default with your sheet ID, commit, push.

**Option B: GitHub Secret.** Repo Settings → Secrets and variables → Actions →
New repository secret named `SHEET_ID`. The workflow reads it as an
environment variable that overrides `config.py`.

### 4. Make sure the sheet has the expected tabs

The pipeline expects exactly these tab names (case-sensitive):

| Tab name (exact) | Purpose |
|---|---|
| `Daily SFR` | Daily keyword rank/volume |
| `Weekly SFR Movement` | Weekly keyword performance — backbone of Impressions tab |
| `Weekly Catalogue Performance` | Weekly SKU impressions |
| `Sales Data` | Daily SKU sales |
| `BCG Data` | Daily ad spend & ad-attributable sales |
| `Influencer Data` | Daily campaign performance |

Column expectations are documented in `PROJECT_INSTRUCTIONS.md` §3.

### 5. Run the workflow once to seed `data/`

Repo → **Actions** tab → "Refresh dashboard data" → **Run workflow**.
After ~30 seconds, your `data/dashboard_data.json` (and possibly
`data/sales.json` for large datasets) is committed back to `main`.

### 6. Enable GitHub Pages

Repo Settings → Pages → Source: **Deploy from a branch** → Branch: `main` /
folder: `/ (root)`. Save. After a minute, your dashboard is live at
`https://<your-org>.github.io/<repo-name>/`.

### 7. Set the password

The default password is `changeme`. To change it:

```bash
echo -n "your-new-password" | sha256sum   # macOS: shasum -a 256
```

Paste the hex digest into `index.html` where `PASSWORD_SHA256` is defined.
Commit, push. See the [Customization](#customization) section for more.

---

## Project layout

```
├── index.html                    # Password gate (entry point)
├── dashboard.html                # 5-tab dashboard shell
├── assets/
│   ├── css/dashboard.css         # All styling: brand tokens, layout, responsive
│   ├── js/
│   │   ├── dashboard.js          # App bootstrap, auth, tab routing, refresh
│   │   ├── util.js               # Formatters, toast
│   │   ├── filters.js            # Reusable filter widgets
│   │   ├── charts.js             # Chart.js defaults, line chart factory
│   │   ├── downloads.js          # CSV + Excel export
│   │   ├── aggregate.js          # Period bucketing helpers
│   │   ├── calculate.js          # JS port of calculate.py (for live refresh)
│   │   ├── tab-search.js         # Search Movement
│   │   ├── tab-impressions.js    # Impressions & Brand Share
│   │   ├── tab-business.js       # Business (lazy-loads sales.json)
│   │   ├── tab-spend.js          # Spend
│   │   └── tab-influencer.js     # Influencer
│   └── img/logo.svg              # Nat Habit wordmark
├── data/
│   ├── dashboard_data.json       # Main payload (committed by the Action)
│   └── sales.json                # Side-file for large arrays (auto-split)
│
├── config.py                     # Sheet ID, tab names, week anchor
├── fetch_data.py                 # gviz CSV / local xlsx fetcher
├── calculate.py                  # Normalization + payload builder
├── build_dashboard.py            # Orchestrator: fetch → calculate → write
├── requirements.txt              # pandas, requests, openpyxl
│
├── .github/workflows/refresh.yml # Twice-daily cron + manual dispatch
├── smoke_test.py                 # End-to-end Playwright check (developer tool)
└── README.md                     # This file
```

---

## Local development

### Run the pipeline once

```bash
pip install -r requirements.txt
python build_dashboard.py
# Writes data/dashboard_data.json (and possibly data/sales.json) from your sheet.
```

If you don't want to hit the live sheet during development, point the
pipeline at a downloaded xlsx:

```bash
python build_dashboard.py --local path/to/Marketing_File.xlsx
```

### Serve the dashboard locally

The frontend is static — any HTTP server will do. The site needs HTTP
(not `file://`) because ES modules don't load over `file://`:

```bash
cd /path/to/repo
python -m http.server 8765
# Open http://localhost:8765
```

### Run the smoke test

```bash
pip install playwright
python -m playwright install chromium
python smoke_test.py
```

Smoke test starts a local HTTP server, drives Chromium through login,
every tab, the live-refresh path, and a 375px-wide mobile viewport.
It also captures one screenshot per tab on desktop and mobile
(`smoke-*-desktop.png`, `smoke-*-mobile.png`), gitignored by default.

---

## Refresh schedule

- **Scheduled (automatic):** 1 PM IST and 5 PM IST every day. UTC cron
  expressions `30 7 * * *` and `30 11 * * *` in `.github/workflows/refresh.yml`.
  Edit those lines if you want different times.
- **Manual:** Repo → Actions → "Refresh dashboard data" → Run workflow.
  Useful right after editing the sheet if you don't want to wait for the
  next scheduled run.
- **Live (in-browser):** Click the **Refresh** button in the top nav (on
  mobile, it's in the hamburger drawer). Fetches all six tabs via gviz CSV
  and re-runs normalization client-side. Doesn't commit anything; lives
  only in the current browser session and is replaced by the next scheduled
  commit. The header shows "Updated: just now (live)" when you're on
  live-fetched data vs. "Updated: 17 Jun 2026, 1:00 PM IST" for committed
  data.

---

## Customization

### Change the password

The password is checked client-side with a SHA-256 hash in `index.html`.
To rotate:

```bash
echo -n "your-new-password" | sha256sum                # Linux / WSL
# or:
shasum -a 256 <<< -n "your-new-password"               # macOS (note -n)
# or:
python -c 'import hashlib; print(hashlib.sha256(b"your-new-password").hexdigest())'
```

Paste the resulting hex digest into the `PASSWORD_SHA256` constant near the
top of `index.html`. Commit, push.

> ⚠️ **This is cosmetic, not secure.** A determined viewer who opens devtools
> can read the password hash and re-derive nothing useful, but they can also
> just inspect the network tab and read `data/dashboard_data.json` directly.
> The data on GitHub Pages is effectively public. For real protection, put
> the site behind a Cloudflare Worker or similar auth proxy.

### Change the brand palette

Open `assets/css/dashboard.css`. The first block (`:root { ... }`) holds all
brand tokens — terracotta, sage, cream, deep forest, etc. Edit one variable
and every tab updates.

### Change the sheet structure

If you add columns or rename tabs:

1. Edit `config.py` (`TABS` dict) to point at new tab names.
2. Edit `calculate.py` to read new columns in the relevant processor
   (`process_daily_sfr`, `process_sales`, etc.).
3. Edit `assets/js/calculate.js` so live refresh stays in sync with the
   Python pipeline.
4. Re-run the pipeline locally to verify.

Both `calculate.py` and `calculate.js` must produce the same payload shape
or live refresh and the committed data will drift.

### Customize what counts as "Branded"

Edit `BRANDED_TOKENS` in `config.py` (Python) and the matching
`BRANDED_TOKENS` set in `assets/js/calculate.js`. Default:
`{"brand", "branded"}`. Anything in the source's *Search Query Type* or
*Keyword Type* column that case-insensitively matches one of these is
treated as **Branded**; everything else is **Generic**.

### Change refresh times

Edit the two `cron:` lines in `.github/workflows/refresh.yml`. Cron is in
UTC. Add `5:30` to convert from UTC to IST.

---

## Troubleshooting

### Dashboard says "Couldn't load the dashboard data."

Most common causes:
- `data/dashboard_data.json` is missing — run the workflow once to seed it
  (Actions → Run workflow).
- You opened the dashboard via `file://`. Modules don't load there.
  Serve over HTTP (`python -m http.server`) or open the GitHub Pages URL.

### Refresh button toasts "Live refresh failed: HTTP 401" (or 403)

The sheet's sharing reverted to private. Open the sheet, **Share → General
access → "Anyone with the link" → Viewer**. The dashboard falls back to the
last committed data automatically, so the site stays usable.

### The Action ran but no new commit appeared

That means the latest sheet data normalized to exactly the same JSON as
what's already committed (e.g., no edits since last run). The workflow
skips empty commits by design. Check the run log for "No data changes —
nothing to commit."

### A tab shows weird "0" values where ranks should be

Amazon's *Search Frequency Rank* column uses `0` to mean "not in the ranked
set this week." Both `calculate.py` and `calculate.js` already null this
out. If you still see literal 0s, the source data may have rank=0 stored as
a real entry — confirm by inspecting the relevant row in the sheet.

### How do I figure out what week a date falls in?

Week 1 anchors on **Sunday 28-Dec-2025** by design (the first week of FY
2026). Week 23 = `31 May – 06 Jun 2026`. Change the anchor in `config.py`
(`WEEK1_START_ISO`) **and** in `assets/js/calculate.js`
(`WEEK1_ANCHOR_ISO` / `WEEK1_MS`) if you need a different starting point —
they must agree.

### A tab is empty even though the sheet has data

Open devtools → Console. If you see a normalization warning, the source
data probably has an unexpected column header. Check the matching processor
in `calculate.py` and the column the row reads — the spec lists exact
expected headers in `PROJECT_INSTRUCTIONS.md` §3.

### What about that big `sales.json` file?

When the main payload exceeds 5 MB the orchestrator splits heavy arrays
into side-files (currently `sales.json`). The frontend lazy-loads them
only when the relevant tab opens. The Action commits both files together
via `git add data/*.json`.

---

## Architecture notes (deeper dive)

- **No backend at runtime.** Everything renders client-side from one
  committed JSON file. The Action is the only "build" step.
- **Two-place normalization.** `calculate.py` runs on the schedule;
  `calculate.js` runs on Refresh. They mirror each other module-for-module
  and produce the same payload shape. Tests confirm: run smoke_test.py and
  it hits both paths.
- **Brand palette baked into CSS variables.** No JS-driven theming;
  changing one token in `:root {}` propagates everywhere.
- **Chart.js + SheetJS via CDN.** Loaded with `defer` so module scripts
  see them as globals when they execute. If a corporate network blocks
  jsdelivr, vendor the libs locally and update the script tags.
- **One stylesheet, one bundled HTML.** No build step on the frontend.
  Drop the repo onto any static host; it works.

---

## License & attribution

Internal Nat Habit project. Chart.js, SheetJS, and Nunito by their
respective authors — see vendor sites for licensing.
