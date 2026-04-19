#!/usr/bin/env python3
"""
build_browse_data.py
────────────────────
Fetches Democracy Club's CSV export for ELECTION_DATE in a single request
and transforms it into the browse-page JSONs + a person-ID list for the
downstream enrichment script.

One HTTP call vs the thousands of /ballots/ detail calls the previous
ballot-by-ballot approach needed. Runtime: a few seconds.

CSV endpoint:
  https://candidates.democracyclub.org.uk/data/export_csv/?election_date=YYYY-MM-DD

Columns:
  person_id, person_name, election_id, ballot_paper_id, election_date,
  election_current, party_name, party_id, post_label, cancelled_poll,
  seats_contested

Outputs:
  data/elections-index.json       — council-level summary + ward names
  data/councils/<slug>.json       — per-council ward + candidate detail
  data/ballot_person_ids.json     — de-duplicated list of person IDs

Run locally:
  python3 scripts/build_browse_data.py
"""
from __future__ import annotations

import csv
import io
import json
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from urllib.request import Request, urlopen

# ── Configuration ───────────────────────────────────────────────────────────
ELECTION_DATE = "2026-05-07"
CSV_URL = (
    "https://candidates.democracyclub.org.uk/data/export_csv/"
    f"?election_date={ELECTION_DATE}"
)
USER_AGENT = "YourBallot-Browse/2.0 (+https://github.com/civictoolbox/your-ballot)"
REQUEST_TIMEOUT = 60

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
COUNCILS_DIR = DATA_DIR / "councils"
INDEX_PATH = DATA_DIR / "elections-index.json"
PERSON_IDS_PATH = DATA_DIR / "ballot_person_ids.json"


# ── Helpers ─────────────────────────────────────────────────────────────────
def log(msg: str) -> None:
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)


# Minor formatting fixes on top of basic .title() so common conjunctions don't
# get capitalised (e.g. "Tower Hamlets" not "Tower Hamlets"; "Barking and
# Dagenham" not "Barking And Dagenham").
def slug_to_display_name(slug: str) -> str:
    name = slug.replace("-", " ").title()
    fixes = {
        " And ":  " and ",
        " Of ":   " of ",
        " The ":  " the ",
        " On ":   " on ",
        " Upon ": " upon ",
    }
    for wrong, right in fixes.items():
        name = name.replace(wrong, right)
    # Fully-capitalised quirks
    name = name.replace("Of London", "of London")
    return name


def extract_council_slug(ballot_paper_id: str) -> str:
    parts = (ballot_paper_id or "").split(".")
    if len(parts) >= 4 and parts[0] == "local":
        return parts[1]
    return ""


