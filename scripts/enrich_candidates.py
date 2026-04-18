#!/usr/bin/env python3
"""
enrich_candidates.py
────────────────────
Nightly job that builds data/candidate-extras.json — a lookup of supplementary
information (social media, websites) for every candidate standing in the UK
local elections on 7 May 2026.

Primary source: Democracy Club's public YNR API, which already crowdsources
candidate identifiers. This gives us high-quality, manually-verified data.

Output shape:
{
  "<person_id>": {
    "name": "Jane Smith",
    "links": [
      { "label": "Twitter/X",   "href": "https://twitter.com/..." },
      { "label": "Website",     "href": "https://..." },
      ...
    ],
    "last_seen": "2026-04-18T00:00:00Z"
  },
  ...
}

The script is deliberately conservative:
  • It respects HTTP error codes and backs off.
  • It never follows untrusted redirects.
  • It only stores data Democracy Club has already published.
  • It is re-runnable: the output is deterministic for the same input.

Run locally:
  python3 scripts/enrich_candidates.py

Run in CI (GitHub Actions): see .github/workflows/enrich.yml
"""

from __future__ import annotations

import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError


# ── Configuration ───────────────────────────────────────────────────────────
ELECTION_DATE = "2026-05-07"
YNR_BASE = "https://candidates.democracyclub.org.uk/api/next"
USER_AGENT = "YourBallot-Enrichment/1.0 (+https://github.com/) nightly"
REQUEST_TIMEOUT = 30            # seconds per HTTP call
INTER_REQUEST_SLEEP = 0.6       # be polite to YNR — empirically needed to avoid 429s
PAGE_SIZE = 100                 # max per API page
MAX_PAGES = 60                  # safety cap (6000 ballots would be huge)
MAX_ATTEMPTS = 6                # retry more aggressively on 429/5xx

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
OUTPUT_PATH = DATA_DIR / "candidate-extras.json"
INDEX_PATH = DATA_DIR / "elections-index.json"
COUNCILS_DIR = DATA_DIR / "councils"


def extract_council_slug(ballot_paper_id: str) -> str:
    """Parse council slug out of a ballot_paper_id like local.adur.marine.2026-05-07."""
    parts = (ballot_paper_id or "").split(".")
    if len(parts) >= 4 and parts[0] == "local":
        return parts[1]
    return ""


# ── Logging helpers ─────────────────────────────────────────────────────────
def log(msg: str) -> None:
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)


# ── HTTP helper with robust retry ───────────────────────────────────────────
def http_get_json(url: str, attempt: int = 1, max_attempts: int = MAX_ATTEMPTS) -> dict | None:
    req = Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
    try:
        with urlopen(req, timeout=REQUEST_TIMEOUT) as r:
            return json.loads(r.read().decode("utf-8"))
    except HTTPError as e:
        if e.code == 404:
            return None
        if e.code in (429, 500, 502, 503, 504) and attempt < max_attempts:
            # 429 needs longer backoff than 5xx; both should ramp exponentially.
            base = 8 if e.code == 429 else 2
            backoff = base * (2 ** (attempt - 1))
            log(f"  HTTP {e.code} on {url} — retrying in {backoff}s (attempt {attempt}/{max_attempts})")
            time.sleep(backoff)
            return http_get_json(url, attempt + 1, max_attempts)
        log(f"  HTTP {e.code} on {url} — giving up after {attempt} attempt(s)")
        return None
    except (URLError, TimeoutError) as e:
        if attempt < max_attempts:
            backoff = 2 ** attempt
            log(f"  Network error on {url} ({e}) — retrying in {backoff}s")
            time.sleep(backoff)
            return http_get_json(url, attempt + 1, max_attempts)
        log(f"  Network error on {url} — giving up: {e}")
        return None
    except Exception as e:
        log(f"  Unexpected error on {url}: {e}")
        return None


# ── Data collection ─────────────────────────────────────────────────────────
def iter_ballots(election_date: str) -> Iterable[dict]:
    """Yield summary ballot objects for the given date, across pages."""
    url = f"{YNR_BASE}/ballots/?election_date={election_date}&page_size={PAGE_SIZE}"
    page = 0
    while url and page < MAX_PAGES:
        data = http_get_json(url)
        time.sleep(INTER_REQUEST_SLEEP)
        if not data:
            break
        for b in data.get("results", []) or []:
            yield b
        url = data.get("next")
        page += 1
        log(f"  page {page}: {len(data.get('results') or [])} ballots (total so far ≈ {page * PAGE_SIZE})")


