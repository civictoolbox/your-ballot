# Security

Your Ballot is a static civic site hosted on GitHub Pages. This document
describes its security posture, its limits, and how to report a vulnerability.

## Reporting a vulnerability

If you believe you've found a security issue — please **don't** open a public
GitHub issue. Instead:

1. Open a **private security advisory** at
   <https://github.com/civictoolbox/your-ballot/security/advisories/new>
   (GitHub's built-in coordinated-disclosure flow).
2. Or email `sacredheartcollectiveuk@gmail.com` with subject
   `[your-ballot security]` and a clear description.

We'll acknowledge within 72 hours and aim to fix critical issues within 7 days.
Because this is a civic site running close to an election, we treat
defacement, data tampering, and XSS as the highest-priority categories.

## What's in place

### Transport
- **HTTPS-only** via GitHub Pages. HTTP requests to `civictoolbox.github.io`
  are 301-redirected to HTTPS.
- **HSTS** is served by GitHub Pages' edge, so the HTTPS-only enforcement
  survives even if someone visits over `http://`.
- **`upgrade-insecure-requests`** in CSP belt-and-braces.

### Content injection / XSS
- **Content Security Policy** via `<meta http-equiv>`. The policy:
  - `default-src 'self'` — blocks everything that isn't explicitly allowed.
  - `script-src 'self'` + pinned SHA-256 hashes for each inline JSON-LD
    block. No `'unsafe-inline'`, no `'unsafe-eval'`.
  - `style-src 'self' 'unsafe-inline'` — needed because we render inline
    `style="…"` on candidate rows (party-swatch colour). The values are
    hard-coded in our own JS, not user-controlled, so the residual risk
    is low. If CSS injection ever became a concern, we'd add a colour
    validator in the render path.
  - `connect-src` restricts XHR/fetch to our own origin plus
    `api.postcodes.io` and `candidates.democracyclub.org.uk` — no other
    network destinations can be reached from our code.
  - `img-src 'self' data: https:` — allows candidate photos served from
    any HTTPS host (Democracy Club / Gravatar / candidate campaign pages).
  - `frame-ancestors 'none'` — clickjacking defence. Note: meta-delivered
    CSP *doesn't* enforce `frame-ancestors` in browsers (it has to be a
    response header). GitHub Pages doesn't let us set custom headers, so
    this is documented-intent only until we're on a platform that does.
  - `base-uri 'self'`, `form-action 'self'`, `object-src 'none'` — block
    the usual bypass routes.
- **All user-derived data is HTML-escaped** before being interpolated into
  templates. We use a single `esc()` helper in every JS file; search
  `grep -n esc\(` in `js/` to audit.
- **URL validation** on every link built from third-party data: we accept
  only `https?://` and `mailto:` schemes, which blocks `javascript:` URLs
  and similar.
- **`rel="noopener"`** on every `<a target="_blank">` to external sites —
  prevents the external page from hijacking our `window.opener`.

### Cookies, tracking, auth
- **Zero cookies, zero local storage writes** from our code.
- **No authentication, no accounts, no sessions** — nothing to hijack.
- **No analytics that fingerprint users.** Traffic counts come from
  GitHub's server-side traffic API (`data/traffic-stats.json`,
  refreshed daily), which doesn't involve visitor cookies or
  client-side beacons.

### Dependencies / supply chain
- **No npm, no build step, no package-lock.** The runtime has zero
  third-party JS or CSS packaged with the site.
- **Third-party runtime loads** — only Google Fonts CSS + font files.
  Restricted to `fonts.googleapis.com` and `fonts.gstatic.com` in CSP.
  SRI is not applied because Google Fonts CSS varies by User-Agent;
  pinning a hash would break caching. Residual risk: if Google Fonts
  is compromised, the fonts could be poisoned (but can't execute
  scripts because `script-src` restricts that).
- **Runtime API dependencies** — `api.postcodes.io` (Ordnance Survey /
  ONS data) and `candidates.democracyclub.org.uk` (Democracy Club's YNR).
  Both are civic-tech / public-data services. If either is compromised
  we'd render bad data, not execute arbitrary code (XSS path is closed
  by CSP + `esc()`).

