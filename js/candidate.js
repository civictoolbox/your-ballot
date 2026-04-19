/* ============================================================
   Your Ballot — candidate.js
   ------------------------------------------------------------
   Per-candidate profile page.

   Flow:
     1. Read ?id=N from URL
     2. Fetch data/candidates-index.json  (~530 KB, cached)
     3. Resolve ID → council slug → fetch data/councils/<slug>.json
        to pull name / party / ward from our own data (fast, works
        offline for repeat visits)
     4. Render the basics immediately
     5. In parallel, fetch https://candidates.democracyclub.org.uk/
        api/next/people/{id}/ for photo, statement, socials, past
        memberships. Patch the DOM as it arrives.
     6. Also pull the party summary from data/parties.json and any
        other candidates in the same ward.
   ============================================================ */

(() => {
  'use strict';

  const YNR_BASE = 'https://candidates.democracyclub.org.uk/api/next';
  const ELECTION_DATE = '2026-05-07';

  // ---------- DOM refs ----------
  const statusEl    = document.getElementById('candidate-status');
  const bodyEl      = document.getElementById('candidate-body');
  const nameEl      = document.getElementById('candidate-name');
  const kickerEl    = document.getElementById('candidate-kicker');
  const partyEl     = document.getElementById('candidate-party');
  const wardEl      = document.getElementById('candidate-ward');
  const seatEl      = document.getElementById('candidate-seat');
  const photoWrap   = document.getElementById('candidate-photo-wrap');
  const photoImg    = document.getElementById('candidate-photo');
  const statementSec  = document.getElementById('statement-section');
  const statementEl = document.getElementById('candidate-statement');
  const statementSrcEl = document.getElementById('statement-source');
  const linksList   = document.getElementById('candidate-links');
  const linksEmpty  = document.getElementById('links-empty');
  const wcivfFallback = document.getElementById('wcivf-fallback');
  const historyList = document.getElementById('candidate-history');
  const historyEmpty = document.getElementById('history-empty');
  const partyCtxSec = document.getElementById('party-context-section');
  const partyCtxHead = document.getElementById('party-context-heading');
  const partyCtxCard = document.getElementById('party-context-card');
  const wardCtxSec  = document.getElementById('ward-context-section');
  const wardOthers  = document.getElementById('ward-others');

  // ---------- Helpers ----------
  const esc = (s) => String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const partyKey = (partyName) => {
    const n = (partyName || '').toLowerCase();
    if (!n) return 'independent';
    if (n.includes('labour') && n.includes('co-op')) return 'labour-coop';
    if (n.includes('labour')) return 'labour';
    if (n.includes('conservative')) return 'conservative';
    if (n.includes('liberal democrat')) return 'libdem';
    if (n.includes('green party')) return 'green';
    if (n.includes('reform uk') || n === 'reform uk') return 'reform';
    if (n.includes('plaid cymru')) return 'plaid';
    if (n.includes('scottish national')) return 'snp';
    if (n.includes('sinn féin') || n.includes('sinn fein')) return 'sinn-fein';
    if (n.includes('dup') || n.includes('democratic unionist')) return 'dup';
    if (n.includes('alliance')) return 'alliance';
    if (n.includes('sdlp')) return 'sdlp';
    if (n.includes('uup') || n.includes('ulster unionist')) return 'uup';
    if (n.includes('independent')) return 'independent';
    return 'other';
  };

  const COLOURS = {
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
    'independent':  '#666666',
    'other':        '#666666',
  };

  const IDENTIFIER_LABELS = {
    twitter_username:      { label: 'Twitter/X',  build: (v) => `https://twitter.com/${v.replace(/^@/, '')}` },
    facebook_page_url:     { label: 'Facebook',   build: (v) => v },
    facebook_personal_url: { label: 'Facebook',   build: (v) => v },
    instagram_url:         { label: 'Instagram',  build: (v) => v },
    linkedin_url:          { label: 'LinkedIn',   build: (v) => v },
    homepage_url:          { label: 'Website',    build: (v) => v },
    party_ppc_page_url:    { label: 'Party page', build: (v) => v },
    wikipedia_url:         { label: 'Wikipedia',  build: (v) => v },
    blog_url:              { label: 'Blog',       build: (v) => v },
    youtube_profile:       { label: 'YouTube',    build: (v) => v },
    mastodon_username:     { label: 'Mastodon',   build: (v) => v },
    threads_url:           { label: 'Threads',    build: (v) => v },
    bluesky_url:           { label: 'Bluesky',    build: (v) => v },
    tiktok_url:            { label: 'TikTok',     build: (v) => v },
  };

  const showStatus = (msg) => {
    statusEl.innerHTML = msg ? `<p class="status-msg">${esc(msg)}</p>` : '';
  };

  // ---------- Fetchers ----------
  let _indexPromise = null;
  const loadCandidatesIndex = () => {
    if (!_indexPromise) {
      _indexPromise = fetch('data/candidates-index.json', { cache: 'default' })
        .then(r => r.ok ? r.json() : null)
        .catch(() => null);
    }
    return _indexPromise;
  };

  const _councilCache = new Map();
  const loadCouncil = (slug) => {
    if (_councilCache.has(slug)) return _councilCache.get(slug);
    const p = fetch(`data/councils/${encodeURIComponent(slug)}.json`, { cache: 'default' })
      .then(r => r.ok ? r.json() : null)
      .catch(() => null);
    _councilCache.set(slug, p);
    return p;
  };

  let _partiesPromise = null;
  const loadPartiesJson = () => {
    if (!_partiesPromise) {
      _partiesPromise = fetch('data/parties.json', { cache: 'default' })
        .then(r => r.ok ? r.json() : {})
        .catch(() => ({}));
    }
    return _partiesPromise;
  };

  const fetchYnrPerson = async (id) => {
    try {
      const res = await fetch(`${YNR_BASE}/people/${encodeURIComponent(id)}/`);
      if (!res.ok) return null;
      return res.json();
    } catch {
      return null;
    }
  };

  // ---------- Render ----------
  const renderBasics = (candidate, council, ward) => {
    const name = candidate.name || 'Unknown candidate';
    nameEl.textContent = name;
    document.title = `${name} · Your Ballot`;

    const ogTitle = document.getElementById('og-title');
    if (ogTitle) ogTitle.content = `${name} · Your Ballot`;

    const partyName = candidate.party_name || 'Independent';
    const key = partyKey(partyName);
    const colour = COLOURS[key] || COLOURS.other;

    partyEl.innerHTML = `<span class="party-swatch" style="background:${colour}"></span>${esc(partyName)}`;
    wardEl.textContent = `${ward.ward_name}, ${council._meta.council_name}`;
    const seats = ward.seats_contested || 1;
    seatEl.textContent =
      `Standing for ${seats === 1 ? '1 seat' : `${seats} seats`} on Thursday 7 May 2026.`;

    kickerEl.textContent = `${council._meta.council_name} · ${ward.ward_name}`;

    bodyEl.hidden = false;
    showStatus('');

    // Set the WCIVF fallback href up-front — works without YNR.
    if (wcivfFallback) {
      wcivfFallback.href = `https://whocanivotefor.co.uk/person/${encodeURIComponent(candidate.person_id)}/`;
    }
  };

  const renderOtherCandidates = (candidate, ward) => {
    const others = (ward.candidates || []).filter(c => c.person_id !== candidate.person_id);
    if (!others.length) return;
    wardOthers.innerHTML = others.map(c => {
      const colour = COLOURS[partyKey(c.party_name)] || COLOURS.other;
      return `
        <li>
          <a class="ward-other-link" href="candidate.html?id=${encodeURIComponent(c.person_id)}">
            <span class="ward-other-name">${esc(c.name)}</span>
            <span class="ward-other-party">
              <span class="party-swatch" style="background:${colour}"></span>
              ${esc(c.party_name)}
            </span>
          </a>
        </li>`;
    }).join('');
    wardCtxSec.hidden = false;
  };

  const renderPartyContext = async (partyName) => {
    const partiesData = await loadPartiesJson();
    const key = partyKey(partyName);
    const info = partiesData[key];
    const colour = info?.colour || COLOURS[key] || COLOURS.other;
    const displayName = info?.display_name || partyName;
    const summary = info?.summary || (
      key === 'independent'
        ? `Independent candidates do not represent a political party. Each sets out their own platform — see the links above for what ${esc(partyName)} specifically has published.`
        : `No policy summary is available for this party in our dataset.`
    );
    const themes = info?.themes || [];
    const manifesto = info?.manifesto_url;

    partyCtxHead.textContent = `About ${displayName}`;
    partyCtxCard.innerHTML = `
      <div class="party-card-head">
        <span class="party-card-swatch" style="background:${colour}"></span>
        <h3 class="party-card-name">${esc(displayName)}</h3>
      </div>
      <p class="party-card-summary">${esc(summary)}</p>
      ${themes.length ? `
        <ul class="party-card-themes">
          ${themes.map(t => `<li>${esc(t)}</li>`).join('')}
        </ul>` : ''}
      ${manifesto ? `<a class="party-card-link" href="${esc(manifesto)}" rel="noopener" target="_blank">Read the full manifesto →</a>` : ''}
    `;
    partyCtxSec.hidden = false;
  };

  const renderLinksFromYnr = (person) => {
    const seen = new Set();
    const links = [];

    (person.identifiers || []).forEach(i => {
      const t = i.value_type;
      const v = (i.value || '').trim();
      const rule = IDENTIFIER_LABELS[t];
      if (!rule || !v) return;
      let href;
      try { href = rule.build(v); } catch { return; }
      if (!/^https?:\/\//i.test(href)) return;
      if (seen.has(href)) return;
      seen.add(href);
      links.push({ label: rule.label, href });
    });

    if (person.email) {
      links.push({ label: 'Email', href: `mailto:${person.email}` });
    }
    if (person.id != null) {
      links.push({
        label: 'Democracy Club profile',
        href: `https://whocanivotefor.co.uk/person/${encodeURIComponent(person.id)}/`,
      });
    }

    if (!links.length) {
      linksEmpty.hidden = false;
      return;
    }

    linksEmpty.hidden = true;
    linksList.innerHTML = links.map(l =>
      `<li><a href="${esc(l.href)}" rel="noopener" target="_blank">${esc(l.label)}</a></li>`
    ).join('');
  };

  const renderPhoto = (person) => {
    const url = person.thumbnail || person.image;
    if (!url) return;
    photoImg.src = url;
    photoImg.alt = `Photo of ${person.name || 'the candidate'}`;
    photoWrap.hidden = false;
  };

  const renderStatement = (person) => {
    // DC's YNR returns text personal statements on the person record,
    // but mostly only for parliamentary candidates. Display when present.
    const text = person.statement_to_voters || person.biography || '';
    if (!text || !text.trim()) return;
    statementEl.textContent = text.trim();
    statementSrcEl.textContent = "Source: Democracy Club — candidate's own statement.";
    statementSec.hidden = false;
  };

  const renderHistory = (person, currentBpi) => {
    // YNR's person record uses `candidacies`. Each entry has a minimal
    // `ballot` object with just the URL and ballot_paper_id — so we parse
    // date + post out of the ID. Format: type.council.ward.YYYY-MM-DD or
    // parl.constituency.YYYY-MM-DD for parliamentary.
    const entries = person.memberships || person.candidacies || [];
    const pretty = (slug) => (slug || '')
      .replace(/-/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .replace(/\bAnd\b/g, 'and')
      .replace(/\bOf\b/g, 'of')
      .replace(/\bThe\b/g, 'the');

    const past = entries
      .map(m => {
        const bpi = (m.ballot && (m.ballot.ballot_paper_id || m.ballot.ballot_paper)) || '';
        const dateMatch = bpi.match(/(\d{4}-\d{2}-\d{2})$/);
        const date = dateMatch ? dateMatch[1] : '';
        const party = (m.party && m.party.name) || m.party_name || 'Unknown party';
        // post: middle segment(s) of the ballot_paper_id
        const parts = bpi.split('.');
        let post = '';
        if (parts.length >= 4 && parts[0] === 'local') {
          post = pretty(parts.slice(2, -1).join('-'));
        } else if (parts.length >= 3 && parts[0] === 'parl') {
          post = pretty(parts.slice(1, -1).join('-'));
        } else if (parts.length >= 3) {
          post = pretty(parts.slice(1, -1).join('-'));
        }
        const elected = m.elected;
        const deselected = !!m.deselected;
        const yr = date ? date.slice(0, 4) : '????';
        let result = 'Result not recorded';
        if (deselected) result = 'Withdrew';
        else if (elected === true) result = 'Elected';
        else if (elected === false) result = 'Not elected';
        return { yr, date, bpi, party, post, result };
      })
      // Drop the current-election row and any future rows that share the date
      .filter(m => m.bpi !== currentBpi && m.date !== ELECTION_DATE && m.date);

    past.sort((a, b) => b.date.localeCompare(a.date));

    if (!past.length) {
      historyEmpty.hidden = false;
      return;
    }

    historyEmpty.hidden = true;
    historyList.innerHTML = past.map(p => `
      <li>
        <span class="history-year">${esc(p.yr)}</span>
        <span class="history-post">${esc(p.post || '')}</span>
        <span class="history-party">${esc(p.party)}</span>
        <span class="history-result history-result--${p.result === 'Elected' ? 'won' : (p.result === 'Not elected' ? 'lost' : 'other')}">
          ${esc(p.result)}
        </span>
      </li>`).join('');
  };

  // ---------- Main ----------
  const init = async () => {
    const params = new URLSearchParams(location.search);
    const id = (params.get('id') || '').trim();

    if (!id || !/^\d+$/.test(id)) {
      showStatus('');
      nameEl.textContent = 'No candidate selected';
      kickerEl.innerHTML = `Use a link from <a href="all.html">the browse page</a> or <a href="./">a postcode lookup</a>.`;
      return;
    }

    showStatus('Looking up candidate…');

    // Step 1: find the candidate via our local index
    const index = await loadCandidatesIndex();
    if (!index) {
      showStatus("Couldn't load the candidate index. Try again shortly.");
      return;
    }
    const slugOrSlugs = (index.candidates || {})[id];
    if (!slugOrSlugs) {
      nameEl.textContent = 'Candidate not found';
      kickerEl.innerHTML = `No candidate with ID ${esc(id)} is standing on 7 May 2026. <a href="all.html">Browse all</a>.`;
      showStatus('');
      return;
    }
    const slug = Array.isArray(slugOrSlugs) ? slugOrSlugs[0] : slugOrSlugs;

    const council = await loadCouncil(slug);
    if (!council) {
      showStatus(`Couldn't load council data for ${slug}.`);
      return;
    }

    let candidate = null;
    let ward = null;
    for (const w of council.wards || []) {
      for (const c of w.candidates || []) {
        if (String(c.person_id) === String(id)) {
          candidate = c;
          ward = w;
          break;
        }
      }
      if (candidate) break;
    }

    if (!candidate || !ward) {
      showStatus('');
      nameEl.textContent = 'Candidate not found';
      kickerEl.textContent = 'Their record may have been withdrawn since the last data refresh.';
      return;
    }

    renderBasics(candidate, council, ward);
    renderOtherCandidates(candidate, ward);
    renderPartyContext(candidate.party_name);

    // Step 2: live-enrich from YNR
    showStatus('Fetching up-to-date details from Democracy Club…');
    const person = await fetchYnrPerson(id);
    showStatus('');
    if (!person) {
      // Leave the basic render in place; flag the WCIVF fallback link.
      linksEmpty.hidden = false;
      return;
    }

    // Use the freshest name if YNR has it
    if (person.name && person.name !== candidate.name) {
      nameEl.textContent = person.name;
      document.title = `${person.name} · Your Ballot`;
    }

    renderPhoto(person);
    renderStatement(person);
    renderLinksFromYnr(person);
    renderHistory(person, candidate.ballot_paper_id);
  };

  init();
})();