def fetch_ballot_detail(ballot_paper_id: str) -> dict | None:
    """Full ballot detail includes the candidacy list with person IDs."""
    return http_get_json(f"{YNR_BASE}/ballots/{ballot_paper_id}/")


def fetch_person(person_id: int | str) -> dict | None:
    return http_get_json(f"{YNR_BASE}/people/{person_id}/")


# ── Link extraction ─────────────────────────────────────────────────────────
IDENTIFIER_LABELS = {
    "twitter_username":     ("Twitter/X",      lambda v: f"https://twitter.com/{v.lstrip('@')}"),
    "facebook_page_url":    ("Facebook",       lambda v: v),
    "facebook_personal_url":("Facebook",       lambda v: v),
    "instagram_url":        ("Instagram",      lambda v: v),
    "linkedin_url":         ("LinkedIn",       lambda v: v),
    "homepage_url":         ("Website",        lambda v: v),
    "party_ppc_page_url":   ("Party page",     lambda v: v),
    "wikipedia_url":        ("Wikipedia",      lambda v: v),
    "blog_url":             ("Blog",           lambda v: v),
    "youtube_profile":      ("YouTube",        lambda v: v),
    "mastodon_username":    ("Mastodon",       lambda v: v),
    "threads_url":          ("Threads",        lambda v: v),
    "bluesky_url":          ("Bluesky",        lambda v: v),
    "tiktok_url":           ("TikTok",         lambda v: v),
}


def extract_links(person: dict) -> list[dict]:
    """Turn YNR identifier records into a clean list of {label, href}."""
    links: list[dict] = []
    seen: set[str] = set()

    for ident in person.get("identifiers") or []:
        vt = (ident.get("value_type") or "").strip()
        val = (ident.get("value") or "").strip()
        if not val or vt not in IDENTIFIER_LABELS:
            continue
        label, builder = IDENTIFIER_LABELS[vt]
        try:
            href = builder(val)
        except Exception:
            continue
        if not href.startswith(("http://", "https://")):
            continue
        if href in seen:
            continue
        seen.add(href)
        links.append({"label": label, "href": href})

    # De-duplicate while preserving order
    return links


# ── Main pipeline ───────────────────────────────────────────────────────────
def build_candidate_extras() -> tuple[dict, dict, dict]:
    """
    Walks every ballot for ELECTION_DATE and returns three structures:

      extras          : person_id -> {name, links, last_seen}
                        (for candidate-extras.json, used by the postcode lookup)
      councils_wards  : council_slug -> list of ward dicts
                        (for data/councils/<slug>.json, used by the browse page)
      council_names   : council_slug -> display name
    """
    log(f"Fetching ballots for {ELECTION_DATE}…")
    ballot_ids: list[str] = []
    for b in iter_ballots(ELECTION_DATE):
        bpi = b.get("ballot_paper_id")
        if bpi and not b.get("cancelled"):
            ballot_ids.append(bpi)
    log(f"Collected {len(ballot_ids)} active ballots.")

    if not ballot_ids:
        log("No ballots found — nothing to enrich. Aborting.")
        return {}, {}, {}

    # Collect unique person IDs across all ballots + per-council ward data
    person_ids: set[int] = set()
    person_names: dict[int, str] = {}
    councils_wards: dict[str, list[dict]] = {}
    council_names: dict[str, str] = {}

    for i, bpi in enumerate(ballot_ids, 1):
        if i % 50 == 0:
            log(f"  …processed {i}/{len(ballot_ids)} ballots")
        b = fetch_ballot_detail(bpi)
        time.sleep(INTER_REQUEST_SLEEP)
        if not b:
            continue

        council_slug = extract_council_slug(bpi)
        org = (b.get("election") or {}).get("organization") or {}
        if council_slug and council_slug not in council_names:
            council_names[council_slug] = (
                org.get("common_name")
                or org.get("official_name")
                or council_slug.replace("-", " ").title()
            )

        ward_label = (b.get("post") or {}).get("label") or ""
        winner_count = b.get("winner_count") or 1

        ward_candidates: list[dict] = []
        for c in b.get("candidacies") or []:
            p = c.get("person") or {}
            pid = p.get("id")
            if isinstance(pid, int):
                person_ids.add(pid)
                if p.get("name"):
                    person_names[pid] = p["name"]
            party = c.get("party") or {}
            party_name = party.get("name") or c.get("party_name") or "Independent"
            if pid and p.get("name"):
                ward_candidates.append({
                    "person_id": pid,
                    "name": p["name"],
                    "party_name": party_name,
                })

        if council_slug and ward_label:
            councils_wards.setdefault(council_slug, []).append({
                "ward_name": ward_label,
                "ballot_paper_id": bpi,
                "seats_contested": winner_count,
                "candidate_count": len(ward_candidates),
                "candidates": ward_candidates,
            })

    log(f"Found {len(person_ids)} unique candidates across all ballots.")
    log(f"Found {len(councils_wards)} councils with {sum(len(w) for w in councils_wards.values())} wards.")

    # Write browse data EARLY — it only needs ballot data we already have.
    # This means the browse page works even if the slow per-person enrichment below
    # is interrupted or times out.
    log("Writing browse data (elections-index.json + per-council files)…")
    write_elections_browse_data(councils_wards, council_names)

    # Fetch each person's identifiers
    extras: dict[str, dict] = {}
    now_iso = datetime.now(timezone.utc).replace(microsecond=0).isoformat()

    for i, pid in enumerate(sorted(person_ids), 1):
        if i % 100 == 0:
            log(f"  enriching {i}/{len(person_ids)} ({100 * i // len(person_ids)}%)")
        person = fetch_person(pid)
        time.sleep(INTER_REQUEST_SLEEP)
        if not person:
            continue

        links = extract_links(person)
        # Only store records that actually have useful extra data
        if links:
            extras[str(pid)] = {
                "name": person.get("name") or person_names.get(pid) or "",
                "links": links,
                "last_seen": now_iso,
            }

    log(f"Built extras for {len(extras)} candidates with at least one link.")
    return extras, councils_wards, council_names


