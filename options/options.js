'use strict';

// ── DOM ─────────────────────────────────────────────────────────────────
const tabDomainsEl  = document.getElementById('tabDomains');
const siteInput     = document.getElementById('siteInput');
const addBtn        = document.getElementById('addBtn');
const sitesList     = document.getElementById('sitesList');
const emptyState    = document.getElementById('emptyState');
const siteCount     = document.getElementById('siteCount');
const actionsBar    = document.getElementById('actionsBar');
const resetBtn      = document.getElementById('resetBtn');
const saveBtn       = document.getElementById('saveBtn');
const headerStatus  = document.getElementById('headerStatus');
const toastEl       = document.getElementById('toast');
const editModal     = document.getElementById('editModal');
const editInput     = document.getElementById('editInput');
const editCancelBtn = document.getElementById('editCancel');
const editSaveBtn   = document.getElementById('editSave');
const tagsWrapper   = document.getElementById('tagsInputWrapper');

// ── State ───────────────────────────────────────────────────────────────
let savedSites   = [];
let workingSites = [];
let editingIndex = -1;

// ── Direct storage access (no messaging — works even if bg is asleep) ──
async function loadFromStorage() {
  const data = await browser.storage.local.get('blockedSites');
  const raw = data.blockedSites || [];
  // Extract patterns, handle both formats
  return raw.map(r => typeof r === 'string' ? r : r.pattern);
}

async function saveToStorage(patterns) {
  // Load existing to preserve addedAt timestamps
  const data = await browser.storage.local.get('blockedSites');
  const existing = data.blockedSites || [];
  const existingMap = new Map();
  for (const r of existing) {
    if (typeof r === 'string') {
      existingMap.set(r, Date.now());
    } else {
      existingMap.set(r.pattern, r.addedAt);
    }
  }

  const rules = patterns.map(p => ({
    pattern: p,
    addedAt: existingMap.get(p) || Date.now()
  }));

  await browser.storage.local.set({ blockedSites: rules });
}

async function getOpenTabDomains() {
  try {
    const tabs = await browser.tabs.query({});
    const domains = new Set();
    for (const tab of tabs) {
      try {
        if (tab.url && !tab.url.startsWith('about:') && !tab.url.startsWith('moz-extension:')) {
          domains.add(new URL(tab.url).hostname);
        }
      } catch(e) {}
    }
    return Array.from(domains).sort();
  } catch(e) {
    return [];
  }
}

// ── Init ────────────────────────────────────────────────────────────────
(async () => {
  savedSites = await loadFromStorage();
  workingSites = [...savedSites];
  renderSites();
  await renderTabDomains();
})();

// Also refresh when storage changes externally (e.g. toolbar button clicked)
browser.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.blockedSites) {
    const raw = changes.blockedSites.newValue || [];
    const patterns = raw.map(r => typeof r === 'string' ? r : r.pattern);
    savedSites = patterns;
    // Only update working if user has no unsaved changes
    if (!isDirty()) {
      workingSites = [...savedSites];
      renderSites();
    }
    renderTabDomains();
  }
});

// ── Tab domain tags ─────────────────────────────────────────────────────
async function renderTabDomains() {
  const domains = await getOpenTabDomains();
  tabDomainsEl.innerHTML = '';

  // Filter out empty / localhost-like if desired
  const filtered = domains.filter(d => d && d !== 'localhost' && !d.startsWith('127.'));

  for (const domain of filtered) {
    const blocked = workingSites.includes(domain);
    const tag = document.createElement('span');
    tag.className = 'tag' + (blocked ? ' is-blocked' : '');
    tag.innerHTML = `<span class="tag-icon">${blocked ? '✕' : '+'}</span>${esc(domain)}`;
    tag.title = blocked ? `Remove "${domain}" from blocklist` : `Block "${domain}"`;
    tag.addEventListener('click', () => toggleDomain(domain));
    tabDomainsEl.appendChild(tag);
  }
}

function toggleDomain(domain) {
  const idx = workingSites.indexOf(domain);
  if (idx !== -1) {
    workingSites.splice(idx, 1);
  } else {
    workingSites.push(domain);
  }
  renderSites();
  renderTabDomains();
  checkDirty();
}