### Data integrity
- **Candidate data is read from Democracy Club** via their public YNR API
  at request time, plus a nightly CSV snapshot we commit to `data/`.
- If we display something wrong, the source is either DC's published data
  or the AI-written party summaries in `data/parties.json` (flagged
  throughout the site as AI-generated, non-authoritative).

## What's *not* in place

Being upfront about the gaps:

1. **No HTTP response headers beyond what GitHub Pages provides.** Pages
   doesn't let repository owners set custom `Content-Security-Policy`,
   `Strict-Transport-Security`, `Permissions-Policy`, `X-Frame-Options`,
   or `X-Content-Type-Options` headers. Our CSP is meta-tag-delivered,
   which means browsers ignore the `frame-ancestors`, `report-uri`, and
   `sandbox` directives. If we ever move to a proper host (Cloudflare
   Pages, Netlify, a Cloudflare Worker in front), we'll lift those into
   response headers.
2. **No Subresource Integrity on Google Fonts.** Pinning a hash would
   break when Google rotates the file for new browser versions. The
   tradeoff: we accept the residual risk that a Google Fonts compromise
   could ship poisoned *fonts* (no JS execution possible because CSP
   blocks script loads from those origins).
3. **Public repo.** Anyone can read the source and the data — which is
   by design (this is a civic tool, transparency is the point), but it
   means attackers also know the surface.
4. **No bug bounty.** Reports are welcome; no monetary rewards are
   offered.
5. **`'unsafe-inline'` for styles.** Needed because we render per-element
   `style="background:#E4003B"` for party swatches. The `background`
   value comes only from our own `FALLBACK_COLOURS` map and the hand-edited
   `data/parties.json`; it's never user-controlled. If you compromise
   either source, inline styles are the least of the problems.
6. **The repo has two write paths** — the civictoolbox GitHub account
   and the `github-actions[bot]` running our workflows. If either is
   compromised, an attacker can push to `main` and the site will serve
   whatever they push within ~1 minute. Mitigations:
   - Keep 2FA enabled on the civictoolbox GitHub account.
   - Keep the PAT in 1Password, rotate quarterly, and scope the
     `TRAFFIC_READ_TOKEN` narrowly (just `repo` — not every scope).
   - Consider branch-protection rules requiring the github-actions[bot]
     identity for certain paths (data/) and the owner for everything
     else.

## Threat model summary

This site is a pure client-side static application with no backend of our
own. The realistic threat categories, in descending order of impact:

| Threat | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| Attacker compromises civictoolbox GitHub account → pushes defaced `main` | Low (2FA + PAT in 1P) | Critical — wholesale defacement | 2FA, PAT rotation, branch protection |
| CDN compromise (Google Fonts) | Very low | Visual degradation (fonts); CSP blocks JS | CSP script-src 'self' + pinned hashes |
| XSS via unescaped candidate data | Low — `esc()` everywhere, CSP defence-in-depth | Defacement / session-less phishing | `esc()` helper + CSP |
| Clickjacking | Low — no authenticated actions to hijack | Low — we don't process consent flows | CSP `frame-ancestors 'none'` (docs-only on Pages) |
| DNS hijack of `civictoolbox.github.io` | Very low (GitHub controls DNS) | Critical | Nothing we control |
| Supply chain (npm/package) | N/A | N/A | No npm, no build step |

## Audit checklist (for us)

Run before each release:

- [ ] `grep -nE 'innerHTML.*\${' js/*.js | grep -v 'esc('` — anything
      unescaped in template literals?
- [ ] `curl -sI https://civictoolbox.github.io/your-ballot/ | grep -i
      '^strict-transport\|^content-security'` — confirm Pages still serves
      HTTPS + our meta CSP is in the rendered HTML.
- [ ] `gh auth status` — confirm the right accounts have access; rotate
      any PAT older than 90 days.
- [ ] Review `data/parties.json` and `data/traffic-stats.json` — anything
      that couldn't have come from us?
