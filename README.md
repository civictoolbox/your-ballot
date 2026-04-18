# Your Ballot

A postcode-based lookup tool for the UK local elections on **Thursday 7 May 2026**.

Enter a UK postcode → see the candidates standing in your ward, the parties they
represent, and short summaries of what those parties stand for.

Built as a static site (HTML / CSS / vanilla JS) so it can be hosted free on
GitHub Pages with zero server costs.

---

## Data sources

| Data                          | Source                                       | Access       |
| ----------------------------- | -------------------------------------------- | ------------ |
| Postcode → ward + council     | [postcodes.io](https://postcodes.io/)        | Public, no key |
| Candidates + parties          | [Democracy Club YNR](https://candidates.democracyclub.org.uk/api/next/) | Public, no key |
| Candidate socials / websites  | Nightly enrichment from Democracy Club       | Committed JSON |
| Party policy summaries        | `data/parties.json` (AI-generated, editable) | Static        |

The site makes client-side requests to postcodes.io and Democracy Club from the
user's browser — there is no server component. If either of those APIs is
temporarily unavailable, the user sees a friendly error and can retry.

---

## Project layout

```
.
├── index.html                      # Page shell
├── css/
│   └── styles.css                  # Clean, minimal light-mode styles
├── js/
│   └── app.js                      # Postcode lookup + ballot rendering
├── data/
│   ├── parties.json                # Party policy summaries (edit freely)
│   └── candidate-extras.json       # Built nightly by the Action below
├── scripts/
│   └── enrich_candidates.py        # Python enrichment script (no deps)
├── .github/workflows/
│   └── enrich.yml                  # Nightly schedule + manual trigger
└── README.md
```

---

## Deploying to GitHub Pages

1. **Create a new repo** on GitHub and push the contents of this folder to it.

   ```bash
   git init
   git add .
   git commit -m "Initial commit"
   git branch -M main
   git remote add origin git@github.com:civictoolbox/your-ballot.git
   git push -u origin main
   ```

2. **Enable Pages**: Repository → **Settings → Pages**
   - *Source*: `Deploy from a branch`
   - *Branch*: `main` (or `master`) — folder `/ (root)`
   - Save. After ~1 minute your site will be live at
     `https://civictoolbox.github.io/your-ballot/`.

3. **(Optional) Custom domain**: add a `CNAME` file at the repo root containing
   your domain, then point a CNAME DNS record at `civictoolbox.github.io`.

---

## Enabling the nightly enrichment Action

The workflow in `.github/workflows/enrich.yml` runs every day at 03:17 UTC
(and can be triggered manually from the **Actions** tab). It re-fetches the
latest candidate data from Democracy Club and commits any changes to
`data/candidate-extras.json`.

**Before it can push commits**, grant the workflow write permission:

1. Repository → **Settings → Actions → General**.
2. Scroll to **Workflow permissions**.
3. Select **Read and write permissions**. Save.

The workflow uses only the Python standard library, so there is nothing to
install.

**To trigger a run immediately** (e.g. right after the first deployment):
**Actions** tab → *Nightly candidate data enrichment* → **Run workflow**.

---

## Editing party policy summaries

`data/parties.json` is a plain JSON file. Each party has:

```jsonc
{
  "display_name":  "Green Party",
  "colour":        "#02A95B",           // swatch shown next to the name
  "summary":       "A 2–4 sentence overview...",
  "themes":        ["Housing", "Climate"], // 4–5 short tags
  "manifesto_url": "https://..."         // official manifesto / policies page
}
```

Edit, commit, push — changes go live as soon as Pages redeploys (usually <1 min).

Party keys (`labour`, `conservative`, `green`, etc.) are matched by the
JavaScript using a loose name-based rule. If a new local/minor party appears
and you want to give it a proper summary, see `partyKeyForCandidate()` in
`js/app.js` to add a matching rule.

---

## Known limitations & honesty notes

- **May 7, not May 9.** The elections are on Thursday **7 May 2026**. The site
  is hard-coded to that date in `js/app.js` (`ELECTION_DATE`) and
  `scripts/enrich_candidates.py` (same constant).
- **Coverage.** Democracy Club covers all scheduled English council elections.
  Town / parish / community council elections are **not** included. For Scotland
  and Wales, only council by-elections within the May 2026 cycle are covered —
  Scottish/Welsh parliamentary elections are separate.
- **Party policy summaries are AI-generated** and deliberately kept short and
  neutral. They are not a substitute for reading each party's official
  manifesto and should not be the sole basis for a voting decision.
- **Candidate data freshness.** Democracy Club verifies nominations shortly
  after Statements of Persons Nominated (SoPNs) are published by councils (by
  law, 25 working days before polling day). If you search before your council
  publishes, no candidates will appear.
- **Nothing is stored.** The site has no database, no accounts, no cookies, no
  analytics. Postcodes are sent only to postcodes.io and Democracy Club —
  see their respective privacy policies.

---

## Running locally

No build step. Just open `index.html` in a browser. For the `fetch` calls to
work correctly against `data/parties.json`, serve the folder over HTTP:

```bash
# from the project root
python3 -m http.server 8000
# then visit http://localhost:8000/
```

---

## Licence & attribution

This project is non-partisan and not affiliated with any political party.

Built on the incredible work of [Democracy Club](https://democracyclub.org.uk/)
and the open data provided by [postcodes.io](https://postcodes.io/). If you find
this site useful, please [support Democracy Club](https://democracyclub.org.uk/donate/).
