"""
Smoke test for the dashboard frontend.

Runs the actual page in headless chromium:
  - Loads index.html, signs in with 'changeme'.
  - Confirms redirect to dashboard.html.
  - Captures any JS console errors.
  - Verifies Search Movement tab content renders (top table, chart canvas).
  - Switches between tabs, ensures no errors.
"""
import http.server
import socketserver
import threading
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).parent
PORT = 8765

class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args, **kwargs): pass

def serve():
    import os
    os.chdir(ROOT)
    httpd = socketserver.TCPServer(("127.0.0.1", PORT), QuietHandler)
    httpd.serve_forever()

def main():
    socketserver.TCPServer.allow_reuse_address = True
    t = threading.Thread(target=serve, daemon=True)
    t.start()

    errors = []
    warnings = []

    with sync_playwright() as p:
        browser = p.chromium.launch()
        ctx = browser.new_context(viewport={"width": 1280, "height": 900})
        page = ctx.new_page()

        # The sandbox blocks cdn.jsdelivr.net + Google Fonts. Reroute those
        # to local vendor copies so the production HTML can stay pristine.
        def reroute(route, req):
            url = req.url
            if "cdn.jsdelivr.net/npm/chart.js" in url:
                return route.fulfill(path=str(ROOT / "assets/vendor/chart.umd.js"),
                                     content_type="application/javascript")
            if "cdn.jsdelivr.net/npm/xlsx" in url:
                return route.fulfill(path=str(ROOT / "assets/vendor/xlsx.full.min.js"),
                                     content_type="application/javascript")
            if "fonts.googleapis.com" in url or "fonts.gstatic.com" in url:
                return route.fulfill(status=200, content_type="text/css", body="")
            return route.continue_()
        page.route("**/*", reroute)

        page.on("console", lambda msg: (
            errors.append(f"[{msg.type}] {msg.text}") if msg.type in ("error",)
            else warnings.append(f"[{msg.type}] {msg.text}")
        ))
        page.on("pageerror", lambda err: errors.append(f"[pageerror] {err}"))

        # --- index.html ---
        page.goto(f"http://localhost:{PORT}/", wait_until="networkidle")
        assert "Sign in" in page.title(), f"Expected sign-in title; got {page.title()!r}"

        page.fill("#pw", "changeme")
        page.click(".login-btn")
        page.wait_for_url(f"http://localhost:{PORT}/dashboard.html", timeout=5000)
        page.wait_for_selector("#main:not([hidden])", timeout=10_000)
        print("✓ login worked, dashboard visible")

        # --- Top bar timestamp ---
        ts_text = page.text_content("#last-updated")
        assert ts_text and "Updated:" in ts_text, f"Header timestamp missing: {ts_text!r}"
        print(f"✓ header timestamp: {ts_text}")

        # --- Search Movement tab ---
        page.wait_for_selector("#search-top-tbl tbody tr", timeout=5000)
        rows = page.query_selector_all("#search-top-tbl tbody tr")
        print(f"✓ Search Movement top-keywords table: {len(rows)} rows")

        # The Top 10 should be ≤ 10
        assert len(rows) > 0, "Expected at least one row in top table"
        assert len(rows) <= 10, f"Expected ≤10 rows in top table, got {len(rows)}"

        # First row should be ranked #1
        first_rank = page.text_content("#search-top-tbl tbody tr:first-child td.rank")
        assert first_rank.strip() == "1", f"First row rank should be 1, got {first_rank!r}"
        print(f"✓ first keyword in top table:")
        kw = page.text_content("#search-top-tbl tbody tr:first-child td.kw-cell")
        print(f"    {kw}")

        # Mode notice should be visible (Amazon-only by default → rank mode).
        notice = page.text_content("#search-mode-notice")
        print(f"✓ mode notice: {notice.strip()[:80]}")

        # Trend chart canvas should be present
        canvas = page.query_selector("#search-trend-canvas")
        assert canvas, "Trend canvas missing"
        print("✓ trend chart canvas present")

        # Open full-list modal
        page.click("#search-expand-btn")
        page.wait_for_selector("#search-modal:not([hidden])", timeout=2000)
        modal_rows = page.query_selector_all("#search-full-tbl tbody tr")
        print(f"✓ full-list modal: {len(modal_rows)} rows")
        page.click("#search-modal-close")
        page.wait_for_selector("#search-modal", state="hidden", timeout=2000)
        print("✓ modal closes")

        # --- CSV + Excel downloads (M11 / spec §10 #7) ---
        with page.expect_download(timeout=5000) as dl_info:
            page.click("#search-top-csv")
        download = dl_info.value
        csv_path = ROOT / "smoke-download.csv"
        download.save_as(csv_path)
        csv_text = csv_path.read_text(encoding="utf-8")
        assert csv_text.startswith("\ufeff") or "Keyword" in csv_text, \
            f"CSV missing expected header: {csv_text[:100]!r}"
        assert "naturali hair shampoo" in csv_text, \
            f"CSV missing top keyword: {csv_text[:200]!r}"
        csv_path.unlink()
        print(f"✓ CSV download: {len(csv_text)} bytes, has expected content")

        with page.expect_download(timeout=10_000) as dl_info:
            page.click("#search-top-xlsx")
        download = dl_info.value
        xlsx_path = ROOT / "smoke-download.xlsx"
        download.save_as(xlsx_path)
        # Just verify it's a real xlsx (zip signature PK\x03\x04).
        with open(xlsx_path, "rb") as f:
            sig = f.read(4)
        assert sig == b"PK\x03\x04", f"Not a valid xlsx: {sig!r}"
        xlsx_size = xlsx_path.stat().st_size
        xlsx_path.unlink()
        print(f"✓ Excel download: {xlsx_size} bytes, valid xlsx signature")

        # --- Tab switching ---
        for tab in ["impressions", "business", "spend", "influencer", "search"]:
            page.click(f'.tab[data-tab="{tab}"]')
            page.wait_for_selector(f"#tab-{tab}:not([hidden])", timeout=2000)
        print("✓ tab switching: all 5 tabs reachable")

        # --- Business tab deeper checks ---
        page.click('.tab[data-tab="business"]')
        page.wait_for_selector('#tab-business:not([hidden])', timeout=2000)
        # Lazy-load of sales.json should complete; wait for at least one canvas
        # to be present and a table to be populated.
        page.wait_for_selector('#bus-revenue-tbl tbody tr', timeout=15_000)
        rev_rows = page.query_selector_all('#bus-revenue-tbl tbody tr')
        print(f"✓ Business revenue table: {len(rev_rows)} weekly rows")
        # 4 chart canvases (page_views, units, revenue, spend) should all be present
        for m in ["page_views", "units", "revenue", "spend"]:
            assert page.query_selector(f'#bus-{m}-canvas'), f"missing canvas {m}"
        # The latest-period KPI should show a value (not empty)
        rev_kpi = page.text_content('#bus-revenue-kpi') or ''
        assert '₹' in rev_kpi or '—' in rev_kpi, f"revenue KPI looks wrong: {rev_kpi!r}"
        print(f"✓ Business revenue KPI: {rev_kpi.strip()[:60]}")

        # --- Switch to SKU level: spend should show N/A card ---
        page.click('#filters-business .fl-seg button[data-v="sku"]')
        page.wait_for_timeout(400)
        spend_empty = page.query_selector('#bus-spend-empty:not([hidden])')
        assert spend_empty, "Spend N/A card should appear at SKU level"
        empty_text = page.text_content('#bus-spend-empty')
        assert 'Not available at SKU level' in empty_text, f"unexpected empty text: {empty_text!r}"
        print("✓ Business: SKU level shows 'Not available at SKU level' for Spend")
        page.click('#filters-business .fl-seg button[data-v="overall"]')
        page.wait_for_timeout(400)
        print("✓ Business: SKU → Overall toggle works")

        # --- Platform filter actually filters (spec §10 #6) ---
        # The multi-select trigger label is the most reliable signal of state.
        # Default = "All platforms (N)"; after toggling, should reflect the new
        # selection.
        label_all = (page.text_content('#filters-business .fl-ms-label') or '').strip()
        assert 'platforms' in label_all.lower() or '(' in label_all, \
            f"Unexpected initial filter label: {label_all!r}"
        # Open popover, uncheck "All". (Popover re-renders after each change,
        # so re-query before each click.)
        page.click('#filters-business .fl-ms-trigger')
        page.wait_for_selector('#filters-business .fl-ms-pop:not([hidden])', timeout=1000)
        all_box = page.query_selector('#filters-business .fl-ms-pop input[data-all="1"]')
        assert all_box, "Couldn't find the 'All' checkbox"
        if page.evaluate("el => el.checked", all_box):
            all_box.click()
            page.wait_for_timeout(200)
        # Now re-query: popover re-rendered. Pick Amazon.
        amazon_box = page.query_selector('#filters-business .fl-ms-pop input[data-v="Amazon"]')
        assert amazon_box, "Couldn't find Amazon checkbox"
        if not page.evaluate("el => el.checked", amazon_box):
            amazon_box.click()
            page.wait_for_timeout(300)
        page.click('#tab-business .panel-h1')
        page.wait_for_timeout(400)
        label_amazon = (page.text_content('#filters-business .fl-ms-label') or '').strip()
        assert label_all != label_amazon, \
            f"Filter label didn't change after toggle: {label_all!r}"
        assert 'amazon' in label_amazon.lower(), \
            f"Filter label should reflect Amazon selection: {label_amazon!r}"
        rev_amazon = (page.text_content('#bus-revenue-kpi') or '').strip()
        print(f"✓ Platform filter: '{label_all}' → '{label_amazon}' (KPI: {rev_amazon[:30]})")
        # Restore: re-check All
        page.click('#filters-business .fl-ms-trigger')
        page.wait_for_selector('#filters-business .fl-ms-pop:not([hidden])', timeout=1000)
        all_box = page.query_selector('#filters-business .fl-ms-pop input[data-all="1"]')
        if all_box and not page.evaluate("el => el.checked", all_box):
            all_box.click()
            page.wait_for_timeout(300)
        page.click('#tab-business .panel-h1')
        page.wait_for_timeout(300)

        # --- Impressions tab checks ---
        page.click('.tab[data-tab="impressions"]')
        page.wait_for_selector('#tab-impressions:not([hidden])', timeout=2000)
        page.wait_for_selector('#imp-impressions-tbl tbody tr', timeout=5_000)
        # Four keyword-level canvases + one SKU canvas
        for m in ["impressions", "brand_imp_share", "clicks", "brand_click_share", "sku"]:
            assert page.query_selector(f'#imp-{m}-canvas'), f"missing impressions canvas {m}"
        imp_kpi = page.text_content('#imp-impressions-kpi') or ''
        share_kpi = page.text_content('#imp-brand_imp_share-kpi') or ''
        assert imp_kpi and '—' not in imp_kpi[:20], f"Impressions KPI empty: {imp_kpi!r}"
        assert '%' in share_kpi or '—' in share_kpi, f"Brand share KPI looks wrong: {share_kpi!r}"
        print(f"✓ Impressions tab KPIs: imp={imp_kpi.strip()[:30]}, share={share_kpi.strip()[:30]}")
        sku_rows = page.query_selector_all('#imp-sku-tbl tbody tr')
        print(f"✓ Impressions tab SKU table: {len(sku_rows)} SKU rows")
        assert len(sku_rows) > 0, "SKU table should have rows"

        # --- Influencer tab checks (empty-data-aware) ---
        page.click('.tab[data-tab="influencer"]')
        page.wait_for_selector('#tab-influencer:not([hidden])', timeout=2000)
        page.wait_for_timeout(600)
        # Empty banner should be visible because influencer dataset is currently empty
        banner = page.query_selector('#inf-empty-banner:not([hidden])')
        assert banner, "Empty banner should show when influencer data is empty"
        banner_text = page.text_content('#inf-empty-banner')
        assert 'No influencer campaigns' in banner_text, f"Banner text wrong: {banner_text!r}"
        print("✓ Influencer tab: empty banner displayed when no campaigns")
        # All four campaign-metric canvases exist
        for m in ["views", "likes", "comments", "shares"]:
            assert page.query_selector(f'#inf-{m}-canvas'), f"missing campaign canvas {m}"
        # Campaign list is empty
        list_kpi = page.text_content('#inf-list-kpi')
        assert 'No campaigns in range' in list_kpi, f"List KPI wrong when empty: {list_kpi!r}"
        print("✓ Influencer tab: campaign list shows empty state")
        # Correlation overlay should still render impressions chart
        imp_canvas = page.query_selector('#inf-overlay-imp-canvas')
        assert imp_canvas, "overlay impressions canvas missing"
        overlay_kpi = page.text_content('#inf-overlay-imp-kpi') or ''
        # Either real value or "No impressions" — both are acceptable shapes
        print(f"✓ Influencer tab: correlation impressions KPI = {overlay_kpi.strip()[:50]}")

        # --- Live refresh — exercise the full fetch → parse → normalize path
        # by re-routing the gviz CSV endpoint to a local mock that emits the
        # same six tabs from the xlsx-derived JSON.
        import json
        with open(ROOT / "data" / "dashboard_data.json") as f:
            committed = json.load(f)
        with open(ROOT / "data" / "sales.json") as f:
            committed_sales = json.load(f)

        def to_csv(rows, header_map):
            """rows: list of dicts; header_map: list of (sheet_header, row_key)."""
            import csv, io
            buf = io.StringIO()
            w = csv.writer(buf)
            w.writerow([h for h, _ in header_map])
            for r in rows:
                w.writerow([
                    "" if r.get(k) is None else r.get(k)
                    for _, k in header_map
                ])
            return buf.getvalue()

        # Map our normalized field names back to sheet column headers.
        TABS_TO_CSV = {
            "Daily SFR": to_csv(committed["daily_sfr"], [
                ("Channel","platform"),("Date","date"),
                ("Search Term","keyword"),("Category","category"),
                ("Subcategory","subcategory"),("Search Frequency Rank","rank"),
            ]),
            "Weekly SFR Movement": to_csv(committed["weekly_sfr"], [
                ("Channel","platform"),("Week","week_num_label"),
                ("Search Query","search_query"),("Search Query Type","branded_bucket"),
                ("Category","category"),("Subcategory","subcategory"),
                ("Search Frequency Rank","rank"),("Search Query Volume","volume"),
                ("Impressions: Total Count","impressions"),
                ("Impressions: Brand Share %","brand_impression_share_pct"),
                ("Clicks: Total Count","clicks"),
                ("Clicks: Brand Share %","brand_click_share_pct"),
            ]),
            "Weekly Catalogue Performance": to_csv(committed["weekly_catalogue"], [
                ("Channel","platform"),("Week","week_num_label"),
                ("Short Code","short_code"),("NH SKU","nh_sku"),
                ("Category","category"),("Subcategory","subcategory"),
                ("Impressions: Impressions","impressions"),
            ]),
            "Sales Data": to_csv(committed_sales, [
                ("Platform","platform"),("Date","date"),
                ("NH SKU","nh_sku"),("Category","category"),
                ("Subcategory","subcategory"),
                ("Glance Views","glance_views"),("Gross Units","gross_units"),
                ("Revenue","revenue"),
            ]),
            "BCG Data": to_csv(committed["bcg_spend"], [
                ("Channel","platform"),("Date","date"),
                ("Category","category"),("Subcategory","subcategory"),
                ("Keyword Type","branded_bucket"),
                ("Marketing Channel","marketing_channel"),
                ("Spend","spend"),("Sales","sales"),
            ]),
            "Influencer Data": to_csv(committed["influencer"], [
                ("Date","date"),("Influencer Name","influencer_name"),
                ("Category","category"),("Ad Name","ad_name"),
                ("Views","views"),("Likes","likes"),
                ("Comments","comments"),("Shares","shares"),
            ]),
        }
        # Patch rows that come from weekly tabs: synthesize a "Week23" label
        # since our normalized JSON has week_num (int) only.
        def with_week_label(rows):
            return [{**r, "week_num_label": f"Week{r['week_num']}"} for r in rows]

        TABS_TO_CSV["Weekly SFR Movement"] = to_csv(
            with_week_label(committed["weekly_sfr"]),
            [("Channel","platform"),("Week","week_num_label"),
             ("Search Query","search_query"),("Search Query Type","branded_bucket"),
             ("Category","category"),("Subcategory","subcategory"),
             ("Search Frequency Rank","rank"),("Search Query Volume","volume"),
             ("Impressions: Total Count","impressions"),
             ("Impressions: Brand Share %","brand_impression_share_pct"),
             ("Clicks: Total Count","clicks"),
             ("Clicks: Brand Share %","brand_click_share_pct")])
        TABS_TO_CSV["Weekly Catalogue Performance"] = to_csv(
            with_week_label(committed["weekly_catalogue"]),
            [("Channel","platform"),("Week","week_num_label"),
             ("Short Code","short_code"),("NH SKU","nh_sku"),
             ("Category","category"),("Subcategory","subcategory"),
             ("Impressions: Impressions","impressions")])

        from urllib.parse import unquote
        def gviz_route(route, req):
            # Match gviz CSV URLs and route to in-memory CSV.
            url = req.url
            if "docs.google.com/spreadsheets" in url and "gviz/tq" in url:
                # Extract sheet=<name>
                m = re.search(r"[?&]sheet=([^&]+)", url)
                tab = unquote(m.group(1)) if m else ""
                body = TABS_TO_CSV.get(tab, "")
                return route.fulfill(status=200,
                                     content_type="text/csv; charset=utf-8",
                                     body=body)
            return reroute(route, req)
        # Replace the existing route handler with the gviz-aware one.
        page.unroute("**/*")
        page.route("**/*", gviz_route)

        # Reset to Search tab, click Refresh, check that header switches to "live".
        import re
        page.click('.tab[data-tab="search"]')
        page.wait_for_timeout(300)
        page.click("#refresh-btn")
        # Wait for the "just now (live)" indicator
        page.wait_for_function(
            "() => (document.getElementById('last-updated')?.textContent || '').includes('live')",
            timeout=15_000)
        live_ts = page.text_content("#last-updated") or ""
        assert "live" in live_ts, f"Expected 'live' indicator: {live_ts!r}"
        print(f"✓ Live refresh: header → {live_ts}")
        # Search tab should still show the same top keyword after live refresh.
        page.wait_for_selector('#search-top-tbl tbody tr', timeout=5000)
        first_kw = page.text_content('#search-top-tbl tbody tr:first-child td.kw-cell')
        print(f"✓ Live refresh: first keyword after re-fetch = {first_kw}")
        assert first_kw and 'naturali' in first_kw.lower(), \
            f"Top keyword changed after live refresh: {first_kw!r}"
        page.click('.tab[data-tab="spend"]')
        page.wait_for_selector('#tab-spend:not([hidden])', timeout=2000)
        page.wait_for_selector('#spd-roas-tbl tbody tr', timeout=5_000)
        # Three canvases — spend, sales, roas
        for m in ["spend", "sales", "roas"]:
            assert page.query_selector(f'#spd-{m}-canvas'), f"missing spend canvas {m}"
        roas_rows = page.query_selector_all('#spd-roas-tbl tbody tr')
        print(f"✓ Spend tab ROAS table: {len(roas_rows)} weekly rows")
        roas_kpi = page.text_content('#spd-roas-kpi') or ''
        assert 'x' in roas_kpi or '—' in roas_kpi, f"ROAS KPI looks wrong: {roas_kpi!r}"
        print(f"✓ Spend tab ROAS KPI: {roas_kpi.strip()[:60]}")
        # Drill down to Marketing Channel level — dim dropdown should appear
        page.click('#filters-spend .fl-seg button[data-v="channel"]')
        page.wait_for_timeout(300)
        dim_select = page.query_selector('#spend-dim-select')
        assert dim_select, "Spend dim select should exist at channel level"
        options_count = page.evaluate('el => el.options.length', dim_select)
        print(f"✓ Spend tab: channel level shows {options_count} dimension options")
        # Reset to Overall
        page.click('#filters-spend .fl-seg button[data-v="overall"]')
        page.wait_for_timeout(300)

        # --- Mobile viewport ---
        page.set_viewport_size({"width": 375, "height": 800})
        page.wait_for_timeout(300)
        hamb = page.query_selector(".hamburger")
        is_visible = page.evaluate("el => window.getComputedStyle(el).display !== 'none'", hamb)
        assert is_visible, "Hamburger should be visible at 375px"
        print("✓ mobile (375px): hamburger appears")

        # No horizontal page scroll
        scroll_w = page.evaluate("document.documentElement.scrollWidth")
        client_w = page.evaluate("document.documentElement.clientWidth")
        assert scroll_w <= client_w + 1, f"Horizontal overflow at 375px: {scroll_w} vs {client_w}"
        print(f"✓ no horizontal scroll at 375px ({scroll_w} ≤ {client_w})")

        # Open hamburger and pick a tab
        page.click(".hamburger")
        page.wait_for_selector(".mobile-menu.is-open", timeout=1000)
        # Mobile drawer should show the status line, a Refresh entry, and Sign out
        m_status = page.text_content('#last-updated-m') or ''
        assert 'Updated' in m_status or 'live' in m_status, f"Mobile status missing: {m_status!r}"
        print(f"✓ mobile drawer: status mirrored = {m_status.strip()[:40]}")
        refresh_m = page.query_selector('#refresh-btn-m')
        assert refresh_m, "Mobile drawer must include a Refresh action"
        print("✓ mobile drawer: Refresh action available")
        page.click('.m-tab[data-tab="search"]')
        page.wait_for_selector(".mobile-menu:not(.is-open)", state="hidden", timeout=2000)
        print("✓ mobile menu: opens, picks tab, closes")

        # Take screenshots for sanity (desktop sweep first, then mobile sweep).
        page.set_viewport_size({"width": 1280, "height": 900})
        page.wait_for_timeout(200)
        page.screenshot(path=str(ROOT / "smoke-search-desktop.png"), full_page=True)
        page.click('.tab[data-tab="business"]')
        page.wait_for_selector('#bus-revenue-tbl tbody tr', timeout=10_000)
        page.wait_for_timeout(400)
        page.screenshot(path=str(ROOT / "smoke-business-desktop.png"), full_page=True)
        page.click('.tab[data-tab="spend"]')
        page.wait_for_selector('#spd-roas-tbl tbody tr', timeout=5_000)
        page.wait_for_timeout(400)
        page.screenshot(path=str(ROOT / "smoke-spend-desktop.png"), full_page=True)
        page.click('.tab[data-tab="impressions"]')
        page.wait_for_selector('#imp-impressions-tbl tbody tr', timeout=5_000)
        page.wait_for_timeout(400)
        page.screenshot(path=str(ROOT / "smoke-impressions-desktop.png"), full_page=True)
        page.click('.tab[data-tab="influencer"]')
        page.wait_for_selector('#tab-influencer:not([hidden])', timeout=2000)
        page.wait_for_timeout(500)
        page.screenshot(path=str(ROOT / "smoke-influencer-desktop.png"), full_page=True)
        # Then go mobile and capture each tab via the mobile drawer.
        page.set_viewport_size({"width": 375, "height": 900})
        page.wait_for_timeout(300)
        for tab in ["search", "impressions", "business", "spend", "influencer"]:
            # Open hamburger, click the matching m-tab, capture.
            current_active = page.evaluate(
                "() => document.querySelector('.m-tab.is-active')?.dataset?.tab")
            if current_active != tab:
                page.click(".hamburger")
                page.wait_for_selector(".mobile-menu.is-open", timeout=1000)
                page.click(f'.m-tab[data-tab="{tab}"]')
                page.wait_for_timeout(600)
            else:
                page.wait_for_timeout(300)
            page.screenshot(path=str(ROOT / f"smoke-{tab}-mobile.png"), full_page=True)

        # --- Logout (spec §10 #11) ---
        # Back to desktop viewport so the topbar logout button is reachable.
        page.set_viewport_size({"width": 1280, "height": 900})
        page.wait_for_timeout(200)
        page.click("#logout-btn")
        page.wait_for_url(f"http://localhost:{PORT}/index.html", timeout=3000)
        authed = page.evaluate("() => sessionStorage.getItem('nh_authed')")
        assert authed is None, f"Logout failed to clear sessionStorage: {authed!r}"
        assert page.query_selector("#login-form"), "Login form not present after logout"
        print("✓ logout: clears session and returns to sign-in page")

        browser.close()

    if errors:
        print("\n❌ JS errors detected:")
        for e in errors:
            print(f"   {e}")
        sys.exit(1)
    if warnings:
        # Warnings are okay but worth seeing
        print("\nℹ️  console warnings (not failures):")
        for w in warnings[:5]:
            print(f"   {w}")

    print("\n✅ All smoke checks passed.")

if __name__ == "__main__":
    main()
