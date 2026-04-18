# Project Handoff: Your Ballot

> A note for future contributors — human or AI. Read this before making changes.

This document captures the **context, decisions, and current state** of the
project as of the initial build (April 2026). If you are a Claude instance in
a new conversation, read this file first — it will save you several rounds of
asking the user about decisions that have already been made.

---

## What this project is

A static website, hosted on GitHub Pages, where a UK voter can:

1. Enter their postcode.
2. See the list of candidates standing in their ward at the local elections on
   **Thursday 7 May 2026**.
3. See short summaries of what the parties those candidates represent stand for.

The user requirement is deliberately narrow and civic. The site is non-partisan,
ad-free, has no user accounts, and stores nothing.

---

## Architecture at a glance

```
User's browser
  │
  ├──▶ postcodes.io          (postcode → council + ward)
  ├──▶ candidates.democracyclub.org.uk  (ward → ballot → candidates)
  └──▶ data/parties.json     (AI-written party summaries, static)
       data/candidate-extras.json  (built nightly by GitHub Action)
```

- **No backend.** Everything is either static or called from the browser.
- **No build step.** Vanilla HTML / CSS / JS, viewable straight from Finder if
  you serve the folder over `python3 -m http.server`.
- **No dependencies** (other than Google Fonts CDN for Fraunces + Inter Tight,
  loaded from `<link>` tags in `index.html`).

---

## Key decisions made during the initial build

These were discussed with the user and settled. **Do not re-litigate them
without clear cause.**

| Decision | What was chosen | Why |
| --- | --- | --- |
| **Data source for candidates** | Democracy Club (public YNR API, no auth) | User preferred a free, authoritative, official source. The polished `developers.democracyclub.org.uk` API needs an API key via email — the user opted to skip that for v1 and use the open YNR API instead. |
| **Party policies** | AI-generated summaries in `data/parties.json`, with a clear disclaimer | User explicitly chose this over linking out or hard-coding. Kept short (~60 words), neutral, focused on local-government-relevant positions. |
| **Hosting** | GitHub Pages, static site | User specified GitHub. |
| **Visual style** | Clean, minimal, light-mode only, serious civic tone | User chose "clean & minimal (white, lots of space, serious tone)" over playful or GOV.UK styles. Light-mode forced via `<meta name="color-scheme" content="light only">` — a user report of dark appearance turned out to be the Claude iOS app's own preview, not a real rendering issue. |
| **Typography** | Fraunces (serif display) + Inter Tight (sans body) | Editorial, slightly authoritative, deliberately not the generic Inter-everywhere look. |
| **Extra scraping** | GitHub Action runs nightly, commits `candidate-extras.json` | User correctly intuited that live browser scraping can't work on a static site. Server-side nightly enrichment was the right pattern. Script uses only stdlib. |

## Things we deliberately did **not** do (and the reasoning)

- **No user accounts, no analytics, no cookies.** This is a civic tool; user
  privacy is a feature.
- **No map / polling station lookup.** That needs the authenticated API, and
  WhoCanIVoteFor.co.uk already does it excellently.
- **No build system (webpack / vite / etc).** Adds complexity with no benefit
  for a site of this size.
- **No framework (React / Vue / etc).** Same reason. Pure DOM is ~400 lines.
- **No live scraping from the browser.** Impossible for a static site — CORS
  and missing server context. The nightly Action is the correct pattern.

---

## File-by-file guide

```
index.html                    — Page shell. Semantic HTML, ARIA live region for status.
css/styles.css                — Design tokens in :root custom properties. Force light-mode.
js/app.js                     — All logic. IIFE, no globals. ~450 lines.
data/parties.json             — Party summaries. Hand-edit freely; JSON is flat.
data/candidate-extras.json    — Overwritten nightly. Don't hand-edit.
scripts/enrich_candidates.py  — Python 3.12, stdlib only. Runs in CI.
.github/workflows/enrich.yml  — Nightly schedule (03:17 UTC) + manual trigger.
README.md                     — User-facing deployment instructions.
```

### The one non-obvious bit of logic

In `js/app.js`, `fetchBallot()` constructs a `ballot_paper_id` by slugifying
the council and ward names from postcodes.io, e.g.
`local.tower-hamlets.bethnal-green-east.2026-05-07`. This **direct fetch** is
the fast path. If that 404s, `fetchBallotFallback()` paginates the council's
ballots for the date and fuzzy-matches by ward label.