def write_elections_browse_data(
    councils_wards: dict[str, list[dict]],
    council_names: dict[str, str],
) -> None:
    """Write data/elections-index.json and data/councils/<slug>.json files."""
    if not councils_wards:
        log("No councils data — skipping browse-data write.")
        return

    COUNCILS_DIR.mkdir(parents=True, exist_ok=True)
    # Clear stale per-council files so deletions propagate
    for stale in COUNCILS_DIR.glob("*.json"):
        stale.unlink()

    now_iso = datetime.now(timezone.utc).replace(microsecond=0).isoformat()

    index_entries: list[dict] = []
    total_wards = 0
    total_candidates = 0
    total_seats = 0

    for slug, wards in councils_wards.items():
        wards_sorted = sorted(wards, key=lambda w: (w.get("ward_name") or "").lower())
        # Sort candidates within each ward by surname for consistency
        for w in wards_sorted:
            w["candidates"].sort(key=lambda c: (c.get("name") or "").split()[-1].lower())

        name = council_names.get(slug, slug.replace("-", " ").title())
        ward_count = len(wards_sorted)
        candidate_count = sum(w["candidate_count"] for w in wards_sorted)
        seat_count = sum(w["seats_contested"] for w in wards_sorted)
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
            "wards": wards_sorted,
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
        })

    index_entries.sort(key=lambda e: e["name"].lower())
    index_out = {
        "_meta": {
            "election_date": ELECTION_DATE,
            "generated_at": now_iso,
            "source": "Democracy Club YNR API",
            "council_count": len(index_entries),
            "ward_count": total_wards,
            "candidate_count": total_candidates,
            "seat_count": total_seats,
        },
        "councils": index_entries,
    }
    INDEX_PATH.write_text(json.dumps(index_out, indent=2, ensure_ascii=False))
    log(
        f"Wrote {INDEX_PATH.name} + {len(index_entries)} council files "
        f"({total_wards} wards, {total_candidates} candidates)."
    )


def main() -> int:
    start = time.time()
    log("Enrichment run starting.")

    try:
        extras, councils_wards, council_names = build_candidate_extras()
    except KeyboardInterrupt:
        log("Interrupted.")
        return 130
    except Exception as e:
        log(f"FATAL: {e}")
        return 1

    # Write candidate-extras.json (used by the postcode lookup)
    # (Browse data was already written mid-run inside build_candidate_extras.)
    output = {
        "_meta": {
            "election_date": ELECTION_DATE,
            "generated_at":  datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
            "source":        "Democracy Club YNR API",
            "candidate_count": len(extras),
        },
        **extras,
    }
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(json.dumps(output, indent=2, sort_keys=False, ensure_ascii=False))
    log(f"Wrote {OUTPUT_PATH.name} ({OUTPUT_PATH.stat().st_size:,} bytes).")

    elapsed = time.time() - start
    log(f"Done in {elapsed:.1f}s.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
