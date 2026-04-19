/* ============================================================
   Your Ballot — parties.js
   ------------------------------------------------------------
   Browse every party standing a candidate on 7 May 2026.

   Flow:
     1. Fetch data/parties-index.json (tiny: ~20 parties)
     2. Render sorted by candidate count, with colour swatch
     3. Client-side search filters by party name substring
     4. Clicking a row lazy-loads data/parties-candidates/<key>.json
        and renders the full candidate list grouped by council
   ============================================================ */

(() => {
  'use strict';

  // ---------- DOM refs ----------
  const searchInput = document.getElementById('party-search');
  const listEl      = document.getElementById('party-list');
  const statusEl    = document.getElementById('parties-status');
  const summaryEl   = document.getElementById('parties-summary');
  const noMatchEl   = document.getElementById('no-match');

  // ---------- State ----------
  let parties = [];
  const partyCache = new Map();
  const expanded = new Set();
  let currentQuery = '';

  // ---------- Helpers ----------
  const esc = (s) => String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

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

  // ---------- Rendering ----------
  const setSummary = (n, total) => {
    if (n === total) {
      summaryEl.textContent = `${total.toLocaleString()} parties standing candidates on 7 May 2026.`;
    } else {
      summaryEl.textContent = `Showing ${n.toLocaleString()} of ${total.toLocaleString()} parties.`;
    }
  };

  const renderParties = (list) => {
    if (!list.length) {
      listEl.innerHTML = '';
      noMatchEl.hidden = false;
      return;
    }
    noMatchEl.hidden = true;

    listEl.innerHTML = list.map(p => {
      const isOpen = expanded.has(p.key);
      const colour = COLOURS[p.key] || COLOURS.other;
      const candLabel = p.candidate_count === 1 ? 'candidate' : 'candidates';
      const councilLabel = p.council_count === 1 ? 'council' : 'councils';
      return `
        <article class="council-row party-row ${isOpen ? 'is-open' : ''}" data-key="${esc(p.key)}">
          <button class="council-toggle" type="button" aria-expanded="${isOpen}" aria-controls="party-${esc(p.key)}">
            <span class="council-name">
              <span class="party-card-swatch" style="background:${colour}"></span>
              ${esc(p.display_name)}
            </span>
            <span class="council-meta">
              ${p.candidate_count.toLocaleString()} ${candLabel} &middot; ${p.council_count} ${councilLabel}
            </span>
            <span class="council-chevron" aria-hidden="true">▸</span>
          </button>
          <div class="council-wards party-detail" id="party-${esc(p.key)}" hidden></div>
        </article>
      `;
    }).join('');

    listEl.querySelectorAll('.council-toggle').forEach(btn => {
      btn.addEventListener('click', onToggleClick);
    });

    for (const key of expanded) {
      const row = listEl.querySelector(`.council-row[data-key="${CSS.escape(key)}"]`);
      if (row) {
        const detail = partyCache.get(key);
        if (detail) renderCandidates(row, detail);
      }
    }
  };

  // Group candidates by council for clearer display
  const groupByCouncil = (candidates) => {
    const groups = new Map();
    for (const c of candidates) {
      const slug = c.council_slug;
      if (!groups.has(slug)) {
        groups.set(slug, { council_slug: slug, council_name: c.council_name, candidates: [] });
      }
      groups.get(slug).candidates.push(c);
    }
    return Array.from(groups.values()).sort((a, b) =>
      (a.council_name || '').localeCompare(b.council_name || '')
    );
  };

  const renderCandidates = (row, detail) => {
    const container = row.querySelector('.party-detail');
    if (!container) return;
    container.hidden = false;

    const candidates = detail.candidates || [];
    if (!candidates.length) {
      container.innerHTML = `<p class="status-msg">No candidates found.</p>`;
      return;
    }

    const groups = groupByCouncil(candidates);
    container.innerHTML = groups.map(g => {
      const items = g.candidates.map(c => {
        // Profile link goes to our own candidate page, not the external WCIVF
        const profile = c.person_id ? `candidate.html?id=${encodeURIComponent(c.person_id)}` : null;
        const nameHtml = c.person_id
          ? `<a href="candidate.html?id=${encodeURIComponent(c.person_id)}">${esc(c.name)}</a>`
          : esc(c.name);
        return `
          <li class="candidate-item">
            <span class="candidate-item-name">${nameHtml}</span>
            <span class="candidate-item-party">${esc(c.ward_name || '')}</span>
            ${profile ? `<a class="candidate-item-link" href="${esc(profile)}">Profile →</a>` : ''}
          </li>
        `;
      }).join('');
      return `
        <section class="ward">
          <header class="ward-head">
            <h3 class="ward-name">${esc(g.council_name)}</h3>
            <p class="ward-meta">${g.candidates.length} candidate${g.candidates.length === 1 ? '' : 's'}</p>
          </header>
          <ul class="candidate-list">${items}</ul>
        </section>
      `;
    }).join('');
  };

  const fetchPartyDetail = async (key) => {
    if (partyCache.has(key)) return partyCache.get(key);
    try {
      const res = await fetch(`data/parties-candidates/${encodeURIComponent(key)}.json`, { cache: 'default' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      partyCache.set(key, data);
      return data;
    } catch (e) {
      console.error('Failed to load party detail', key, e);
      return null;
    }
  };

  const onToggleClick = async (e) => {
    const btn = e.currentTarget;
    const row = btn.closest('.council-row');
    if (!row) return;
    const key = row.dataset.key;
    const isOpen = expanded.has(key);

    if (isOpen) {
      expanded.delete(key);
      row.classList.remove('is-open');
      btn.setAttribute('aria-expanded', 'false');
      const container = row.querySelector('.party-detail');
      if (container) container.hidden = true;
      return;
    }

    expanded.add(key);
    row.classList.add('is-open');
    btn.setAttribute('aria-expanded', 'true');
    const container = row.querySelector('.party-detail');
    if (container) {
      container.hidden = false;
      if (!partyCache.has(key)) {
        container.innerHTML = `<p class="status-msg">Loading candidates…</p>`;
      }
    }
    const detail = await fetchPartyDetail(key);
    if (!detail) {
      if (container) {
        container.innerHTML = `<p class="status-msg">Could not load candidate data. Please try again.</p>`;
      }
      return;
    }
    renderCandidates(row, detail);
  };

  // ---------- Search ----------
  const applyFilter = () => {
    const q = (searchInput.value || '').toLowerCase().trim();
    currentQuery = q;
    if (!q) {
      renderParties(parties);
      setSummary(parties.length, parties.length);
      return;
    }
    const filtered = parties.filter(p => (p.display_name || '').toLowerCase().includes(q));
    renderParties(filtered);
    setSummary(filtered.length, parties.length);
  };

  // ---------- Boot ----------
  const init = async () => {
    try {
      const res = await fetch('data/parties-index.json', { cache: 'default' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      parties = data.parties || [];

      const meta = data._meta || {};
      const tag = document.getElementById('parties-tagline');
      if (tag && meta.party_count) {
        tag.textContent =
          `${meta.party_count.toLocaleString()} parties, ` +
          `${(meta.candidate_count || 0).toLocaleString()} candidacies on Thursday 7 May 2026. ` +
          `Click a party to see their candidates by council.`;
      }

      setSummary(parties.length, parties.length);
      renderParties(parties);
    } catch (e) {
      statusEl.innerHTML = `
        <p class="status-msg">
          Couldn't load the parties list yet.
          The nightly data refresh may not have run — try again shortly, or
          <a href="./">use the postcode lookup</a> in the meantime.
        </p>`;
      console.error('Failed to load parties-index', e);
      summaryEl.textContent = '';
    }
  };

  searchInput.addEventListener('input', applyFilter);
  init();
})();
