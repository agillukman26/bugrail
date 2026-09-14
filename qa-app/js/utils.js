/* ==========================================================
   utils.js — shared helpers used across all modules.
   Kept framework-free and dependency-free so it can be reused
   if this app is ever wired up to a real backend later:
   just swap the Storage.* implementations for API calls.
   ========================================================== */

const STORAGE_KEYS = {
  TESTCASES: 'qa_testcases',
  BUGS: 'qa_bugs',
  FILES: 'qa_files', // Test Case grouping ("file"/folder)
  SETTINGS: 'qa_settings',
  COUNTERS: 'qa_counters',
  TRASH: 'qa_trash' // holds last deleted item(s) for Undo
};

/* ---------- MySQL-backed storage (via server/), with a localStorage
   fallback so the app still works (e.g. for an offline demo/presentation)
   when the API server is off ----------
   Data lives in the `kv_store` table on the API in server/, one JSON blob
   per key — same shape this app used to keep in localStorage.
   `hydrate()` loads every key once into `cache` on app boot (awaited
   before Auth.init() runs — see auth.js): tries the API first, and if
   that fails, falls back to whatever's in localStorage (last known-good
   data — e.g. dummy data made in an earlier offline session). After
   hydrate, get()/set() stay perfectly synchronous against `cache` (so the
   rest of the app never has to become async). set() always writes
   localStorage immediately (so data survives a reload even with the
   server off) and fires the same write to MySQL in the background
   best-effort. */
const API_BASE = location.hostname === 'localhost' || location.hostname === '127.0.0.1'
  ? 'http://localhost:3001/api'
  : 'https://bugrail-api-production.up.railway.app/api';