# ── Main ────────────────────────────────────────────────────────────────────
def main() -> int:
    log(f"Fetching CSV export for {ELECTION_DATE}…")
    req = Request(CSV_URL, headers={"User-Agent": USER_AGENT, "Accept": "text/csv"})
    try:
        with urlopen(req, timeout=REQUEST_TIMEOUT) as r:
            csv_bytes = r.read()
    except Exception as e:
        log(f"FATAL: failed to fetch CSV: {e}")
        return 1

    csv_text = csv_bytes.decode("utf-8")
    log(f"Got {len(csv_bytes):,} bytes of CSV.")

    reader = csv.DictReader(io.StringIO(csv_text))

    # slug -> ward_label -> ward dict
    councils_wards: dict[str, dict[str, dict]] = defaultdict(dict)
    council_names: dict[str, str] = {}
    person_ids: set[int] = set()
    row_count = 0
    skipped_cancelled = 0
    skipped_non_local = 0

    for row in reader:
        row_count += 1
        if row.get("cancelled_poll") == "t":
            skipped_cancelled += 1
            continue

        bpi = row.get("ballot_paper_id") or ""
        slug = extract_council_slug(bpi)
        if not slug:
            skipped_non_local += 1
            continue  # parish / parliamentary / mayoral / etc.

        ward_label = row.get("post_label") or ""
        if not ward_label:
            continue

        if slug not in council_names:
            council_names[slug] = slug_to_display_name(slug)

        ward = councils_wards[slug].get(ward_label)
        if ward is None:
            try:
                seats = int(row.get("seats_contested") or 1)
            except ValueError:
                seats = 1
            ward = {
                "ward_name": ward_label,
                "ballot_paper_id": bpi,
                "seats_contested": seats,
                "candidate_count": 0,
                "candidates": [],
            }
            councils_wards[slug][ward_label] = ward

        pid_raw = (row.get("person_id") or "").strip()
        try:
            pid = int(pid_raw)
        except (ValueError, TypeError):
            continue
        person_ids.add(pid)

        name = (row.get("person_name") or "").strip()
        party_name = (row.get("party_name") or "").strip() or "Independent"

        ward["candidates"].append({
            "person_id": pid,
            "name": name,
            "party_name": party_name,
        })
        ward["candidate_count"] += 1

    log(
        f"Parsed {row_count:,} rows "
        f"({skipped_cancelled} cancelled, {skipped_non_local} non-local) — "
        f"{len(councils_wards)} councils, {len(person_ids):,} unique candidates."
    )

    if not councils_wards:
        log("No council ballots found — aborting without writing.")
        return 1

    # ── Write per-council files ─────────────────────────────────────────
    COUNCILS_DIR.mkdir(parents=True, exist_ok=True)
    for stale in COUNCILS_DIR.glob("*.json"):
        stale.unlink()

    now_iso = datetime.now(timezone.utc).replace(microsecond=0).isoformat()
    index_entries: list[dict] = []
    total_wards = 0
    total_candidates = 0
    total_seats = 0

    for slug in sorted(councils_wards.keys()):
        wards = sorted(councils_wards[slug].values(), key=lambda w: w["ward_name"].lower())
        for w in wards:
            w["candidates"].sort(key=lambda c: (c.get("name") or "").split()[-1].lower())

        name = council_names[slug]
        ward_count = len(wards)
        candidate_count = sum(w["candidate_count"] for w in wards)
        seat_count = sum(w["seats_contested"] for w in wards)
        total_wards += ward_count
        total_candidates += candidate_count
        total_seats += seat_count

        council_out = {
            "_meta": {
                "election_date": ELECTION_DATE,
                "generated_at": now_iso,
                "council_slug": slug,
                "council_name": name,
            },
            "wards": wards,
        }
        (COUNCILS_DIR / f"{slug}.json").write_text(
            json.dumps(council_out, indent=2, ensure_ascii=False)
        )

        index_entries.append({
            "slug": slug,
            "name": name,
            "ward_count": ward_count,
            "candidate_count": candidate_count,
            "seat_count": seat_count,
            "wards": [w["ward_name"] for w in wards],
        })

    index_entries.sort(key=lambda e: e["name"].lower())

    index_out = {
        "_meta": {
            "election_date": ELECTION_DATE,
            "generated_at": now_iso,
            "source": "Democracy Club YNR CSV export",
            "council_count": len(index_entries),
            "ward_count": total_wards,
            "candidate_count": total_candidates,
            "seat_count": total_seats,
        },
        "councils": index_entries,
    }
    INDEX_PATH.write_text(json.dumps(index_out, indent=2, ensure_ascii=False))
    log(
        f"Wrote {INDEX_PATH.name}: {len(index_entries)} councils, "
        f"{total_wards} wards, {total_candidates} candidacies."
    )

    # ── Write person-ID list for the enrichment step to pick up ─────────
    PERSON_IDS_PATH.write_text(json.dumps({
        "_meta": {
            "election_date": ELECTION_DATE,
            "generated_at": now_iso,
            "count": len(person_ids),
            "source": "Democracy Club YNR CSV export",
        },
        "person_ids": sorted(person_ids),
    }, indent=2))
    log(f"Wrote {PERSON_IDS_PATH.name}: {len(person_ids)} person IDs.")

    log("Done.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
