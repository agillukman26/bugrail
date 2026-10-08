/* ==========================================================
   workspace.js — multi-workspace per account.
   A user can belong to several workspaces (user.workspaceIds).
   After login they pick one on a full-screen picker (cards with
   stats + last opened), or it opens automatically when they have
   only one, or ticked "open last workspace next time". Switching
   later goes through the sidebar switcher (renderSwitcher) — no
   re-login. The rest of the app keeps working off ONE active
   workspace (Auth.currentWorkspaceId), so file visibility, sharing
   and the server-side check are unchanged.
   WorkspaceCalc is pure (no DOM) — see qa-app/test/workspace.check.js.
   ========================================================== */

const WorkspaceCalc = {
  ALL: '__all__', // admin-only choice: every workspace at once (no filtering)
  ALL_COLOR: ['#EEF0F4', '#4B5563'],
  DONE_BUG_STATUSES: ['Closed', 'Rejected'],
  COLORS: [['#EEEDFE', '#3C3489'], ['#E1F5EE', '#085041'], ['#E6F1FB', '#0C447C'], ['#FAEEDA', '#633806'], ['#FBEAF0', '#72243E']],

  // Legacy accounts have a single workspaceId; new ones a workspaceIds array.
  userWorkspaceIds(user){
    if (!user) return [];
    if (Array.isArray(user.workspaceIds)) return user.workspaceIds.filter(Boolean);
    return user.workspaceId ? [user.workspaceId] : [];
  },

  colorFor(workspaces, id){
    if (id === this.ALL) return this.ALL_COLOR;
    const i = Math.max(0, (workspaces || []).findIndex(w => w.id === id));
    return this.COLORS[i % this.COLORS.length];
  },

  initials(name){
    const words = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (!words.length) return '?';
    return (words.length === 1 ? words[0].slice(0, 2) : words[0][0] + words[1][0]).toUpperCase();
  },

  /* Which workspace to open without showing the picker, or null to show it.
     '' = the account has no workspace (sees shared/legacy files only). */
  autoEnter(ids, pref = {}){
    if (!ids.length) return '';
    if (ids.length === 1) return ids[0];
    if (pref.autoOpen && ids.includes(pref.last)) return pref.last;
    return null;
  },

  cards({ workspaces = [], ids = [], files = [], testcases = [], bugs = [], visits = {} }){
    const lastId = Object.entries(visits).filter(([id]) => ids.includes(id)).sort((a, b) => b[1].localeCompare(a[1]))[0]?.[0];
    const all = { id: this.ALL, name: 'Semua workspace' };
    return ids.map(id => id === this.ALL ? all : workspaces.find(w => w.id === id)).filter(Boolean).map(w => {
      const own = w.id === this.ALL ? files : files.filter(f => f.workspaceId === w.id);
      const fileIds = new Set(own.map(f => f.id));
      const latestFile = own.slice().sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))[0] || null;
      return {
        id: w.id, name: w.name, initials: w.id === this.ALL ? 'ALL' : this.initials(w.name), color: this.colorFor(workspaces, w.id),
        files: own.length,
        testcases: testcases.filter(t => fileIds.has(t.fileId)).length,
        openBugs: bugs.filter(b => fileIds.has(b.fileId) && !this.DONE_BUG_STATUSES.includes(b.status)).length,
        lastOpened: visits[w.id] || null,
        isLast: w.id === lastId,
        latestFile: latestFile ? { name: latestFile.name, at: latestFile.createdAt } : null
      };
    });
  },

  /* Shared bug link (#bug=<id>): which workspace to activate so the bug's file
     is visible. Prefers staying in the active workspace when it already sees
     the file. Returns a workspace id, '' (no switch needed — shared file for a
     workspace-less user), or null = this account has no access. */
  workspaceForFile(file, ids, isAdmin, active){
    if (!file) return null;
    const sees = ws => (isAdmin && ws === this.ALL) || !file.workspaceId || file.workspaceId === ws || (file.sharedWith || []).includes(ws);
    if (active && (isAdmin || ids.includes(active)) && sees(active)) return active;
    if (file.workspaceId && ids.includes(file.workspaceId)) return file.workspaceId;
    const viaShare = ids.find(ws => ws !== this.ALL && sees(ws));
    if (viaShare) return viaShare;
    if (!file.workspaceId) return active || '';
    return isAdmin ? file.workspaceId : null;
  },

  timeAgo(iso, now = Date.now()){
    if (!iso) return '';
    const min = Math.max(0, Math.round((now - new Date(iso)) / 60000));
    if (min < 1) return 'baru saja';
    if (min < 60) return `${min} menit lalu`;
    if (min < 60 * 24) return `${Math.round(min / 60)} jam lalu`;
    return `${Math.round(min / 1440)} hari lalu`;
  }
};

