#!/usr/bin/env python3
"""
build_candidates_index.py
─────────────────────────
Post-processes data/councils/*.json into a compact lookup:

  data/candidates-index.json   — { "<person_id>": "<council_slug>" }

The candidate.html page uses this to resolve a ?id=X URL param to the
council file that actually holds the candidate's ward + party + name.

A candidate standing in multiple wards within different councils gets
one entry per council (as an array); same-council multi-ward is folded
into the first match.

Runs in seconds after scripts/build_browse_data.py.
"""
from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
COUNCILS_DIR = DATA_DIR / "councils"
INDEX_PATH = DATA_DIR / "candidates-index.json"


def log(msg: str) -> None:
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)


def main() -> int:
    if not COUNCILS_DIR.exists():
        log(f"No {COUNCILS_DIR} — run scripts/build_browse_data.py first.")
        return 1

    council_files = sorted(COUNCILS_DIR.glob("*.json"))
    if not council_files:
        log(f"{COUNCILS_DIR} is empty. Nothing to do.")
        return 1

    # person_id -> set of council slugs (set = rare multi-council case)
    mapping: dict[str, set[str]] = {}

    for cf in council_files:
        try:
            data = json.loads(cf.read_text())
        except Exception as e:
            log(f"  skip {cf.name}: {e}")
            continue
        council_slug = (data.get("_meta") or {}).get("council_slug") or cf.stem

        for w in data.get("wards") or []:
            for c in w.get("candidates") or []:
                pid = c.get("person_id")
                if pid is None:
                    continue
                mapping.setdefault(str(pid), set()).add(council_slug)

    # Collapse: single-council candidates → string, multi-council → sorted list
    collapsed: dict[str, str | list[str]] = {}
    for pid, slugs in mapping.items():
        if len(slugs) == 1:
            collapsed[pid] = next(iter(slugs))
        else:
            collapsed[pid] = sorted(slugs)

    now_iso = datetime.now(timezone.utc).replace(microsecond=0).isoformat()
    out = {
        "_meta": {
            "generated_at": now_iso,
            "candidate_count": len(collapsed),
            "multi_council_count": sum(1 for v in collapsed.values() if isinstance(v, list)),
        },
        "candidates": collapsed,
    }

    INDEX_PATH.write_text(json.dumps(out, indent=None, separators=(",", ":"), ensure_ascii=False))
    log(
        f"Wrote {INDEX_PATH.name}: {len(collapsed):,} candidates "
        f"({out['_meta']['multi_council_count']} multi-council) "
        f"in {INDEX_PATH.stat().st_size:,} bytes."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