Reason for the fallback: occasionally Democracy Club's slug differs slightly
from postcodes.io's ward label (apostrophes, slashes, "St." vs "Saint", etc.).
Tested against real postcodes in Adur, Tower Hamlets, Westminster — direct
fetch works for the majority; the fallback catches the rest.

### Why partyKeyForCandidate() uses substring matching

Rather than depending on Democracy Club's internal `party_id` (format:
`"party:90"`), which can change, we match on the canonical party name. This
keeps `data/parties.json` keys human-readable (`labour`, `green`, etc.) and
means a new minor party can be added just by editing both files.

---

## Known limitations, in plain terms

1. **May 7, not May 9.** The user initially asked about "May the 9th"; the
   actual date is Thursday 7 May 2026. `ELECTION_DATE` is a constant in two
   places: `js/app.js` and `scripts/enrich_candidates.py`. Keep them in sync.

2. **Town, parish, and community councils are not covered.** Democracy Club
   does not collect their data. If a postcode only has a parish election on
   7 May 2026, the site will show "no election found" — which is technically
   correct for our dataset.

3. **Data latency.** Candidate data appears as councils publish their
   Statements of Persons Nominated (SoPNs). Democracy Club imports happen
   within a day or two of SoPN publication. For the 2026 elections, SoPNs
   were published 9–10 April 2026.

4. **Party policy summaries are AI-generated.** They are intentionally short
   and neutral, but any summary can be subtly mischaracterising. The site
   carries a visible disclaimer. If the user spots an issue, `data/parties.json`
   is designed to be edited directly — no redeploy complexity.

5. **Democracy Club's service does go down occasionally.** During the initial
   build, both the API and main site returned 503 for several minutes. The
   client has retries and user-friendly error messages; the scraper has
   retries with exponential backoff. This is a feature of a small non-profit
   running free infra, not a bug to fix on our side.

6. **The `developers.democracyclub.org.uk` API exists and is better.** It
   provides a direct `/postcode/` endpoint that handles split postcodes and
   returns polling stations. If you want to upgrade, request a free API key
   from Democracy Club and swap the `lookupPostcode()` / `fetchBallot()`
   functions to use that single call instead. The shape of the response is
   in the YNR scraper source as a reference.

---

## What "done" looks like right now

✅ Site renders correctly on desktop and mobile, light mode forced.
✅ Postcode validation, lookup, ballot fetch, candidate rendering all work
   end-to-end. Tested with real postcodes (Adur BN43, Tower Hamlets E1).
✅ Party policy cards render with AI-generated summaries from `parties.json`.
✅ Nightly enrichment script tested — handles 503s gracefully, extracts
   identifiers from YNR's person records.
✅ GitHub Actions workflow authored but not yet run in a real repo.
✅ README covers deployment, Pages enablement, Action permissions.

## Sensible next steps (not yet done)

These are natural follow-ups if the user wants to keep iterating:

- [ ] **First real deploy.** Push to a GitHub repo, enable Pages, run the
      enrichment workflow manually to seed `candidate-extras.json`.
- [ ] **Polling station lookup.** Either via Democracy Club's authenticated
      API, or by linking the user straight to `wheredoivote.co.uk/postcode/X/`.
- [ ] **"Candidates near me" shareable links.** Already partially supported
      via `?postcode=` query param; could expose a share button.
- [ ] **Party logos.** `parties.json` supports an optional field; currently we
      only use the colour swatch.
- [ ] **Accessibility audit.** Run axe-core or similar; the HTML is semantic
      and ARIA-labelled, but hasn't been audited in anger.
- [ ] **Review party summaries** with a fresh read closer to election day, in
      case any have materially shifted.

---

## How to brief a new Claude on this project

Paste the following into a new Claude conversation (Desktop, mobile, or web):

> I'm continuing a project I started in another Claude conversation. It's a
> static site for the UK local elections on Thursday 7 May 2026 — users enter
> a postcode and see their ward's candidates plus short summaries of each
> party's policies. Repo: https://github.com/civictoolbox/your-ballot
>
> Read `PROJECT_HANDOFF.md` in the repo first. It captures the architecture,
> decisions made, and what's done vs. still to do. Don't re-ask me questions
> that file already answers.
>
> [Then state what you want to work on.]

---

*Last updated at initial build, April 2026.*
