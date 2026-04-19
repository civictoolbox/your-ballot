/* ============================================================
   Your Ballot — app.js
   ------------------------------------------------------------
   Flow:
     1. Validate UK postcode
     2. postcodes.io  -> admin_district + admin_ward
     3. Build ballot_paper_id  local.{council}.{ward}.2026-05-07
        Fallback: fetch council's ballots for the date and fuzzy-match ward
     4. Fetch ballot  -> candidate list with parties
     5. Enrich each candidate from /people/{id}/ (photo + identifiers/socials)
     6. Layer in local data/candidate-extras.json (nightly scraper)
     7. Render candidates + party policy cards (data/parties.json)
   ============================================================ */

(() => {
  'use strict';

  // ---------- Config ----------
  const ELECTION_DATE = '2026-05-07';
  const YNR_BASE = 'https://candidates.democracyclub.org.uk/api/next';
  const POSTCODES_BASE = 'https://api.postcodes.io/postcodes';
  const CONCURRENCY = 4; // max parallel person fetches

  // ---------- DOM refs ----------
  const form       = document.getElementById('postcode-form');
  const input      = document.getElementById('postcode-input');
  const submitBtn  = document.getElementById('postcode-submit');
  const errorEl    = document.getElementById('postcode-error');
  const statusEl   = document.getElementById('status-region');
  const results    = document.getElementById('results');
  const noElection = document.getElementById('no-election');
  const kicker     = document.getElementById('results-kicker');
  const heading    = document.getElementById('results-heading');
  const sub        = document.getElementById('results-sub');
  const grid       = document.getElementById('candidates-grid');
  const partiesSec = document.getElementById('parties-section');
  const partiesGrid= document.getElementById('parties-grid');
  const nextSteps  = document.getElementById('next-steps');
  const pollingLink= document.getElementById('polling-station-link');
  const shareBtn   = document.getElementById('share-btn');
  const shareHost  = document.getElementById('share-btn-host');
  const priorityTool   = document.getElementById('priority-tool');
  const priorityIssues = document.getElementById('priority-issues');
  const priorityNote   = document.getElementById('priority-note');
  const councilPowers  = document.getElementById('council-powers');
  const councilPowersSummaryText = document.getElementById('council-powers-summary-text');

  // ---------- Preloaded data (lazy) ----------
  let partiesDataPromise = null;
  let candidateExtrasPromise = null;

  const loadPartiesData = () => {
    if (!partiesDataPromise) {
      partiesDataPromise = fetch('data/parties.json', { cache: 'default' })
        .then(r => r.ok ? r.json() : {})
        .catch(() => ({}));
    }
    return partiesDataPromise;
  };

  const loadCandidateExtras = () => {
    if (!candidateExtrasPromise) {
      candidateExtrasPromise = fetch('data/candidate-extras.json', { cache: 'default' })
        .then(r => r.ok ? r.json() : {})
        .catch(() => ({}));
    }
    return candidateExtrasPromise;
  };

  // ---------- Helpers ----------
  const UK_POSTCODE_RE = /^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/i;

  const normalisePostcode = (raw) =>
    (raw || '').toUpperCase().replace(/\s+/g, '').trim();

  const formatPostcode = (raw) => {
    const n = normalisePostcode(raw);
    return n.length > 3 ? `${n.slice(0, -3)} ${n.slice(-3)}` : n;
  };

  const slugify = (s) =>
    (s || '')
      .toLowerCase()
      .replace(/['\u2019.]/g, '')          // drop apostrophes and dots
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');

  const setLoading = (on) => {
    submitBtn.disabled = on;
    submitBtn.classList.toggle('is-loading', on);
    submitBtn.querySelector('.btn-label').textContent = on ? 'Searching…' : 'Find candidates';
  };

  const showError = (msg) => {
    errorEl.textContent = msg;
    errorEl.hidden = false;
    statusEl.innerHTML = '';
  };

  const clearError = () => {
    errorEl.textContent = '';
    errorEl.hidden = true;
  };

  const setStatus = (msg) => {
    statusEl.innerHTML = msg
      ? `<p class="status-msg">${msg}</p>`
      : '';
  };

  const esc = (s) => String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  // Slugify a candidate's name for friendly URLs
  // (keep in sync with scripts/build_candidate_slug_index.py)
  const slugifyName = (name) => {
    if (!name) return '';
    let s = name.normalize('NFKD').replace(/\p{M}/gu, '');
    s = s.toLowerCase().replace(/'/g, '').replace(/\u2019/g, '');
    s = s.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return s;
  };
  const candidateHref = (personId, name) => {
    if (!personId) return '';
    const slug = slugifyName(name || '');
    return slug
      ? `candidate.html?name=${encodeURIComponent(slug)}&id=${encodeURIComponent(personId)}`
      : `candidate.html?id=${encodeURIComponent(personId)}`;
  };

  // Limited-concurrency map
  const mapLimit = async (items, limit, fn) => {
    const out = new Array(items.length);
    let i = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (true) {
        const idx = i++;
        if (idx >= items.length) return;
        try { out[idx] = await fn(items[idx], idx); }
        catch { out[idx] = null; }
      }
    });
    await Promise.all(workers);
    return out;
  };

  // Party identifier -> canonical key (matches keys in parties.json)
  // The Democracy Club party_id format is "party:N" or "joint-party:..."
  // and ec_id is like "PP52". We use a loose name-based fallback too.
  const partyKeyForCandidate = (cand) => {
    const name = (cand.party?.name || cand.party_name || '').toLowerCase();
    if (!name) return 'independent';
    if (name.includes('labour') && name.includes('co-op')) return 'labour-coop';
    if (name.includes('labour'))                 return 'labour';
    if (name.includes('conservative'))           return 'conservative';
    if (name.includes('liberal democrat'))       return 'libdem';
    if (name.includes('green party'))            return 'green';
    if (name.includes('reform uk') || name === 'reform uk') return 'reform';
    if (name.includes('plaid cymru'))            return 'plaid';
    if (name.includes('scottish national'))      return 'snp';
    if (name.includes('sinn féin') || name.includes('sinn fein')) return 'sinn-fein';
    if (name.includes('dup') || name.includes('democratic unionist')) return 'dup';
    if (name.includes('alliance party') || name.trim() === 'alliance') return 'alliance';
    if (name.includes('sdlp'))                   return 'sdlp';
    if (name.includes('uup') || name.includes('ulster unionist')) return 'uup';
    if (name.includes('trade unionist and socialist')) return 'tusc';
    if (name.includes('workers party'))          return 'workers-party';
    if (name.includes('social democratic party') || name.trim() === 'sdp') return 'sdp';
    if (name.includes('heritage party'))         return 'heritage';
    if (name.includes('rejoin eu'))              return 'rejoin-eu';
    if (name.includes('advance uk'))             return 'advance-uk';
    if (name.includes('ukip') || name.includes('uk independence party')) return 'ukip';
    if (name.trim() === 'aspire')                return 'aspire';
    if (name.includes('communist party of britain')) return 'communist';
    if (name.includes('independent'))            return 'independent';
    return 'other';
  };

  // Fallback colour swatches (only used if parties.json doesn't define a colour)
  const FALLBACK_COLOURS = {
    'labour':       '#E4003B',
    'labour-coop':  '#E4003B',
    'conservative': '#0087DC',
    'libdem':       '#FAA61A',
    'green':        '#02A95B',
    'reform':       '#12B6CF',
    'plaid':        '#005B54',
    'snp':          '#FDF38E',
    'sinn-fein':    '#326760',
    'dup':          '#D46A4C',
    'alliance':     '#F6CB2F',
    'sdlp':         '#2AA82C',
    'uup':          '#48A5EE',
    'tusc':         '#C8102E',
    'workers-party':'#b41f24',
    'sdp':          '#004B87',
    'heritage':     '#2E7D32',
    'rejoin-eu':    '#003399',
    'advance-uk':   '#0D3B66',
    'ukip':         '#70147A',
    'aspire':       '#F7941D',
    'communist':    '#CC0000',
    'independent':  '#666666',
    'other':        '#666666',
  };

  // ---------- API steps ----------

  /** postcodes.io lookup. Returns location fields or throws. */
  const lookupPostcode = async (postcode) => {
    const url = `${POSTCODES_BASE}/${encodeURIComponent(postcode)}`;
    let res;
    try { res = await fetch(url); }
    catch (e) { throw new Error('Could not reach the postcode lookup service. Check your connection.'); }

    if (res.status === 404) throw new Error('That postcode wasn’t found. Please check and try again.');
    if (!res.ok)            throw new Error('Postcode lookup failed. Please try again.');

    const data = await res.json();
    const r = data.result;
    if (!r)                 throw new Error('That postcode wasn’t found.');
    if (!r.admin_district || !r.admin_ward) {
      throw new Error('We found your postcode but couldn’t determine your local ward.');
    }
    return {
      district:    r.admin_district,
      ward:        r.admin_ward,
      county:      r.admin_county || null,   // only present in two-tier areas
      wardGss:     r.codes?.admin_ward,
      districtGss: r.codes?.admin_district,
      countyGss:   r.codes?.admin_county,
      country:     r.country,
    };
  };

  /** Count the ballots for a given council slug on ELECTION_DATE. Used to
      detect whether a two-tier county layer has elections when the district
      doesn't. */
  const countCouncilBallots = async (councilSlug) => {
    try {
      const electionId = `local.${councilSlug}.${ELECTION_DATE}`;
      const res = await fetch(
        `${YNR_BASE}/ballots/?election_id=${encodeURIComponent(electionId)}&page_size=1`
      );
      if (!res.ok) return 0;
      const data = await res.json();
      return data.count || 0;
    } catch { return 0; }
  };

  /** Try the exact slugified ballot_paper_id first. */
  const fetchBallotDirect = async (councilSlug, wardSlug) => {
    const id = `local.${councilSlug}.${wardSlug}.${ELECTION_DATE}`;
    const res = await fetch(`${YNR_BASE}/ballots/${id}/`);
    if (!res.ok) return null;
    return res.json();
  };

  /** Fallback: paginate council ballots and fuzzy-match by ward label. */
  const fetchBallotFallback = async (councilSlug, wardLabel) => {
    // Filter by election_id if possible - cheaper
    const electionId = `local.${councilSlug}.${ELECTION_DATE}`;
    const wardNorm = slugify(wardLabel);

    let url = `${YNR_BASE}/ballots/?election_id=${encodeURIComponent(electionId)}&page_size=100`;
    for (let page = 0; page < 5 && url; page++) {
      let res;
      try { res = await fetch(url); } catch { return null; }
      if (!res.ok) return null;
      const data = await res.json();
      for (const b of data.results || []) {
        if (slugify(b.post?.label || '') === wardNorm) {
          // Fetch the full ballot detail (list view is summary)
          const det = await fetch(`${YNR_BASE}/ballots/${b.ballot_paper_id}/`);
          if (det.ok) return det.json();
        }
      }
      url = data.next;
    }
    return null;
  };

  /** Fetch ballot via direct slug, fall back to scan. */
  const fetchBallot = async (district, ward) => {
    const councilSlug = slugify(district);
    const wardSlug    = slugify(ward);
    const direct = await fetchBallotDirect(councilSlug, wardSlug);
    if (direct) return direct;
    return fetchBallotFallback(councilSlug, ward);
  };

  /** Fetch person detail (for photo + social identifiers). */
  const fetchPerson = async (personId) => {
    try {
      const res = await fetch(`${YNR_BASE}/people/${personId}/`);
      if (!res.ok) return null;
      return res.json();
    } catch { return null; }
  };

  // ---------- Rendering ----------

  const renderCandidates = (ballot, enriched, extras) => {
    const candidacies = ballot.candidacies || [];
    if (!candidacies.length) {
      grid.innerHTML = `<p class="status-msg">No candidates have been published for this ballot yet.</p>`;
      return;
    }

    // Sort alphabetically by surname (as on ballot paper)
    const sorted = candidacies.slice().sort((a, b) => {
      const la = (a.sopn_last_name || a.person?.name || '').toLowerCase();
      const lb = (b.sopn_last_name || b.person?.name || '').toLowerCase();
      return la.localeCompare(lb);
    });

    const currentBpi = ballot.ballot_paper_id || '';

    grid.innerHTML = sorted.map((c, i) => {
      const person = enriched[i] || c.person || {};
      const displayName = person.name || [c.sopn_first_names, c.sopn_last_name].filter(Boolean).join(' ');
      const partyName   = c.party?.name || c.party_name || 'Independent';
      const partyKey    = partyKeyForCandidate(c);
      const colour      = FALLBACK_COLOURS[partyKey] || FALLBACK_COLOURS.other;

      // ── Links (socials + email + profile) ─────────────────────────
      const identifiers = person.identifiers || [];
      const personalEmail = person.email;
      const extra = extras[person.id] || extras[c.person?.id] || {};

      const links = [];
      const pushLink = (label, href) => {
        if (!href) return;
        if (!/^https?:\/\//i.test(href) && !href.startsWith('mailto:')) return;
        links.push({ label, href });
      };

      identifiers.forEach(i => {
        const v = i.value_type, val = i.value;
        if (!val) return;
        if (v === 'twitter_username')       pushLink('Twitter/X',   `https://twitter.com/${val.replace(/^@/, '')}`);
        else if (v === 'facebook_page_url') pushLink('Facebook',    val);
        else if (v === 'instagram_url')     pushLink('Instagram',   val);
        else if (v === 'linkedin_url')      pushLink('LinkedIn',    val);
        else if (v === 'homepage_url')      pushLink('Website',     val);
        else if (v === 'party_ppc_page_url')pushLink('Party page',  val);
        else if (v === 'wikipedia_url')     pushLink('Wikipedia',   val);
        else if (v === 'blog_url')          pushLink('Blog',        val);
      });
      (extra.links || []).forEach(l => pushLink(l.label, l.href));
      if (personalEmail) pushLink('Email', `mailto:${personalEmail}`);

      // ── Past elections count (from YNR candidacies) ───────────────
      const pastCandidacies = (person.candidacies || person.memberships || [])
        .filter(m => {
          const bpi = m.ballot?.ballot_paper_id || '';
          if (bpi === currentBpi) return false;
          const date = (bpi.match(/(\d{4}-\d{2}-\d{2})$/) || [])[1] || '';
          return !!date && date !== ELECTION_DATE;
        });
      const pastCount = pastCandidacies.length;
      const pastWon = pastCandidacies.filter(m => m.elected === true).length;
      const pastLabel = pastCount === 0
        ? 'First-time candidate'
        : `${pastCount} past election${pastCount === 1 ? '' : 's'}${pastWon > 0 ? ` · won ${pastWon}` : ''}`;

      // ── Statement ─────────────────────────────────────────────────
      // Full statement (not a snippet). These are the candidate's own
      // published words to Democracy Club — voters should read them in full.
      const statement = (person.statement_to_voters || '').trim();

      // ── Photo ─────────────────────────────────────────────────────
      const photoUrl = person.thumbnail || person.image || '';

      // ── Name, always linked to profile page when we have an ID ────
      const nameHtml = person.id
        ? `<a href="${esc(candidateHref(person.id, displayName))}">${esc(displayName)}</a>`
        : esc(displayName);

      const profileHref = person.id ? candidateHref(person.id, displayName) : null;

      return `
        <article class="candidate candidate-compare" data-party-key="${esc(partyKey)}">
          <div class="candidate-photo ${photoUrl ? '' : 'is-placeholder'}" aria-hidden="true">
            ${photoUrl ? `<img src="${esc(photoUrl)}" alt="" loading="lazy" />` : '<span class="photo-placeholder-mark" aria-hidden="true"></span>'}
          </div>
          <div class="candidate-main">
            <h3 class="candidate-name">${nameHtml}</h3>
            <p class="candidate-party">
              <span class="party-swatch" style="background:${colour}"></span>
              ${esc(partyName)}
            </p>
            <dl class="candidate-facts">
              <div class="fact">
                <dt>History</dt>
                <dd>${esc(pastLabel)}</dd>
              </div>
              <div class="fact">
                <dt>Statement</dt>
                <dd>${statement ? 'Submitted' : '<span class="fact-empty">Not submitted</span>'}</dd>
              </div>
              <div class="fact">
                <dt>Contact</dt>
                <dd>${links.length ? `${links.length} link${links.length === 1 ? '' : 's'}` : '<span class="fact-empty">None listed</span>'}</dd>
              </div>
            </dl>
            ${statement ? `
              <blockquote class="candidate-statement-full">
                ${esc(statement).split(/\n\s*\n/).map(p => `<p>${p.replace(/\n/g, '<br>')}</p>`).join('')}
                <cite>— ${esc(displayName)}, to Democracy Club</cite>
              </blockquote>` : ''}
            <div class="candidate-positions" data-person-id="${esc(person.id || '')}" hidden></div>
            ${links.length ? `
              <p class="candidate-links">
                ${links.map(l => `<a href="${esc(l.href)}" rel="noopener" target="_blank">${esc(l.label)}</a>`).join('')}
              </p>` : ''}
            ${profileHref ? `<p class="candidate-profile-link"><a href="${esc(profileHref)}">Full profile →</a></p>` : ''}
          </div>
        </article>
      `;
    }).join('');
  };

  const renderParties = async (ballot) => {
    const partyData = await loadPartiesData();

    // Unique parties in this ballot
    const seen = new Map();
    for (const c of ballot.candidacies || []) {
      const key = partyKeyForCandidate(c);
      if (!seen.has(key)) {
        seen.set(key, {
          key,
          name: c.party?.name || c.party_name || 'Independent',
        });
      }
    }

    const cards = Array.from(seen.values()).map(p => {
      const info = partyData[p.key] || {};
      const colour = info.colour || FALLBACK_COLOURS[p.key] || FALLBACK_COLOURS.other;
      const name = info.display_name || p.name;
      const summary = info.summary || (
        p.key === 'independent'
          ? 'Independent candidates do not represent a political party. Each sets out their own platform — see the candidate’s links for details.'
          : 'No policy summary is available for this party in our dataset.'
      );
      const themes = (info.themes || []).slice(0, 5);
      const manifesto = info.manifesto_url;

      return `
        <article class="party-card">
          <div class="party-card-head">
            <span class="party-card-swatch" style="background:${colour}"></span>
            <h4 class="party-card-name">${esc(name)}</h4>
          </div>
          <p class="party-card-summary">${esc(summary)}</p>
          ${themes.length ? `
            <ul class="party-card-themes">
              ${themes.map(t => `<li>${esc(t)}</li>`).join('')}
            </ul>` : ''}
          ${manifesto ? `
            <a class="party-card-link" href="${esc(manifesto)}" rel="noopener" target="_blank">Read the full manifesto →</a>` : ''}
        </article>
      `;
    }).join('');

    if (cards) {
      partiesGrid.innerHTML = cards;
      partiesSec.hidden = false;
    } else {
      partiesSec.hidden = true;
    }
  };

  const renderNextSteps = (postcode) => {
    if (!nextSteps) return;
    const pcCompact = normalisePostcode(postcode);
    if (pollingLink) {
      // If we have a postcode, link directly. Otherwise fall back to the
      // root of wheredoivote.co.uk (user enters their own postcode there).
      pollingLink.href = pcCompact
        ? `https://wheredoivote.co.uk/postcode/${encodeURIComponent(pcCompact)}/`
        : 'https://wheredoivote.co.uk/';
      const host = pollingLink.querySelector('.next-step-host');
      if (host) host.textContent = pcCompact
        ? 'on wheredoivote.co.uk →'
        : 'enter your postcode on wheredoivote.co.uk →';
    }
    if (shareHost) shareHost.textContent = 'Copy link';
    nextSteps.hidden = false;
  };

  const handleShare = async () => {
    if (!shareBtn) return;
    // Always share whatever the current browser URL is — after a successful
    // lookup that's ?council=X&ward=Y (or ?postcode=X). Fully shareable.
    const url = location.href;
    const setHost = (msg) => { if (shareHost) shareHost.textContent = msg; };

    // Prefer the native share sheet on mobile; fall back to clipboard.
    if (navigator.share) {
      try {
        await navigator.share({
          title: 'Your Ballot — candidates',
          text: `Candidates on the ballot for 7 May 2026`,
          url,
        });
        setHost('Shared');
        return;
      } catch {
        // User cancelled or share failed — fall through to clipboard
      }
    }

    try {
      await navigator.clipboard.writeText(url);
      setHost('Link copied');
    } catch {
      setHost('Copy failed');
      console.error('Clipboard write failed');
    }
    setTimeout(() => setHost('Copy link'), 2500);
  };

  // ── Priority tool — "what matters to you?" ─────────────────────────────
  const renderPriorityTool = async (ballot) => {
    if (!priorityTool || !priorityIssues) return;
    const partiesData = await loadPartiesData();
    const issueMeta = (partiesData && partiesData._meta && partiesData._meta.issues) || [];
    if (!issueMeta.length) { priorityTool.hidden = true; return; }

    priorityIssues.innerHTML = issueMeta.map(({ key, label }) => `
      <label class="priority-chip">
        <input type="checkbox" value="${esc(key)}" />
        <span>${esc(label)}</span>
      </label>
    `).join('');

    const updatePositions = () => {
      const selected = Array.from(priorityIssues.querySelectorAll('input[type="checkbox"]:checked'))
        .map(cb => cb.value);
      // For each candidate card, render the party's position on each selected issue
      document.querySelectorAll('.candidate-positions').forEach(el => {
        const card = el.closest('.candidate');
        const key = card?.dataset.partyKey || 'other';
        const info = (partiesData && partiesData[key]) || {};
        const positions = info.positions || {};
        if (!selected.length) {
          el.hidden = true;
          el.innerHTML = '';
          return;
        }
        const items = selected.map(issueKey => {
          const label = (issueMeta.find(i => i.key === issueKey) || {}).label || issueKey;
          const text = positions[issueKey];
          if (!text) {
            return `
              <div class="candidate-position-item is-empty">
                <dt>${esc(label)}</dt>
                <dd>${info.display_name ? `No position data for ${esc(info.display_name)} on this issue.` : 'No position data for this party on this issue.'}</dd>
              </div>`;
          }
          return `
            <div class="candidate-position-item">
              <dt>${esc(label)}</dt>
              <dd>${esc(text)}</dd>
            </div>`;
        }).join('');
        el.innerHTML = `
          <p class="candidate-positions-intro">
            What <strong>${esc(info.display_name || 'this candidate\u2019s party')}</strong> says on the issues you picked
            <span class="candidate-positions-disclaimer">(party-level position, not this specific candidate's)</span>:
          </p>
          <dl class="candidate-positions-list">${items}</dl>`;
        el.hidden = false;
      });

      // Summary note under the checkboxes
      if (priorityNote) {
        priorityNote.textContent = selected.length
          ? `Showing each party's published position on ${selected.length} issue${selected.length === 1 ? '' : 's'} above.`
          : 'Pick one or more issues above to reveal party positions under each candidate.';
      }
    };

    priorityIssues.querySelectorAll('input[type="checkbox"]').forEach(cb => {
      cb.addEventListener('change', updatePositions);
    });

    updatePositions();
    priorityTool.hidden = false;
  };

  // ── Council powers — "what does this council actually do?" ─────────────
  const renderCouncilPowers = (councilName) => {
    if (!councilPowers || !councilPowersSummaryText) return;
    councilPowersSummaryText.textContent = `What does ${councilName} actually decide?`;
    councilPowers.hidden = false;
  };

  const renderResults = async ({ district, ward, postcode }, ballot, enriched, extras) => {
    noElection.hidden = true;
    results.hidden = false;

    kicker.textContent  = postcode
      ? `${district} · ${formatPostcode(postcode)}`
      : district;
    heading.textContent = ward;
    const seats = ballot.winner_count || 1;
    const nCand = (ballot.candidacies || []).length;
    sub.textContent = `${nCand} candidate${nCand === 1 ? '' : 's'} standing for ${seats} seat${seats === 1 ? '' : 's'} on Thursday 7 May 2026.`;

    renderCandidates(ballot, enriched, extras);
    renderNextSteps(postcode);
    renderCouncilPowers(district);
    await renderPriorityTool(ballot);
    await renderParties(ballot);

    // Smooth scroll into view
    results.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const renderNoElection = ({ district, ward, postcode }) => {
    results.hidden = true;
    partiesSec.hidden = true;
    if (nextSteps) nextSteps.hidden = true;
    noElection.hidden = false;
    // Reset to the default message (a later county-detect path may replace it).
    noElection.querySelector('h2').textContent =
      `No 2026 local election found for ${district}`;
    const body = noElection.querySelector('#no-election-body');
    if (body) body.innerHTML = `
      <p>We couldn't find a local election on 7 May 2026 for your area.
      This may mean your council isn't holding an election this year, or the
      data hasn't been published yet.</p>
      <p>Try
        <a href="https://whocanivotefor.co.uk/elections/${encodeURIComponent(normalisePostcode(postcode))}/" rel="noopener" target="_blank">Who Can I Vote For?</a>
        — Democracy Club's own tool — which also handles "split postcodes" where
        one postcode covers multiple wards.</p>`;
    noElection.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const partyKeyFromName = (name) => partyKeyForCandidate({ party_name: name });

  const renderCountyDivisionsInline = async (countySlug, container) => {
    try {
      const res = await fetch(`data/councils/${encodeURIComponent(countySlug)}.json`, { cache: 'default' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const wards = (data.wards || []).slice().sort((a, b) =>
        (a.ward_name || '').toLowerCase().localeCompare((b.ward_name || '').toLowerCase())
      );
      if (!wards.length) {
        container.innerHTML = '<p class="status-msg">No division data available.</p>';
        return;
      }

      container.innerHTML = `
        <label for="division-search" class="postcode-label" style="margin-top:1.5rem;">
          Or find your division here
        </label>
        <div class="postcode-row">
          <input
            id="division-search"
            type="search"
            inputmode="text"
            autocomplete="off"
            spellcheck="false"
            placeholder="e.g. Chailey, Crowborough, Hailsham"
          />
        </div>
        <p class="postcode-help">
          ${wards.length} divisions across ${esc(data._meta?.council_name || countySlug)}.
          Click a division to see its candidates.
        </p>
        <section class="council-list" id="division-list" aria-label="County divisions"></section>
      `;

      const listEl = container.querySelector('#division-list');
      const searchInput = container.querySelector('#division-search');

      const renderList = (filter) => {
        const q = (filter || '').toLowerCase().trim();
        const visible = q
          ? wards.filter(w => (w.ward_name || '').toLowerCase().includes(q))
          : wards;
        if (!visible.length) {
          listEl.innerHTML = '<p class="status-msg">No divisions match that search.</p>';
          return;
        }
        listEl.innerHTML = visible.map(w => {
          const seats = w.seats_contested || 1;
          const nCand = (w.candidates || []).length;
          return `
            <article class="council-row" data-ward="${esc(w.ward_name)}">
              <button class="council-toggle" type="button" aria-expanded="false">
                <span class="council-name">${esc(w.ward_name)}</span>
                <span class="council-meta">
                  ${seats} ${seats === 1 ? 'seat' : 'seats'} &middot; ${nCand} ${nCand === 1 ? 'candidate' : 'candidates'}
                </span>
                <span class="council-chevron" aria-hidden="true">▸</span>
              </button>
              <div class="council-wards" hidden></div>
            </article>`;
        }).join('');

        listEl.querySelectorAll('.council-toggle').forEach(btn => {
          btn.addEventListener('click', () => {
            const row = btn.closest('.council-row');
            const wardName = row?.dataset.ward;
            const ward = wards.find(w => w.ward_name === wardName);
            const detail = row.querySelector('.council-wards');
            const isOpen = row.classList.contains('is-open');
            if (isOpen) {
              row.classList.remove('is-open');
              btn.setAttribute('aria-expanded', 'false');
              detail.hidden = true;
            } else {
              row.classList.add('is-open');
              btn.setAttribute('aria-expanded', 'true');
              detail.hidden = false;
              if (!detail.dataset.rendered) {
                const sorted = (ward.candidates || []).slice().sort((a, b) =>
                  (a.name || '').split(' ').pop().toLowerCase()
                    .localeCompare((b.name || '').split(' ').pop().toLowerCase())
                );
                detail.innerHTML = `
                  <section class="ward">
                    <ul class="candidate-list">
                      ${sorted.map(c => {
                        const colour = FALLBACK_COLOURS[partyKeyFromName(c.party_name)] || FALLBACK_COLOURS.other;
                        const profile = c.person_id ? candidateHref(c.person_id, c.name) : null;
                        return `
                          <li class="candidate-item">
                            <span class="candidate-item-name">${profile ? `<a href="${esc(profile)}">${esc(c.name)}</a>` : esc(c.name)}</span>
                            <span class="candidate-item-party">
                              <span class="party-swatch" style="background:${colour}"></span>
                              ${esc(c.party_name)}
                            </span>
                          </li>`;
                      }).join('')}
                    </ul>
                  </section>`;
                detail.dataset.rendered = '1';
              }
            }
          });
        });
      };

      renderList('');
      searchInput.addEventListener('input', (e) => renderList(e.target.value));
    } catch (e) {
      console.error('Failed to load county divisions inline', e);
      container.innerHTML = '<p class="status-msg">Could not load divisions inline — try the browse link above.</p>';
    }
  };

  const renderCountyOnlyElection = ({ district, ward, county, postcode }, ballotCount) => {
    results.hidden = true;
    partiesSec.hidden = true;
    if (nextSteps) nextSteps.hidden = true;
    noElection.hidden = false;
    noElection.querySelector('h2').textContent =
      `${county} County Council is holding an election on 7 May 2026`;
    const countySlug = slugify(county);
    const pcUrl = encodeURIComponent(normalisePostcode(postcode));
    const body = noElection.querySelector('#no-election-body');
    if (body) body.innerHTML = `
      <p>Your district (<strong>${esc(district)}</strong>) isn't holding an election this year —
      but <strong>${esc(county)}</strong>, the county above it, is.
      There are <strong>${ballotCount} ${ballotCount === 1 ? 'division' : 'divisions'}</strong>
      up for election across ${esc(county)}.</p>

      <p>County elections use <em>electoral divisions</em> rather than the ward
      your postcode sits in, and a single postcode can cover more than one
      division — so we can't auto-select your exact division from the postcode alone.</p>

      <div id="county-divisions-inline"></div>

      <p class="postcode-help" style="margin-top:2rem;">
        Not sure which division is yours? Democracy Club's
        <a href="https://whocanivotefor.co.uk/elections/${pcUrl}/" rel="noopener" target="_blank">Who Can I Vote For?</a>
        picks it from your exact address.
      </p>`;

    const inlineContainer = body.querySelector('#county-divisions-inline');
    if (inlineContainer) renderCountyDivisionsInline(countySlug, inlineContainer);

    noElection.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  // ---------- Direct ward loader (called when the URL already specifies
  //   ?council=X&ward=Y — skips the postcode.io resolution step). ----------
  const loadWardDirectly = async (councilSlug, wardSlug) => {
    setLoading(true);
    results.hidden = true;
    noElection.hidden = true;
    setStatus('Loading this ward…');

    try {
      // Pull the council's JSON so we have the human-readable names.
      let councilName = councilSlug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      let wardName = wardSlug.replace(/-/g, ' ');
      try {
        const councilRes = await fetch(
          `data/councils/${encodeURIComponent(councilSlug)}.json`,
          { cache: 'default' }
        );
        if (councilRes.ok) {
          const councilData = await councilRes.json();
          councilName = councilData._meta?.council_name || councilName;
          const match = (councilData.wards || []).find(
            w => slugify(w.ward_name) === wardSlug
          );
          if (match) wardName = match.ward_name;
        }
      } catch {}

      const ballot = await fetchBallotDirect(councilSlug, wardSlug);
      if (!ballot) {
        setStatus('');
        noElection.hidden = false;
        noElection.querySelector('h2').textContent = 'Ward not found';
        const body = noElection.querySelector('#no-election-body');
        if (body) body.innerHTML = `
          <p>We couldn't find a ward matching that URL on 7 May 2026.
          Try <a href="all.html">browsing all councils</a> or entering
          a postcode above.</p>`;
        return;
      }

      if (ballot.cancelled) {
        setStatus('');
        noElection.hidden = false;
        noElection.querySelector('h2').textContent = 'This election has been cancelled';
        return;
      }

      setStatus('Loading candidate details…');
      const candidacies = ballot.candidacies || [];
      const enriched = await mapLimit(candidacies, CONCURRENCY, async (c) => {
        const id = c.person?.id;
        if (!id) return c.person || null;
        const p = await fetchPerson(id);
        return p || c.person;
      });
      const extras = await loadCandidateExtras();
      setStatus('');

      // No postcode available from this entry path — renderResults handles that.
      await renderResults(
        { district: councilName, ward: wardName, postcode: '', wardSlug, councilSlug },
        ballot,
        enriched,
        extras
      );
    } catch (err) {
      setStatus('');
      showError(err.message || 'Something went wrong. Please try again.');
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  // ---------- Main handler ----------
  const handleSubmit = async (e) => {
    e.preventDefault();
    clearError();

    const raw = input.value;
    const pc  = normalisePostcode(raw);

    if (!pc) return showError('Please enter your postcode.');
    if (!UK_POSTCODE_RE.test(pc)) return showError('That doesn’t look like a UK postcode. Try e.g. SW1A 1AA.');

    setLoading(true);
    results.hidden = true;
    noElection.hidden = true;

    try {
      setStatus('Looking up your ward…');
      const loc = await lookupPostcode(pc);

      setStatus(`Finding candidates in ${loc.ward}, ${loc.district}…`);
      const ballot = await fetchBallot(loc.district, loc.ward);

      if (!ballot) {
        // Two-tier fallback: if the district has no election but the county
        // does (e.g. Wealden district / East Sussex county on 7 May 2026),
        // tell the user that specifically instead of the generic "no found".
        if (loc.county) {
          setStatus(`Checking ${loc.county}…`);
          const countyBallots = await countCouncilBallots(slugify(loc.county));
          setStatus('');
          if (countyBallots > 0) {
            return renderCountyOnlyElection({ ...loc, postcode: pc }, countyBallots);
          }
        }
        setStatus('');
        return renderNoElection({ ...loc, postcode: pc });
      }

      if (ballot.cancelled) {
        setStatus('');
        results.hidden = true;
        noElection.hidden = false;
        noElection.querySelector('h2').textContent = 'This election has been cancelled';
        return;
      }

      // Enrich candidates (fetch /people/ in parallel, capped)
      setStatus('Loading candidate details…');
      const candidacies = ballot.candidacies || [];
      const enriched = await mapLimit(candidacies, CONCURRENCY, async (c) => {
        const id = c.person?.id;
        if (!id) return c.person || null;
        const p = await fetchPerson(id);
        return p || c.person;
      });

      const extras = await loadCandidateExtras();

      setStatus('');

      // Promote the URL from ?postcode=… to ?council=X&ward=Y so the
      // address bar now reflects a navigable state. Fixes the "back button
      // jumps to homepage" issue reported by users: when they click a
      // candidate and hit back, the browser returns to a URL that
      // auto-reloads this ward.
      const councilSlug = slugify(loc.district);
      const wardSlug    = slugify(loc.ward);
      const wardUrl     = `?council=${encodeURIComponent(councilSlug)}&ward=${encodeURIComponent(wardSlug)}`;
      if (location.search !== wardUrl) {
        history.replaceState({ councilSlug, wardSlug }, '', wardUrl);
      }

      await renderResults(
        { ...loc, postcode: pc, councilSlug, wardSlug },
        ballot, enriched, extras
      );
    } catch (err) {
      setStatus('');
      showError(err.message || 'Something went wrong. Please try again.');
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  form.addEventListener('submit', handleSubmit);
  if (shareBtn) shareBtn.addEventListener('click', handleShare);

  // ── URL-param entry points ─────────────────────────────────────────────
  // Priority order (first match wins):
  //   1. ?council=X&ward=Y — jump straight to that ward (shareable,
  //      back-button-safe, no postcode.io round-trip)
  //   2. ?postcode=X       — auto-run the postcode lookup (back-compat for
  //      older share links that used this format)
  const params = new URLSearchParams(location.search);
  const urlCouncil = params.get('council');
  const urlWard    = params.get('ward');
  const shared     = params.get('postcode');

  if (urlCouncil && urlWard) {
    loadWardDirectly(urlCouncil, urlWard);
  } else if (shared) {
    input.value = formatPostcode(shared);
    setTimeout(() => form.requestSubmit(), 50);
  }

  // Auto-format postcode with a space as user types, non-destructively
  input.addEventListener('blur', () => {
    const v = input.value.trim();
    if (v && UK_POSTCODE_RE.test(normalisePostcode(v))) {
      input.value = formatPostcode(v);
    }
  });
})();
