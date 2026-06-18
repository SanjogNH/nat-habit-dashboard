"""
build_dashboard.py — orchestrator for the nightly refresh.

Run from the repo root. Reads SHEET_ID from config.py / env, fetches all tabs,
normalizes them, and writes:

    data/dashboard_data.json                          (always; full payload OR a
                                                       trimmed shell if split)
    data/<tab>.json                                   (when splitting; one per
                                                       heavy tab moved out of
                                                       the main file)

When --local <path.xlsx> is given, reads from a local workbook instead of the
network. Used for offline testing and CI smoke tests.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from typing import Any

from config import (OUTPUT_DIR, OUTPUT_MAIN, SHEET_ID, SPLIT_CANDIDATES_ORDER,
                    SPLIT_THRESHOLD_BYTES)
from calculate import build_payload
from fetch_data import fetch_all, summarise


def _write_json(path: str, obj: Any) -> int:
    """Write obj as JSON; return byte count written."""
    body = json.dumps(obj, ensure_ascii=False, separators=(",", ":"))
    with open(path, "w", encoding="utf-8") as f:
        f.write(body)
    return len(body.encode("utf-8"))


def _maybe_split(payload: dict, out_dir: str) -> tuple[dict, list[str]]:
    """If the payload is too large, peel off heavy row arrays into side-files.

    Returns (shell_payload, list_of_side_files_relative_to_out_dir).
    The shell_payload replaces the moved arrays with {"_external": "<file>"}
    sentinels so the frontend knows where to fetch them.
    """
    full_bytes = len(json.dumps(payload, separators=(",", ":")).encode("utf-8"))
    if full_bytes <= SPLIT_THRESHOLD_BYTES:
        return payload, []

    shell = dict(payload)
    moved: list[str] = []
    current_bytes = full_bytes

    for key in SPLIT_CANDIDATES_ORDER:
        if current_bytes <= SPLIT_THRESHOLD_BYTES:
            break
        if key not in shell or not isinstance(shell[key], list) or not shell[key]:
            continue
        # Write the side file.
        side_path = os.path.join(out_dir, f"{key}.json")
        _write_json(side_path, shell[key])
        # Replace in shell.
        shell[key] = {"_external": f"{key}.json", "count": len(payload[key])}
        moved.append(f"{key}.json")
        # Recalc shell size.
        current_bytes = len(json.dumps(shell, separators=(",", ":")).encode("utf-8"))

    shell.setdefault("metadata", {})["split_files"] = moved
    return shell, moved


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Build dashboard_data.json")
    parser.add_argument("--local", help="Read from local .xlsx instead of Google Sheets")
    parser.add_argument("--out", default=OUTPUT_DIR, help="Output directory (default: data/)")
    args = parser.parse_args(argv)

    os.makedirs(args.out, exist_ok=True)

    t0 = time.time()
    if args.local:
        print(f"[fetch] reading local workbook: {args.local}")
        frames = fetch_all(local_xlsx=args.local)
        used_sheet_id = "local-xlsx"
    else:
        print(f"[fetch] gviz CSV from sheet {SHEET_ID[:4]}...{SHEET_ID[-4:]}")
        frames = fetch_all(sheet_id=SHEET_ID)
        used_sheet_id = SHEET_ID

    print(f"[fetch] {summarise(frames)}")
    print(f"[fetch] took {time.time()-t0:.1f}s")

    t1 = time.time()
    payload = build_payload(frames, sheet_id=used_sheet_id)
    print(f"[calc] built payload in {time.time()-t1:.1f}s")
    rc = payload["metadata"]["row_counts"]
    print(f"[calc] normalized rows: " + "  ".join(f"{k}={v}" for k, v in rc.items()))

    # Always start by peeling heavy arrays off if needed, then write.
    main_path = os.path.join(args.out, OUTPUT_MAIN)
    shell, moved = _maybe_split(payload, args.out)
    main_bytes = _write_json(main_path, shell)
    print(f"[write] {main_path}  ({main_bytes/1024:.1f} KB)")
    for m in moved:
        size = os.path.getsize(os.path.join(args.out, m))
        print(f"[write] {os.path.join(args.out, m)}  ({size/1024:.1f} KB)  [split]")

    print(f"[done] total {time.time()-t0:.1f}s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
