#!/usr/bin/env python3
"""
build_candidate_slug_index.py
─────────────────────────────
Generates data/candidate-slugs.json mapping each candidate's slugified
name → list of person IDs that share that slug. This lets the candidate
page resolve friendly URLs like `?name=nick-kilby` instead of
`?id=118374`, while still handling name collisions correctly.

Shape of output:

  {
    "_meta": { ... },
    "slugs": {
      "nick-kilby":       [118374],
      "john-smith":       [ 10001, 20002, 30003, … ],
      "siobhan-obrien":   [ 45678 ]
    }
  }

A candidate-page URL can then be any of:
  ?name=nick-kilby                        → unique, resolves directly
  ?name=john-smith                        → multiple, show disambiguation
  ?name=john-smith&id=20002               → unique via id tiebreaker
  ?id=118374                              → still supported as canonical

Slugification rules (intentionally narrow — we want URLs that look like
the English name, not a stripped transliteration):
  • lowercase
  • NFKD-decompose, drop combining marks (é → e, ñ → n, á → a)
  • drop apostrophes entirely (O'Brien → obrien) — matches user's request
  • replace any other non-alphanumeric run with a single '-'
  • trim leading/trailing '-'

Runs in <1 second. Call after build_browse_data.py.
"""
from __future__ import annotations

import json
import re
import sys
import unicodedata
from datetime import datetime, timezone
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
COUNCILS_DIR = DATA_DIR / "councils"
OUT_PATH = DATA_DIR / "candidate-slugs.json"


def log(msg: str) -> None:
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)


def slugify_name(name: str) -> str:
    if not name:
        return ""
    # NFKD then strip combining marks
    s = unicodedata.normalize("NFKD", name)
    s = "".join(c for c in s if not unicodedata.combining(c))
    s = s.lower()
    # Drop apostrophes / right-single-quote entirely
    s = s.replace("'", "").replace("\u2019", "")
    # Everything else non-alphanumeric → hyphen
    s = re.sub(r"[^a-z0-9]+", "-", s)
    s = s.strip("-")
    return s


def main() -> int:
    if not COUNCILS_DIR.exists():
        log(f"No {COUNCILS_DIR} — run scripts/build_browse_data.py first.")
        return 1
    files = sorted(COUNCILS_DIR.glob("*.json"))
    if not files:
        log("No council files found.")
        return 1

    slugs: dict[str, list[int]] = {}
    total_rows = 0
    skipped = 0
    for cf in files:
        try:
            data = json.loads(cf.read_text())
        except Exception as e:
            log(f"  skip {cf.name}: {e}")
            continue
        for w in data.get("wards") or []:
            for c in w.get("candidates") or []:
                total_rows += 1
                pid = c.get("person_id")
                name = c.get("name") or ""
                if pid is None:
                    skipped += 1
                    continue
                slug = slugify_name(name)
                if not slug:
                    skipped += 1
                    continue
                bucket = slugs.setdefault(slug, [])
                if pid not in bucket:
                    bucket.append(pid)

    # Sort each bucket for determinism
    for v in slugs.values():
        v.sort()

    unique_slugs = sum(1 for v in slugs.values() if len(v) == 1)
    collision_slugs = len(slugs) - unique_slugs
    top_collisions = sorted(
        ((slug, ids) for slug, ids in slugs.items() if len(ids) > 1),
        key=lambda x: -len(x[1]),
    )[:5]

    out = {
        "_meta": {
            "generated_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
            "row_count":       total_rows,
            "skipped":         skipped,
            "slug_count":      len(slugs),
            "unique_slugs":    unique_slugs,
            "collision_slugs": collision_slugs,
        },
        "slugs": slugs,
    }
    OUT_PATH.write_text(json.dumps(out, separators=(",", ":"), ensure_ascii=False))
    log(
        f"Wrote {OUT_PATH.name}: {len(slugs):,} slugs "
        f"({unique_slugs:,} unique, {collision_slugs:,} collisions)"
        f" in {OUT_PATH.stat().st_size:,} bytes."
    )
    if top_collisions:
        log("  top collisions:")
        for slug, ids in top_collisions:
            log(f"    {slug}: {len(ids)} candidates")
    return 0


if __name__ == "__main__":
    sys.exit(main())