const WorkspacePicker = {
  // Per browser + per account: last opened workspace, visit times, "autoOpen" tick (off by default;
  // renamed from the old default-on "remember" so every account sees the picker again).
  prefKey(){ return `qa_ws_pref_${(Auth.currentEmail() || '').toLowerCase()}`; },
  pref(){
    try{ return JSON.parse(localStorage.getItem(this.prefKey())) || { visits: {} }; }catch(e){ return { visits: {} }; }
  },
  savePref(p){ try{ localStorage.setItem(this.prefKey(), JSON.stringify(p)); }catch(e){} },

  currentUser(){
    const settings = App.state.settings && App.state.settings.users ? App.state.settings : Auth.loadSettingsRaw();
    return Auth.findByEmail(settings.users, Auth.currentEmail());
  },
  // Admin: "Semua workspace" + every workspace. Others: the ones ticked in Daftar User.
  myWorkspaceIds(){
    if (Auth.isAdmin()){
      const settings = App.state.settings && App.state.settings.workspaces ? App.state.settings : Auth.loadSettingsRaw();
      return [WorkspaceCalc.ALL, ...(settings.workspaces || []).map(w => w.id)];
    }
    return WorkspaceCalc.userWorkspaceIds(this.currentUser());
  },
  activeRaw(){ return sessionStorage.getItem(Auth.WORKSPACE_KEY) || ''; },
  nameOf(id){ return id === WorkspaceCalc.ALL ? 'Semua workspace' : ((Auth.findWorkspace(id) || {}).name || id); },
  canSwitch(){ return this.myWorkspaceIds().length > 1; },

  /* Called right after login / on reload with a live session. Returns true if
     a workspace was resolved (caller continues into the app), false if the
     picker is now showing and will continue the flow itself. */
  resolveOnStart(){
    const ids = this.myWorkspaceIds();
    const current = this.activeRaw();
    if (current && ids.includes(current)) return true;     // reload inside an open session
    // Opened from a shared bug link: enter the bug's workspace, skip the picker.
    const linkId = App.deepLinkBugId();
    if (linkId){
      const bug = Storage.get(STORAGE_KEYS.BUGS, []).find(b => b.id === linkId);
      const file = bug && Storage.get(STORAGE_KEYS.FILES, []).find(f => f.id === bug.fileId);
      const target = WorkspaceCalc.workspaceForFile(file, ids, Auth.isAdmin(), current);
      if (target !== null){ this.setActive(target || current); return true; }
    }
    const auto = WorkspaceCalc.autoEnter(ids, this.pref());
    if (auto !== null){ this.setActive(auto); return true; }
    this.show();
    return false;
  },

  setActive(wsId){
    if (wsId) sessionStorage.setItem(Auth.WORKSPACE_KEY, wsId);
    else sessionStorage.removeItem(Auth.WORKSPACE_KEY);
    if (!wsId) return;
    const p = this.pref();
    p.last = wsId;
    p.visits = { ...(p.visits || {}), [wsId]: nowISO() };
    this.savePref(p);
  },

  show(){
    const settings = App.state.settings && App.state.settings.workspaces ? App.state.settings : Auth.loadSettingsRaw();
    const pref = this.pref();
    const cards = WorkspaceCalc.cards({
      workspaces: settings.workspaces || [], ids: this.myWorkspaceIds(),
      files: Storage.get(STORAGE_KEYS.FILES, []), testcases: Storage.get(STORAGE_KEYS.TESTCASES, []),
      bugs: Storage.get(STORAGE_KEYS.BUGS, []), visits: pref.visits || {}
    });
    const email = Auth.currentEmail() || '';
    const name = email.split('@')[0];
    const roleLabel = (Auth.ROLES.find(r => r.value === Auth.role()) || {}).label || Auth.role();
    const inApp = !document.body.classList.contains('pre-auth');

    let el = document.getElementById('wsPicker');
    if (!el){ el = document.createElement('div'); el.id = 'wsPicker'; el.className = 'ws-picker'; document.body.appendChild(el); }
    el.innerHTML = `
      <div class="ws-picker-bar">
        <div class="ws-picker-brand"><div class="mark">QA</div><b>BugRail</b></div>
        <div class="ws-picker-user">
          <span>👤 ${escapeHtml(email)} (${escapeHtml(roleLabel)})</span>
          ${inApp ? '<button class="btn sm" id="wsPickerCancel">Batal</button>' : ''}
          <button class="btn sm ghost" id="wsPickerLogout">Logout</button>
        </div>
      </div>
      <div class="ws-picker-body">
        <h1>Selamat datang kembali, ${escapeHtml(name)}</h1>
        <p class="text-dim">Pilih workspace untuk mulai bekerja.</p>
        <div class="ws-grid">
          ${cards.map(c => `
            <button class="ws-card" type="button" data-ws="${escapeHtml(c.id)}" style="--ws-bg:${c.color[0]}; --ws-fg:${c.color[1]};">
              <div class="ws-card-head">
                <span class="ws-dot">${escapeHtml(c.initials)}</span>
                <div class="ws-card-title"><b>${escapeHtml(c.name)}</b><span>Peran: ${escapeHtml(roleLabel)}</span></div>
                ${c.isLast ? '<span class="ws-tag">Terakhir</span>' : ''}
              </div>
              <div class="ws-stats">
                <div><b>${c.files}</b><span>File</span></div>
                <div><b>${c.testcases}</b><span>Test case</span></div>
                <div><b>${c.openBugs}</b><span>Bug terbuka</span></div>
              </div>
              <div class="ws-act">🕒 ${c.lastOpened ? `Terakhir dibuka ${WorkspaceCalc.timeAgo(c.lastOpened)}` : 'Belum pernah dibuka'}</div>
              <div class="ws-act">📄 ${c.latestFile ? `${escapeHtml(c.latestFile.name)} dibuat${c.latestFile.at ? ` ${WorkspaceCalc.timeAgo(c.latestFile.at)}` : ''}` : 'Belum ada file'}</div>
              <div class="ws-open">Buka workspace →</div>
            </button>`).join('')}
        </div>
        <label class="ws-remember"><input type="checkbox" id="wsRemember" ${pref.autoOpen ? 'checked' : ''}> Langsung buka workspace terakhir saat login berikutnya</label>
      </div>`;
    el.classList.add('open');
    el.querySelectorAll('.ws-card').forEach(card => card.onclick = () => this.choose(card.dataset.ws));
    el.querySelector('#wsPickerLogout').onclick = () => Auth.logout();
    const cancel = el.querySelector('#wsPickerCancel');
    if (cancel) cancel.onclick = () => this.hide();
  },
  hide(){ const el = document.getElementById('wsPicker'); if (el) el.classList.remove('open'); },

  choose(wsId){
    const p = this.pref();
    p.autoOpen = document.getElementById('wsRemember').checked;
    delete p.remember;
    this.savePref(p);
    const switching = !document.body.classList.contains('pre-auth') && this.activeRaw() !== wsId;
    this.setActive(wsId);
    this.hide();
    let linked = false;
    if (document.body.classList.contains('pre-auth')) linked = Auth.startApp();
    else if (switching) App.onWorkspaceChanged();
    ActivityLog.record('workspace_open', `${Auth.currentEmail()} membuka workspace ${this.nameOf(wsId)}`);
    if (!linked && App.canAccessPage('testcase')) App.goTo('testcase');
  },

  /* Sidebar switcher (mockup: bugrail_workspace_switcher_mockup.html): active
     workspace row + dropdown to jump to another one directly, no re-login. */
  renderSwitcher(){
    const el = document.getElementById('wsSwitcher');
    if (!el) return;
    const all = Auth.workspaces();
    const ALL = WorkspaceCalc.ALL;
    const toWs = id => id === ALL ? { id: ALL, name: this.nameOf(ALL) } : Auth.findWorkspace(id);
    const active = toWs(this.activeRaw());
    el.style.display = active ? '' : 'none';
    if (!active) return;
    const color = id => WorkspaceCalc.colorFor(all, id);
    const dot = w => `<span class="ws-dot sm" style="--ws-bg:${color(w.id)[0]}; --ws-fg:${color(w.id)[1]};">${w.id === ALL ? 'ALL' : escapeHtml(WorkspaceCalc.initials(w.name))}</span>`;
    const fileCount = (App.state.files || []).filter(f => active.id === ALL || f.workspaceId === active.id).length;
    const mine = this.myWorkspaceIds().map(toWs).filter(Boolean);
    // Only one workspace and nothing else in the menu (admin's "+ Workspace baru"): plain label, no dropdown.
    const locked = !this.canSwitch() && !Auth.isAdmin();
    el.innerHTML = `
      <div class="ws-switcher-label">Workspace</div>
      <button class="ws-switcher-btn${locked ? ' locked' : ''}" type="button" id="wsSwitcherBtn" title="${escapeHtml(active.name)}" ${locked ? 'disabled' : 'aria-haspopup="true"'}>
        ${dot(active)}
        <span class="ws-switcher-text"><b>${escapeHtml(active.name)}</b><span>${fileCount} file</span></span>
        ${locked ? '' : `<svg class="ws-switcher-caret" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 9l4-4 4 4M16 15l-4 4-4-4"/></svg>`}
      </button>
      <div class="ws-menu" id="wsMenu">
        ${mine.map(w => `<button class="ws-menu-item" type="button" data-ws="${escapeHtml(w.id)}">${dot(w)}<span>${escapeHtml(w.name)}</span>${w.id === active.id ? '<span class="ws-check">✓</span>' : ''}</button>`).join('')}
        ${Auth.isAdmin() ? '<div class="ws-menu-sep"></div><button class="ws-menu-item muted" type="button" id="wsMenuNew">+ Workspace baru</button>' : ''}
      </div>`;
    const menu = el.querySelector('#wsMenu');
    el.querySelector('#wsSwitcherBtn').onclick = e => { e.stopPropagation(); menu.classList.toggle('open'); };
    menu.querySelectorAll('[data-ws]').forEach(b => b.onclick = () => { menu.classList.remove('open'); this.switchTo(b.dataset.ws); });
    const add = menu.querySelector('#wsMenuNew');
    if (add) add.onclick = () => { menu.classList.remove('open'); App.goTo('workspace'); };
    if (!this._outsideBound){
      this._outsideBound = true;
      document.addEventListener('click', e => {
        const m = document.getElementById('wsMenu');
        if (m && !e.target.closest('#wsSwitcher')) m.classList.remove('open');
      });
    }
  },

  switchTo(wsId){
    if (wsId === this.activeRaw()) return;
    this.setActive(wsId);
    App.onWorkspaceChanged();
    ActivityLog.record('workspace_open', `${Auth.currentEmail()} pindah ke workspace ${this.nameOf(wsId)}`);
    Toast.show(`Berhasil pindah ke workspace ${this.nameOf(wsId)}.`, 'success');
  },

};