// ── Add ─────────────────────────────────────────────────────────────────
function addSite(value) {
  value = value.trim();
  if (!value) return;

  if (workingSites.includes(value)) {
    showToast('Already in the list');
    return;
  }

  if (value.startsWith('/') && value.endsWith('/')) {
    try {
      new RegExp(value.slice(1, -1));
    } catch(e) {
      showToast('Invalid regex: ' + e.message);
      return;
    }
  }

  workingSites.push(value);
  siteInput.value = '';
  renderSites();
  renderTabDomains();
  checkDirty();

  // Scroll to bottom of list
  requestAnimationFrame(() => {
    const rows = sitesList.querySelectorAll('.site-row');
    if (rows.length) rows[rows.length - 1].scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });
}

addBtn.addEventListener('click', () => addSite(siteInput.value));

siteInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    addSite(siteInput.value);
  }
});

tagsWrapper.addEventListener('click', (e) => {
  if (e.target === tagsWrapper) siteInput.focus();
});

// ── Render sites ────────────────────────────────────────────────────────
function renderSites() {
  sitesList.innerHTML = '';
  siteCount.textContent = workingSites.length;

  if (workingSites.length === 0) {
    emptyState.style.display = 'flex';
    sitesList.style.display = 'none';
    return;
  }

  emptyState.style.display = 'none';
  sitesList.style.display = 'flex';

  workingSites.forEach((site, index) => {
    const isRegex = site.startsWith('/') && site.endsWith('/');

    const row = document.createElement('div');
    row.className = 'site-row';
    row.innerHTML = `
      <div class="site-info">
        <span class="site-type ${isRegex ? 'regex' : 'domain'}">
          ${isRegex ? 'regex' : 'domain'}
        </span>
        <span class="site-pattern" title="${esc(site)}">${esc(site)}</span>
      </div>
      <span class="site-actions">
        <button class="btn-icon edit" title="Edit">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
          </svg>
        </button>
        <button class="btn-icon delete" title="Delete">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="18" y1="6" x2="6" y2="18"/>
            <line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </span>
    `;

    row.querySelector('.edit').addEventListener('click', () => openEdit(index));
    row.querySelector('.delete').addEventListener('click', () => {
      row.classList.add('removing');
      setTimeout(() => {
        workingSites.splice(index, 1);
        renderSites();
        renderTabDomains();
        checkDirty();
      }, 200);
    });

    sitesList.appendChild(row);
  });
}

// ── Edit modal ──────────────────────────────────────────────────────────
function openEdit(index) {
  editingIndex = index;
  editInput.value = workingSites[index];
  editModal.classList.add('open');
  requestAnimationFrame(() => {
    editInput.focus();
    editInput.select();
  });
}

function closeEdit() {
  editModal.classList.remove('open');
  editingIndex = -1;
}

editCancelBtn.addEventListener('click', closeEdit);
editModal.addEventListener('click', (e) => {
  if (e.target === editModal) closeEdit();
});

editSaveBtn.addEventListener('click', () => {
  const val = editInput.value.trim();
  if (!val) return;
  if (val.startsWith('/') && val.endsWith('/')) {
    try { new RegExp(val.slice(1, -1)); } catch(e) {
      showToast('Invalid regex: ' + e.message);
      return;
    }
  }
  // Check duplicate (not self)
  if (workingSites.includes(val) && workingSites.indexOf(val) !== editingIndex) {
    showToast('Already in the list');
    return;
  }
  workingSites[editingIndex] = val;
  closeEdit();
  renderSites();
  renderTabDomains();
  checkDirty();
});

editInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); editSaveBtn.click(); }
  if (e.key === 'Escape') closeEdit();
});

// ── Dirty detection ─────────────────────────────────────────────────────
function isDirty() {
  if (workingSites.length !== savedSites.length) return true;
  return workingSites.some((s, i) => s !== savedSites[i]);
}

function checkDirty() {
  actionsBar.classList.toggle('visible', isDirty());
}

// ── Save / Reset ────────────────────────────────────────────────────────
resetBtn.addEventListener('click', () => {
  workingSites = [...savedSites];
  renderSites();
  renderTabDomains();
  checkDirty();
  showToast('Changes discarded');
});

saveBtn.addEventListener('click', async () => {
  try {
    await saveToStorage(workingSites);
    savedSites = [...workingSites];
    checkDirty();
    showHeaderSaved();
    showToast('✓ Saved successfully');
  } catch(e) {
    showToast('Error saving: ' + e.message);
  }
});

function showHeaderSaved() {
  headerStatus.textContent = '✓ Saved';
  headerStatus.className = 'header-status saved';
  setTimeout(() => {
    headerStatus.className = 'header-status';
  }, 2500);
}

// ── Toast ───────────────────────────────────────────────────────────────
let toastTimer;
function showToast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2800);
}

// ── Util ────────────────────────────────────────────────────────────────
function esc(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}