const Storage = {
  cache: {},
  serverOnline: true,

  async hydrate(){
    try{
      const res = await fetch(`${API_BASE}/kv`, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.cache = await res.json();
      this.serverOnline = true;
    }catch(e){
      console.error('Storage.hydrate: API unreachable, falling back to localStorage', e);
      this.serverOnline = false;
      this.cache = {};
      Object.values(STORAGE_KEYS).forEach(key => {
        try{
          const raw = localStorage.getItem(key);
          if (raw) this.cache[key] = JSON.parse(raw);
        }catch(err){ console.error('Storage.hydrate: bad localStorage value', key, err); }
      });
      Toast.show('Server database tidak terhubung — memakai data lokal (offline).', 'info');
    }
  },

  get(key, fallback){
    const value = this.cache[key];
    return value === undefined || value === null ? fallback : value;
  },

  set(key, value){
    this.cache[key] = value;
    try{ localStorage.setItem(key, JSON.stringify(value)); }catch(e){ console.error('Storage.set: localStorage write failed', key, e); }
    fetch(`${API_BASE}/kv/${key}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value })
    }).then(() => { this.serverOnline = true; })
      .catch(e => {
        if (this.serverOnline) Toast.show('Server database tidak terhubung, data disimpan lokal saja.', 'info');
        this.serverOnline = false;
        console.error('Storage.set: MySQL sync failed, kept in localStorage', key, e);
      });
    return true;
  }
};

/* ---------- Auto-increment ID generator (TC-0001 / BUG-0001) ---------- */
const IdGen = {
  next(prefix){
    const counters = Storage.get(STORAGE_KEYS.COUNTERS, {});
    const current = (counters[prefix] || 0) + 1;
    counters[prefix] = current;
    Storage.set(STORAGE_KEYS.COUNTERS, counters);
    return `${prefix}-${String(current).padStart(4, '0')}`;
  },
  // Keeps counters in sync with imported data so new IDs never collide.
  syncFromExisting(prefix, existingIds){
    const counters = Storage.get(STORAGE_KEYS.COUNTERS, {});
    let max = counters[prefix] || 0;
    existingIds.forEach(id => {
      const m = String(id).match(new RegExp(`^${prefix}-(\\d+)$`));
      if (m) max = Math.max(max, parseInt(m[1], 10));
    });
    counters[prefix] = max;
    Storage.set(STORAGE_KEYS.COUNTERS, counters);
  },
  // Test Case IDs use a per-module prefix (e.g. LOG-0001), so sync each
  // distinct prefix found in existing IDs instead of one fixed prefix.
  syncAllFromExisting(existingIds){
    const byPrefix = {};
    existingIds.forEach(id => {
      const m = String(id).match(/^([A-Z]+)-(\d+)$/);
      if (!m) return;
      (byPrefix[m[1]] ||= []).push(id);
    });
    Object.keys(byPrefix).forEach(prefix => this.syncFromExisting(prefix, byPrefix[prefix]));
  }
};

/* Abbreviates a Module name into a 3-letter Test Case ID prefix.
   "Login" -> "LOG", "User Management" -> initials "UM" + extra letters -> "UMS". */
function moduleAbbrev(module){
  const words = String(module || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return 'TC';
  const initials = words.map(w => w[0].toUpperCase());
  if (initials.length >= 3) return initials.slice(0, 3).join('');
  const extra = words.flatMap(w => w.slice(1).toUpperCase().split(''));
  return initials.concat(extra).slice(0, 3).join('').padEnd(3, 'X');
}

/* ---------- Toast notifications ---------- */
const Toast = {
  container(){
    let el = document.getElementById('toastStack');
    if(!el){
      el = document.createElement('div');
      el.id = 'toastStack';
      el.className = 'toast-stack';
      document.body.appendChild(el);
    }
    return el;
  },
  show(message, type = 'info', opts = {}){
    const stack = this.container();
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    const icon = { success:'✓', error:'⚠', info:'ℹ' }[type] || 'ℹ';
    toast.innerHTML = `<span>${icon}</span><span>${escapeHtml(message)}</span>`;
    if(opts.undo){
      const undoBtn = document.createElement('span');
      undoBtn.className = 'undo';
      undoBtn.textContent = 'UNDO';
      undoBtn.onclick = () => { opts.undo(); toast.remove(); };
      toast.appendChild(undoBtn);
    }
    stack.appendChild(toast);
    setTimeout(() => {
      toast.style.transition = 'opacity .25s';
      toast.style.opacity = '0';
      setTimeout(() => toast.remove(), 250);
    }, opts.duration || 4000);
  }
};

/* ---------- Confirm dialog (returns a Promise<boolean>) ---------- */
function confirmDialog(title, message, confirmLabel = 'Hapus'){
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay confirm-modal active';
    overlay.innerHTML = `
      <div class="modal">
        <div class="icon-warn">!</div>
        <h2 style="margin:0 0 6px;">${escapeHtml(title)}</h2>
        <p class="text-dim" style="font-size:13px;">${escapeHtml(message)}</p>
        <div class="modal-footer" style="justify-content:center;">
          <button class="btn" id="cancelConfirm">Batal</button>
          <button class="btn danger" id="okConfirm">${escapeHtml(confirmLabel)}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.querySelector('#cancelConfirm').onclick = () => { overlay.remove(); resolve(false); };
    overlay.querySelector('#okConfirm').onclick = () => { overlay.remove(); resolve(true); };
    overlay.addEventListener('click', e => { if(e.target === overlay){ overlay.remove(); resolve(false); } });
  });
}

/* ---------- Prompt dialog (returns a Promise<string|null>) ----------
   Optional `validate(value)` returns an error string to block closing and
   show it inline under the input, or falsy to accept. */
function promptDialog(title, placeholder = '', defaultValue = '', confirmLabel = 'Simpan', validate = null){
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay confirm-modal active';
    overlay.innerHTML = `
      <div class="modal">
        <h2 style="margin:0 0 14px;">${escapeHtml(title)}</h2>
        <div class="field">
          <input type="text" id="promptDialogInput" placeholder="${escapeHtml(placeholder)}" value="${escapeHtml(defaultValue)}">
          <p class="combobox-error" id="promptDialogError" style="display:none;"></p>
        </div>
        <div class="modal-footer" style="justify-content:center;">
          <button class="btn" id="cancelPrompt">Batal</button>
          <button class="btn primary" id="okPrompt">${escapeHtml(confirmLabel)}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const input = overlay.querySelector('#promptDialogInput');
    const errorEl = overlay.querySelector('#promptDialogError');
    input.focus(); input.select();
    const close = (value) => { overlay.remove(); resolve(value); };
    const showError = (msg) => {
      errorEl.textContent = msg;
      errorEl.style.display = 'block';
      input.classList.add('input-invalid');
    };
    const submit = () => {
      const value = input.value.trim() || null;
      if (value && validate){
        const err = validate(value);
        if (err){ showError(err); return; }
      }
      close(value);
    };
    input.addEventListener('input', () => { errorEl.style.display = 'none'; input.classList.remove('input-invalid'); });
    overlay.querySelector('#cancelPrompt').onclick = () => close(null);
    overlay.querySelector('#okPrompt').onclick = submit;
    input.addEventListener('keydown', e => { if (e.key === 'Enter'){ e.preventDefault(); submit(); } });
    overlay.addEventListener('click', e => { if (e.target === overlay) close(null); });
  });
}

/* ---------- Small helpers ---------- */
function escapeHtml(str){
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

/* Dev team quality metric: how fast bugs go from reported (Open) to Closed,
   based on the status-change activity log recorded in bugreport.js. Only
   bugs currently Closed with a logged "-> Closed" transition count — bugs
   without activity (imported/seeded data) can't be measured and are skipped. */
function computeBugResolutionStats(bugs){
  const durations = [];
  (bugs || []).forEach(b => {
    if (b.status !== 'Closed' || !b.reportDate) return;
    const closedEntries = (b.activity || []).filter(a => a.to === 'Closed');
    if (!closedEntries.length) return;
    const ms = new Date(closedEntries[closedEntries.length - 1].at) - new Date(b.reportDate);
    if (ms > 0) durations.push(ms);
  });
  const avgHours = durations.length ? (durations.reduce((a, b) => a + b, 0) / durations.length) / 3600000 : 0;
  return { resolvedCount: durations.length, avgHours };
}

function formatDuration(hours){
  if (!hours) return '-';
  if (hours < 24) return `${hours.toFixed(1)} jam`;
  return `${(hours / 24).toFixed(1)} hari`;
}

/* Turns a plain-text "Test Step" cell from an imported Excel/CSV file into the
   HTML the Steps rich-text editor (Quill) expects. If most lines already start
   with a number ("1.", "2)", ...), it becomes a real <ol> so imported steps
   show up numbered without the user having to reformat them by hand. */
function textToStepsHtml(raw){
  const text = String(raw ?? '').trim();
  if (!text) return '';
  if (/<[a-z][\s\S]*>/i.test(text)) return text; // already HTML (e.g. re-imported export)
  const lines = text.split(/\r\n|\r|\n/).map(l => l.trim()).filter(Boolean);
  if (!lines.length) return '';
  const numberedRe = /^\d+[.\)]\s*/;
  const numberedCount = lines.filter(l => numberedRe.test(l)).length;
  if (numberedCount >= Math.ceil(lines.length * 0.6)){
    return '<ol>' + lines.map(l => `<li>${escapeHtml(l.replace(numberedRe, ''))}</li>`).join('') + '</ol>';
  }
  return lines.map(l => `<p>${escapeHtml(l)}</p>`).join('');
}

function stripHtml(html){
  const d = document.createElement('div');
  d.innerHTML = html || '';
  return d.textContent || '';
}

/* Reverse of textToStepsHtml — for export. Plain stripHtml() drops <ol>/<ul>
   numbering (textContent has no idea it was a list), so a numbered Steps
   field would export blank of numbers. Walk top-level <li>/<p>/<br> blocks
   and re-number them as plain text lines instead. */
function stepsHtmlToText(html){
  if (!html) return '';
  const d = document.createElement('div');
  d.innerHTML = html;
  const lists = d.querySelectorAll('ol, ul');
  lists.forEach(list => {
    const ordered = list.tagName === 'OL';
    [...list.children].forEach((li, i) => {
      li.textContent = `${ordered ? `${i + 1}. ` : '- '}${li.textContent}`;
    });
  });
  [...d.querySelectorAll('p, li, br')].forEach(el => el.after(document.createTextNode('\n')));
  return (d.textContent || '').replace(/\n{2,}/g, '\n').trim();
}

/* Heuristic ID/EN detection via common stopword counting — good enough to
   pick a translate direction without a paid language-detection API. */
const ID_STOPWORDS = ['yang','dan','atau','tidak','untuk','dengan','adalah','ini','itu','pada','akan','dari','ke','di','sudah','belum','harus','bisa','dapat','maka'];
const EN_STOPWORDS = ['the','and','or','not','for','with','is','are','this','that','on','will','from','to','in','already','must','can','should','then'];
function detectLang(text){
  const words = String(text || '').toLowerCase().split(/\W+/).filter(Boolean);
  let idScore = 0, enScore = 0;
  words.forEach(w => { if (ID_STOPWORDS.includes(w)) idScore++; if (EN_STOPWORDS.includes(w)) enScore++; });
  return enScore > idScore ? 'en' : 'id';
}

/* Row action kebab menu: wraps a list of `<button data-...>` action items
   (rendered exactly as before) behind a single "⋮" toggle so dense action
   columns (Bug Report, Master Status, User Management, Role Permission,
   Workspace) don't show every action inline. */
function actionMenu(itemsHtml){
  return `<div class="action-menu">
    <button type="button" class="action-menu-btn" title="Aksi">⋮</button>
    <div class="action-menu-list">${itemsHtml}</div>
  </div>`;
}

function positionActionMenu(menu){
  const btn = menu.querySelector('.action-menu-btn');
  const list = menu.querySelector('.action-menu-list');
  const r = btn.getBoundingClientRect();
  list.style.top = `${r.bottom + 4}px`;
  list.style.left = 'auto';
  list.style.right = `${window.innerWidth - r.right}px`;
  const listRect = list.getBoundingClientRect();
  if (listRect.bottom > window.innerHeight){
    list.style.top = `${r.top - listRect.height - 4}px`;
  }
}

document.addEventListener('click', e => {
  const btn = e.target.closest('.action-menu-btn');
  document.querySelectorAll('.action-menu.open').forEach(m => {
    if (!btn || m !== btn.closest('.action-menu')) m.classList.remove('open');
  });
  if (btn){
    const menu = btn.closest('.action-menu');
    const wasOpen = menu.classList.contains('open');
    menu.classList.toggle('open');
    if (!wasOpen) positionActionMenu(menu);
  } else if (e.target.closest('.action-menu-list')) {
    document.querySelectorAll('.action-menu.open').forEach(m => m.classList.remove('open'));
  }
});
window.addEventListener('scroll', () => {
  document.querySelectorAll('.action-menu.open').forEach(m => m.classList.remove('open'));
}, true);

async function translateText(text, langpair){
  const trimmed = String(text || '').trim();
  if (!trimmed) return '';
  const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(trimmed)}&langpair=${langpair}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('Translate API error');
  const data = await res.json();
  return data?.responseData?.translatedText || trimmed;
}

function debounce(fn, wait = 250){
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), wait); };
}

function formatDate(iso){
  if(!iso) return '-';
  const d = new Date(iso);
  if(isNaN(d)) return iso;
  return d.toLocaleDateString('id-ID', { day:'2-digit', month:'short', year:'numeric' });
}

function formatDateTime(iso){
  if(!iso) return '-';
  const d = new Date(iso);
  if(isNaN(d)) return iso;
  return d.toLocaleString('id-ID', { day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' });
}

function todayISO(){ return new Date().toISOString().slice(0,10); }

function nowISO(){ return new Date().toISOString(); }

function downloadBlob(content, filename, mime){
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

/* Convert an array of objects to CSV text (handles quoting/commas). */
function arrayToCSV(rows, columns){
  const header = columns.map(c => c.label).join(',');
  const lines = rows.map(row => columns.map(c => {
    let v = row[c.key];
    if (v === null || v === undefined) v = '';
    v = String(v).replace(/"/g,'""');
    return `"${v}"`;
  }).join(','));
  return [header, ...lines].join('\r\n');
}

/* Simple highlight for realtime search matches (used in a couple tables). */
function highlight(text, term){
  if(!term) return escapeHtml(text ?? '');
  const t = escapeHtml(String(text ?? ''));
  const safeTerm = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return t.replace(new RegExp(safeTerm, 'ig'), m => `<mark>${m}</mark>`);
}
