/* ============================================================
   Your Ballot — all.js
   ------------------------------------------------------------
   Browse every council with an election on 7 May 2026.

   Flow:
     1. Fetch data/elections-index.json (small: ~150 councils)
     2. Render the full list, one row per council
     3. Client-side search filters by council name substring
     4. Clicking a row lazy-loads data/councils/<slug>.json
        and expands inline to show wards + candidates
   ============================================================ */

(() => {
  'use strict';

  // ---------- DOM refs ----------
  const searchInput = document.getElementById('council-search');
  const listEl      = document.getElementById('council-list');
  const statusEl    = document.getElementById('all-status');
  const summaryEl   = document.getElementById('all-summary');
  const noMatchEl   = document.getElementById('no-match');

  // ---------- State ----------
  let councils = [];                // full index, from elections-index.json
  const councilCache = new Map();   // slug -> { wards: [...] }
  const expanded = new Set();       // slugs currently expanded

  // ---------- Helpers ----------
  const esc = (s) => String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const slugify = (s) => (s || '')
    .toLowerCase()
    .replace(/['\u2019.]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  const normaliseSearch = (s) => (s || '').toLowerCase().trim();

  // Party name -> canonical key (subset match, same rules as app.js)
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

  // ---------- Rendering ----------
  const setSummary = (n, total) => {
    if (n === total) {
      summaryEl.textContent = `${total.toLocaleString()} councils with an election on 7 May 2026.`;
    } else {
      summaryEl.textContent = `Showing ${n.toLocaleString()} of ${total.toLocaleString()} councils.`;
    }
  };

  const renderCouncils = (list) => {
    if (!list.length) {
      listEl.innerHTML = '';
      noMatchEl.hidden = false;
      return;
    }
    noMatchEl.hidden = true;

    listEl.innerHTML = list.map(c => {
      const isOpen = expanded.has(c.slug);
      const seatLabel = c.seat_count === 1 ? 'seat' : 'seats';
      const wardLabel = c.ward_count === 1 ? 'ward' : 'wards';
      const candLabel = c.candidate_count === 1 ? 'candidate' : 'candidates';
      return `
        <article class="council-row ${isOpen ? 'is-open' : ''}" data-slug="${esc(c.slug)}">
          <button class="council-toggle" type="button" aria-expanded="${isOpen}" aria-controls="wards-${esc(c.slug)}">
            <span class="council-name">${esc(c.name)}</span>
            <span class="council-meta">
              ${c.ward_count} ${wardLabel} &middot; ${c.seat_count} ${seatLabel} &middot; ${c.candidate_count} ${candLabel}
            </span>
            <span class="council-chevron" aria-hidden="true">▸</span>
          </button>
          <div class="council-wards" id="wards-${esc(c.slug)}" hidden></div>
        </article>
      `;
    }).join('');

    // Re-bind click handlers
    listEl.querySelectorAll('.council-toggle').forEach(btn => {
      btn.addEventListener('click', onToggleClick);
    });

    // If anything was previously expanded and is still visible, re-render its detail
    for (const slug of expanded) {
      const row = listEl.querySelector(`.council-row[data-slug="${CSS.escape(slug)}"]`);
      if (row) {
        const detail = councilCache.get(slug);
        if (detail) renderWards(row, detail);
      }
    }
  };

  const renderWards = (row, detail) => {
    const container = row.querySelector('.council-wards');
    if (!container) return;
    container.hidden = false;

    const wards = detail.wards || [];
    if (!wards.length) {
      container.innerHTML = `<p class="status-msg">No published wards for this council yet.</p>`;
      return;
    }

    container.innerHTML = wards.map(w => {
      const seatLabel = w.seats_contested === 1 ? '1 seat' : `${w.seats_contested} seats`;
      const nCands = (w.candidates || []).length;
      const candLabel = nCands === 1 ? '1 candidate' : `${nCands} candidates`;
      const candidates = (w.candidates || []).map(c => {
        const colour = COLOURS[partyKey(c.party_name)] || COLOURS.other;
        const profile = c.person_id ? `https://whocanivotefor.co.uk/person/${c.person_id}/` : null;
        return `
          <li class="candidate-item">
            <span class="candidate-item-name">${esc(c.name)}</span>
            <span class="candidate-item-party">
              <span class="party-swatch" style="background:${colour}"></span>
              ${esc(c.party_name)}
            </span>
            ${profile ? `<a class="candidate-item-link" href="${esc(profile)}" rel="noopener" target="_blank">Full profile →</a>` : ''}
          </li>
        `;
      }).join('');
      return `
        <section class="ward">
          <header class="ward-head">
            <h3 class="ward-name">${esc(w.ward_name)}</h3>
            <p class="ward-meta">${seatLabel} &middot; ${candLabel}</p>
          </header>
          <ul class="candidate-list">${candidates}</ul>
        </section>
      `;
    }).join('');
  };

  const fetchCouncilDetail = async (slug) => {
    if (councilCache.has(slug)) return councilCache.get(slug);
    const url = `data/councils/${encodeURIComponent(slug)}.json`;
    try {
      const res = await fetch(url, { cache: 'default' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      councilCache.set(slug, data);
      return data;
    } catch (e) {
      console.error('Failed to load council detail', slug, e);
      return null;
    }
  };

  const onToggleClick = async (e) => {
    const btn = e.currentTarget;
    const row = btn.closest('.council-row');
    if (!row) return;
    const slug = row.dataset.slug;
    const isOpen = expanded.has(slug);

    if (isOpen) {
      expanded.delete(slug);
      row.classList.remove('is-open');
      btn.setAttribute('aria-expanded', 'false');
      const container = row.querySelector('.council-wards');
      if (container) container.hidden = true;
      return;
    }

    // Opening — lazy-load if needed
    expanded.add(slug);
    row.classList.add('is-open');
    btn.setAttribute('aria-expanded', 'true');
    const container = row.querySelector('.council-wards');
    if (container) {
      container.hidden = false;
      if (!councilCache.has(slug)) {
        container.innerHTML = `<p class="status-msg">Loading wards and candidates…</p>`;
      }
    }
    const detail = await fetchCouncilDetail(slug);
    if (!detail) {
      if (container) {
        container.innerHTML = `<p class="status-msg">Could not load council data. Please try again.</p>`;
      }
      return;
    }
    renderWards(row, detail);
  };

  // ---------- Search ----------
  const applyFilter = () => {
    const q = normaliseSearch(searchInput.value);
    if (!q) {
      renderCouncils(councils);
      setSummary(councils.length, councils.length);
      return;
    }
    const qSlug = slugify(q);
    const filtered = councils.filter(c => {
      const name = (c.name || '').toLowerCase();
      return name.includes(q) || c.slug.includes(qSlug);
    });
    renderCouncils(filtered);
    setSummary(filtered.length, councils.length);
  };

  // ---------- Boot ----------
  const init = async () => {
    try {
      const res = await fetch('data/elections-index.json', { cache: 'default' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      councils = data.councils || [];

      // Update tagline with the live totals
      const meta = data._meta || {};
      const tag = document.getElementById('all-tagline');
      if (tag && meta.council_count) {
        tag.textContent =
          `${meta.council_count.toLocaleString()} councils, ` +
          `${(meta.ward_count || 0).toLocaleString()} wards, ` +
          `${(meta.candidate_count || 0).toLocaleString()} candidates standing on Thursday 7 May 2026. ` +
          `Click a council to see who's standing where.`;
      }

      setSummary(councils.length, councils.length);
      renderCouncils(councils);
    } catch (e) {
      statusEl.innerHTML = `
        <p class="status-msg">
          Couldn't load the council list yet.
          The nightly enrichment may not have run — try again shortly, or
          <a href="./">use the postcode lookup</a> in the meantime.
        </p>`;
      console.error('Failed to load elections-index', e);
      summaryEl.textContent = '';
    }
  };

  searchInput.addEventListener('input', applyFilter);
  init();
})();
