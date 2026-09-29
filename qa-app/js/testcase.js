/* ==========================================================
   testcase.js — Test Case module (TestRail/Zephyr-style table)
   ========================================================== */

let stepsEditor = null;

/* Row-action dropdown lives inside .table-wrap (overflow-x:auto), which
   clips any absolutely-positioned child that overflows it — so a panel
   near the bottom of the table got cut off. Escape that by switching the
   panel to viewport-fixed coords anchored to its trigger button. */
function positionRowActionsPanel(btn, panel){
  const r = btn.getBoundingClientRect();
  panel.classList.add('dropdown-panel-fixed');
  panel.style.top = `${r.bottom + 6}px`;
  panel.style.left = 'auto';
  panel.style.right = `${window.innerWidth - r.right}px`;
  const panelHeight = panel.offsetHeight;
  if (r.bottom + 6 + panelHeight > window.innerHeight){
    panel.style.top = `${r.top - panelHeight - 6}px`;
  }
}

const TestCaseModule = {
  STATUS: ['Open', 'Passed', 'Failed', 'Blocked', 'Retest'],
  TYPE_TEST: ['Negative', 'Positive'],

  ui: {
    search: '',
    filters: { module:'', typeTest:'', status:'' },
    sortKey: 'id', sortDir: 'asc',
    page: 1, pageSize: 10,
    selected: new Set(),
    editingId: null,
    executingId: null,
    activeFileId: null
  },

  setSearch(term){ this.ui.search = term; this.ui.page = 1; this.render(); },

  /* ---- files (grouping) ---- */
  files(){ return Auth.visibleFiles(App.state.files); },
  fileCounts(){
    const counts = {};
    App.state.testcases.forEach(t => { if (t.fileId) counts[t.fileId] = (counts[t.fileId] || 0) + 1; });
    return counts;
  },
  fileCount(fileId){ return App.state.testcases.filter(t => t.fileId === fileId).length; },
  openFile(fileId){
    this.ui.activeFileId = fileId; this.ui.page = 1; this.ui.selected.clear();
    this.render();
  },
  backToFiles(){
    this.ui.activeFileId = null; this.ui.search = '';
    const globalSearch = document.getElementById('globalSearch');
    if (globalSearch) globalSearch.value = '';
    this.render();
  },
  createFile(name, workspaceId = Auth.currentWorkspaceId()){
    name = (name || '').trim();
    if (!name) return;
    const file = { id: 'FILE-' + Date.now(), name, workspaceId, createdBy: Auth.currentEmail() || '', createdAt: nowISO() };
    App.state.files.push(file);
    App.saveFiles();
    ActivityLog.record('tc_file_create', `File Test Case "${name}" dibuat`);
    this.renderFileList();
    Toast.show(`File "${name}" dibuat.`, 'success');
  },
  async editFile(fileId){
    const file = this.files().find(f => f.id === fileId);
    if (!file) return;
    const canShare = Auth.canShareFile(file);
    const result = await fileEditDialog(file, canShare, Auth.workspaces());
    if (!result) return;
    const oldName = file.name;
    const oldShared = (file.sharedWith || []).slice().sort();
    file.name = result.name;
    if (canShare) file.sharedWith = result.sharedWith;
    App.saveFiles();
    if (oldName !== file.name) ActivityLog.record('tc_file_rename', `File Test Case "${oldName}" diganti nama jadi "${file.name}"`);
    const newShared = (file.sharedWith || []).slice().sort();
    if (canShare && JSON.stringify(oldShared) !== JSON.stringify(newShared)){
      ActivityLog.record('tc_file_share', newShared.length
        ? `File Test Case "${file.name}" dibagikan ke ${newShared.length} workspace`
        : `Sharing File Test Case "${file.name}" dihapus`);
    }
    this.render();
    Toast.show(`File "${file.name}" diperbarui.`, 'success');
  },
  async deleteFile(fileId){
    if (!Auth.isAdmin()){ Toast.show('Hanya Admin yang dapat menghapus file.', 'error'); return; }
    const file = this.files().find(f => f.id === fileId);
    const tcCount = App.state.testcases.filter(t => t.fileId === fileId).length;
    const bugCount = App.state.bugs.filter(b => b.fileId === fileId).length;
    const ok = await confirmDialog('Hapus File?', `File "${file.name}" beserta ${tcCount} test case dan ${bugCount} bug di dalamnya akan dihapus permanen.`, 'Hapus');
    if (!ok) return;
    App.deleteFileCascade(fileId);
    ActivityLog.record('tc_file_delete', `File Test Case "${file.name}" dihapus`);
    if (this.ui.activeFileId === fileId) this.ui.activeFileId = null;
    this.render();
    Toast.show(`File "${file.name}" dihapus.`, 'info');
  },

  /* ---- data access ---- */
  all(){
    if (Auth.seesAllWorkspaces()) return App.state.testcases;
    const visibleIds = new Set(this.files().map(f => f.id));
    return App.state.testcases.filter(tc => !tc.fileId || visibleIds.has(tc.fileId));
  },

  filtered(){
    const { search, filters, sortKey, sortDir, activeFileId } = this.ui;
    let rows = this.all().filter(tc => {
      if (activeFileId && tc.fileId !== activeFileId) return false;
      if (search){
        const hay = `${tc.id} ${tc.module} ${tc.roleUser||''} ${tc.scenario} ${tc.testCase||''} ${tc.preconditions||''} ${stripHtml(tc.steps||'')} ${tc.testData||''} ${tc.expectedResult||''} ${tc.actualResult||''} ${tc.evidence||''}`.toLowerCase();
        const words = search.toLowerCase().trim().split(/\s+/).filter(Boolean);
        if (!words.every(w => hay.includes(w))) return false;
      }
      if (filters.module && tc.module !== filters.module) return false;
      if (filters.typeTest && tc.typeTest !== filters.typeTest) return false;
      if (filters.status && tc.status !== filters.status) return false;
      return true;
    });
    rows.sort((a,b) => {
      const av = (a[sortKey] ?? '').toString().toLowerCase();
      const bv = (b[sortKey] ?? '').toString().toLowerCase();
      if (av < bv) return sortDir === 'asc' ? -1 : 1;
      if (av > bv) return sortDir === 'asc' ? 1 : -1;
      return 0;
    });
    return rows;
  },

  uniqueValues(field){ return [...new Set(this.all().map(t => t[field]).filter(Boolean))].sort(); },

  /* ---- render ---- */
  render(){
    // If the open file was deleted or is no longer shared with this user,
    // fall back to the file list instead of a stuck empty detail view.
    if (this.ui.activeFileId && !this.files().some(f => f.id === this.ui.activeFileId)) this.ui.activeFileId = null;
    const searching = !!this.ui.search;
    const inFile = !!this.ui.activeFileId || searching;
    document.getElementById('tcFileListView').style.display = inFile ? 'none' : 'block';
    document.getElementById('tcFileDetailView').style.display = inFile ? 'block' : 'none';
    document.getElementById('tcNewFileBtn').style.display = Auth.can('testcase_create') ? '' : 'none';
    if (!inFile){ this.renderFileList(); return; }

    const activeFile = this.files().find(f => f.id === this.ui.activeFileId);
    document.getElementById('tcActiveFileName').textContent = activeFile
      ? `📁 ${activeFile.name}`
      : `🔎 Hasil pencarian "${this.ui.search}" (semua file)`;
    document.getElementById('tcActiveFileHint').textContent = activeFile
      ? `(${this.fileCount(this.ui.activeFileId)} test case)`
      : `${this.filtered().length} hasil ditemukan`;

    this.renderFilterOptions();
    const rows = this.filtered();
    const total = rows.length;
    const totalPages = Math.max(1, Math.ceil(total / this.ui.pageSize));
    if (this.ui.page > totalPages) this.ui.page = totalPages;
    const start = (this.ui.page - 1) * this.ui.pageSize;
    const pageRows = rows.slice(start, start + this.ui.pageSize);

    const canCreate = Auth.can('testcase_create');
    const canUpdate = Auth.can('testcase_update');
    const canDelete = Auth.can('testcase_delete');
    const canCreateBug = Auth.can('bugreport_create');
    document.getElementById('tcAddBtn').style.display = canCreate ? '' : 'none';
    document.getElementById('tcEmptyAddBtn').style.display = canCreate ? '' : 'none';
    document.getElementById('tcImportBtn').style.display = canCreate ? '' : 'none';

    const body = document.getElementById('tcTableBody');
    const bulkBar = document.getElementById('tcBulkBar');
    bulkBar.style.display = this.ui.selected.size ? 'flex' : 'none';
    bulkBar.querySelector('.count').textContent = this.ui.selected.size;
    document.getElementById('tcBulkDeleteBtn').style.display = canDelete ? '' : 'none';
    document.getElementById('tcBulkStatusSelect').style.display = canUpdate ? '' : 'none';

    if (!total){
      document.getElementById('tcEmptyState').style.display = 'flex';
      document.getElementById('tcTableWrap').style.display = 'none';
    } else {
      document.getElementById('tcEmptyState').style.display = 'none';
      document.getElementById('tcTableWrap').style.display = 'block';
    }

    body.innerHTML = pageRows.map(tc => `
      <tr>
        <td><input type="checkbox" class="checkbox tc-row-check" data-id="${tc.id}" ${this.ui.selected.has(tc.id) ? 'checked':''}></td>
        <td class="mono tc-id-link" data-view="${tc.id}" style="cursor:pointer; text-decoration:underline;" title="${escapeHtml(tc.steps ? `Test Step:\n${stripHtml(tc.steps)}` : 'Belum ada Test Step')}">${escapeHtml(tc.id)}</td>
        <td class="truncate" title="${escapeHtml(tc.module)}">${escapeHtml(tc.module)}</td>
        <td class="truncate" title="${escapeHtml(tc.roleUser)}">${escapeHtml(tc.roleUser || '-')}</td>
        <td class="truncate" title="${escapeHtml(tc.scenario)}">${escapeHtml(tc.scenario)}</td>
        <td class="truncate" title="${escapeHtml(tc.testCase)}">${escapeHtml(tc.testCase || '-')}</td>
        <td>${escapeHtml(tc.typeTest || '-')}</td>
        <td>${this.statusBadge(tc.status)}</td>
        <td>${this.evidenceCell(tc.evidence)}</td>
        <td class="col-hidden">${formatDate(tc.executionDate)}</td>
        <td class="cell-actions">
          <div class="dropdown">
            <button class="row-actions-btn" type="button" title="Aksi">⋮</button>
            <div class="dropdown-panel right">
              ${canUpdate ? `<button class="dropdown-item" data-act="run" data-id="${tc.id}">▶ Run</button>` : ''}
              ${canUpdate ? `<button class="dropdown-item" data-act="edit" data-id="${tc.id}">✎ Edit</button>` : ''}
              ${canCreate ? `<button class="dropdown-item" data-act="dup" data-id="${tc.id}">⧉ Duplicate</button>` : ''}
              ${canDelete ? `<button class="dropdown-item" data-act="del" data-id="${tc.id}">🗑 Hapus</button>` : ''}
              ${tc.status === 'Failed' && canCreateBug ? `<button class="dropdown-item" data-act="bug" data-id="${tc.id}">🐞 Create Bug</button>` : ''}
            </div>
          </div>
        </td>
      </tr>
    `).join('');

    document.getElementById('tcResultInfo').textContent = `Menampilkan ${pageRows.length} dari ${total} test case`;
    this.renderPagination(totalPages);
    this.bindRowEvents();
    document.getElementById('tcSelectAll').checked = pageRows.length > 0 && pageRows.every(r => this.ui.selected.has(r.id));
  },

  renderFileList(){
    App.ensureDefaultFile(); // self-heal: bucket any orphan test case (fileId missing) without needing a reload
    const wrap = document.getElementById('tcFileListGrid');
    const files = this.files();
    if (!files.length){
      wrap.innerHTML = `<p class="text-faint" style="font-size:13.5px; grid-column:1/-1; padding:24px 0; text-align:center;">📁 Belum ada file test case.<br>Ketik nama di kolom atas lalu klik <b>+ File Baru</b> untuk mulai.</p>`;
      return;
    }
    const counts = this.fileCounts();
    wrap.innerHTML = files.map(f => {
      const shareCount = (f.sharedWith || []).length;
      return `
      <div class="card tc-file-card ${f.workspaceId ? 'ws-colored' : ''}" data-open="${f.id}" style="--ws-fg:${WorkspaceCalc.colorFor(Auth.workspaces(), f.workspaceId)[1]};">
        <div class="flex-between">
          <h3 style="margin:0; font-size:14.5px; cursor:pointer; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" data-open="${f.id}">📁 ${escapeHtml(f.name)}</h3>
          <div class="file-card-actions"><button class="file-info-btn" type="button" data-info="${f.id}" title="Detail file" aria-label="Detail file"><svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg></button>${actionMenu(`
            <button data-act="edit" data-id="${f.id}">✎ Edit</button>
            <button class="danger" data-act="del" data-id="${f.id}">🗑 Hapus</button>
          `)}</div>
        </div>
        <div class="flex-between" style="margin-top:8px;">
          <p class="text-faint" style="font-size:12.5px; margin:0;">${App.state.testcases.filter(t => t.fileId === f.id).length} test case · ${App.state.bugs.filter(b => b.fileId === f.id).length} bug</p>
          ${shareCount ? `<span class="badge st-notrun" title="Dibagikan ke ${shareCount} workspace">📤 ${shareCount}</span>` : ''}
        </div>
      </div>
    `;
    }).join('') + (Auth.can('testcase_create') ? `<button class="card tc-file-card tc-file-add" type="button" id="tcNewFileAddCard">+ Tambah file</button>` : '');
    wrap.querySelectorAll('[data-open]').forEach(el => el.addEventListener('click', (e) => {
      if (e.target.closest('.action-menu, .file-info-btn')) return;
      this.openFile(el.dataset.open);
    }));
    const addCard = document.getElementById('tcNewFileAddCard');
    if (addCard) addCard.onclick = () => document.getElementById('tcNewFileBtn').click();
    wrap.querySelectorAll('.file-info-btn').forEach(btn => { btn.onclick = () => App.showFileDetail(btn.dataset.info); });
    wrap.querySelectorAll('.action-menu button[data-act]').forEach(btn => {
      btn.onclick = async () => {
        const { act, id } = btn.dataset;
        if (act === 'edit') this.editFile(id);
        if (act === 'del') this.deleteFile(id);
      };
    });
  },

  statusBadge(status){
    const map = { 'Open':'notrun', 'Passed':'passed', 'Failed':'failed', 'Blocked':'blocked', 'Retest':'retest' };
    return `<span class="badge st-${map[status]}"><span class="dot"></span>${status}</span>`;
  },

  /* Table cell: one link icon per URL in the evidence text; a note icon
     (full text in the tooltip) when there's evidence but no URL. */
  evidenceCell(evidence){
    if (!evidence) return '-';
    evidence = String(evidence); // imported cells can be numbers
    const urls = evidence.match(/https?:\/\/[^\s<>"']+/g);
    if (!urls) return `<span class="evidence-icon" title="${escapeHtml(evidence)}" aria-label="Evidence (teks)"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M16 13H8M16 17H8"/></svg></span>`;
    return urls.map(url => `<a class="evidence-icon" href="${escapeHtml(url)}" target="_blank" rel="noopener" title="${escapeHtml(url)}" aria-label="Buka evidence"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg></a>`).join('');
  },

  renderFilterOptions(){
    const build = (id, field) => {
      const el = document.getElementById(id);
      const current = this.ui.filters[field];
      el.innerHTML = `<option value="">${el.dataset.label}</option>` +
        this.uniqueValues(field).map(v => `<option value="${escapeHtml(v)}" ${v===current?'selected':''}>${escapeHtml(v)}</option>`).join('');
    };
    build('tcFilterModule', 'module');
  },

  resetFilters(){
    this.ui.filters = { module:'', typeTest:'', status:'' };
    this.ui.page = 1;
    document.getElementById('tcFilterTypeTest').value = '';
    document.getElementById('tcFilterStatus').value = '';
    this.render();
  },

  renderPagination(totalPages){
    const el = document.getElementById('tcPagination');
    let html = `<button ${this.ui.page===1?'disabled':''} data-pg="prev">‹</button>`;
    for (let i=1;i<=totalPages;i++){
      if (totalPages > 7 && Math.abs(i-this.ui.page) > 2 && i!==1 && i!==totalPages){
        if (i === 2 || i === totalPages-1) html += `<span>…</span>`;
        continue;
      }
      html += `<button class="${i===this.ui.page?'active':''}" data-pg="${i}">${i}</button>`;
    }
    html += `<button ${this.ui.page===totalPages?'disabled':''} data-pg="next">›</button>`;
    el.innerHTML = html;
    el.querySelectorAll('button[data-pg]').forEach(b => b.addEventListener('click', () => {
      const v = b.dataset.pg;
      if (v === 'prev') this.ui.page--;
      else if (v === 'next') this.ui.page++;
      else this.ui.page = parseInt(v,10);
      this.render();
    }));
  },

  bindRowEvents(){
    document.querySelectorAll('.tc-id-link').forEach(td => {
      td.onclick = () => this.openDetail(td.dataset.view);
    });
    document.querySelectorAll('.tc-row-check').forEach(cb => {
      cb.onchange = () => {
        cb.checked ? this.ui.selected.add(cb.dataset.id) : this.ui.selected.delete(cb.dataset.id);
        this.render();
      };
    });
    document.querySelectorAll('#tcTableBody .row-actions-btn').forEach(btn => {
      btn.onclick = (e) => {
        e.stopPropagation();
        const dd = btn.closest('.dropdown');
        document.querySelectorAll('.dropdown.open').forEach(o => { if (o !== dd) o.classList.remove('open'); });
        const opening = dd.classList.toggle('open');
        if (opening) positionRowActionsPanel(btn, dd.querySelector('.dropdown-panel'));
      };
    });
    document.querySelectorAll('#tcTableBody button[data-act]').forEach(btn => {
      btn.onclick = () => {
        const { act, id } = btn.dataset;
        btn.closest('.dropdown').classList.remove('open');
        if (act === 'run') this.openExecute(id);
        if (act === 'edit') this.openForm(id);
        if (act === 'dup') this.duplicate(id);
        if (act === 'del') this.remove(id);
        if (act === 'bug') this.createBugFromTestCase(id);
      };
    });
  },

  /* ---- CRUD ---- */
  openForm(id = null){
    const tc = id ? this.all().find(t => t.id === id) : null;
    if (!tc && !Auth.can('testcase_create')){ Toast.show('Tidak punya izin menambah Test Case.', 'error'); return; }
    if (tc && !Auth.can('testcase_update')){ Toast.show('Tidak punya izin mengedit Test Case.', 'error'); return; }
    this.ui.editingId = id;
    const f = document.getElementById('tcForm');
    f.reset();
    this.showModuleError('');
    document.getElementById('tcModalTitle').textContent = tc ? `Edit Test Case — ${tc.id}` : 'Tambah Test Case';
    document.getElementById('tcFieldId').value = tc ? tc.id : '(auto generate, prefix dari Module)';
    if (tc){
      this.setModule(tc.module); f.roleUser.value = tc.roleUser || ''; f.scenario.value = tc.scenario;
      f.testCase.value = tc.testCase || '';
      f.preconditions.value = tc.preconditions || ''; stepsEditor.root.innerHTML = tc.steps || '';
      f.testData.value = tc.testData || '';
      f.expectedResult.value = tc.expectedResult || ''; f.actualResult.value = tc.actualResult || '';
      f.typeTest.value = tc.typeTest || 'Positive'; f.status.value = tc.status;
      f.evidence.value = tc.evidence || '';
      f.executionDate.value = tc.executionDate || '';
    }
    if (!tc){
      this.setModule('');
      f.status.value = 'Open'; f.typeTest.value = 'Positive';
      stepsEditor.root.innerHTML = '';
    }
    this.renderCustomFields(tc ? tc.customFields : null);
    document.getElementById('tcModalOverlay').classList.add('active');
  },

  /* ---- Module combobox (searchable select over existing Module values) ---- */
  setModule(name){
    const f = document.getElementById('tcForm');
    f.module.value = name || '';
    const label = document.getElementById('tcModuleTriggerText');
    label.textContent = name || 'Select Module';
    label.classList.toggle('text-faint', !name);
    if (name) this.showModuleError('');
  },
  renderModuleList(query){
    const listEl = document.getElementById('tcModuleList');
    const all = this.uniqueValues('module');
    const q = query.trim().toLowerCase();
    const filtered = q ? all.filter(m => m.toLowerCase().includes(q)) : all;
    if (!filtered.length){
      listEl.innerHTML = `<div class="combobox-empty">
        <div class="combobox-empty-icon">📥</div>
        <p>Belum ada module.</p>
        <span>Silakan tambahkan module baru untuk melanjutkan.</span>
      </div>`;
      return;
    }
    listEl.innerHTML = filtered.map(m => `<div class="dropdown-item combobox-option" data-module="${escapeHtml(m)}">${escapeHtml(m)}</div>`).join('');
    listEl.querySelectorAll('[data-module]').forEach(el => {
      el.addEventListener('click', () => {
        this.setModule(el.dataset.module);
        document.getElementById('tcModuleDropdown').classList.remove('open');
      });
    });
  },
  showModuleError(msg){
    const el = document.getElementById('tcModuleError');
    el.textContent = msg;
    el.style.display = msg ? 'block' : 'none';
    document.getElementById('tcModuleDropdown').classList.toggle('invalid', !!msg);
  },
  openModuleCombobox(){
    document.getElementById('tcModuleSearch').value = '';
    this.showModuleError('');
    this.renderModuleList('');
  },
  moduleExists(name){
    return this.uniqueValues('module').some(m => m.toLowerCase() === name.toLowerCase());
  },
  async addNewModule(){
    const typed = document.getElementById('tcModuleSearch').value.trim();
    let name;
    if (typed){
      if (this.moduleExists(typed)){ this.showModuleError('Nama module sudah ada.'); return; }
      name = typed;
    } else {
      name = await promptDialog('Module Baru', 'Nama module', '', 'Tambah',
        (value) => this.moduleExists(value) ? 'Nama module sudah ada.' : null);
      if (!name) return;
    }
    this.showModuleError('');
    this.setModule(name);
    document.getElementById('tcModuleDropdown').classList.remove('open');
  },

  /* ---- Custom Fields (Settings > Custom Fields Test Case, per-project flexible columns) ---- */
  customFieldDefs(){ return App.state.settings.customFieldDefs || []; },
  renderCustomFields(values){
    const wrap = document.getElementById('tcCustomFieldsWrap');
    const defs = this.customFieldDefs();
    wrap.innerHTML = defs.map(d => `
      <div class="field">
        <label>${escapeHtml(d.label)}</label>
        <textarea data-custom-field="${escapeHtml(d.label)}">${escapeHtml(values && values[d.label] || '')}</textarea>
      </div>
    `).join('');
  },
  readCustomFields(){
    const values = {};
    document.querySelectorAll('#tcCustomFieldsWrap [data-custom-field]').forEach(el => {
      values[el.dataset.customField] = el.value.trim();
    });
    return values;
  },
  closeForm(){ document.getElementById('tcModalOverlay').classList.remove('active'); },

  /* ---- Translate whole file (ID<->EN) — direction auto-detected per test case ---- */
  async translateActiveFile(){
    if (!this.ui.activeFileId){ Toast.show('Buka salah satu file test case dulu.', 'error'); return; }
    if (!Auth.can('testcase_update')){ Toast.show('Tidak punya izin mengedit Test Case.', 'error'); return; }
    const rows = App.state.testcases.filter(t => t.fileId === this.ui.activeFileId);
    if (!rows.length){ Toast.show('File ini belum punya test case.', 'error'); return; }
    const ok = await confirmDialog('Translate File?', `${rows.length} test case di file ini akan diterjemahkan (ID⇄EN otomatis) dan langsung disimpan.`, 'Translate');
    if (!ok) return;

    const textFields = ['scenario', 'testCase', 'preconditions', 'testData', 'expectedResult', 'actualResult'];
    const btn = document.getElementById('tcTranslateFileBtn');
    btn.disabled = true;
    btn.textContent = '🌐 Translating...';
    try {
      for (const tc of rows){
        const from = detectLang([tc.scenario, tc.testCase].filter(Boolean).join(' '));
        const to = from === 'id' ? 'en' : 'id';
        const langpair = `${from}|${to}`;
        const stepsText = stepsHtmlToText(tc.steps || '');
        const [translatedFields, translatedSteps] = await Promise.all([
          Promise.all(textFields.map(name => translateText(tc[name], langpair))),
          stepsText ? translateText(stepsText, langpair) : Promise.resolve('')
        ]);
        textFields.forEach((name, i) => { tc[name] = translatedFields[i]; });
        if (translatedSteps) tc.steps = textToStepsHtml(translatedSteps);
      }
      App.saveTestcases();
      this.render();
      Toast.show(`${rows.length} test case diterjemahkan.`, 'success');
    } catch (err) {
      console.error(err);
      Toast.show('Gagal menerjemahkan. Coba lagi.', 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = '🌐 Translate';
    }
  },

  submitForm(e){
    e.preventDefault();
    const f = e.target;
    f.steps.value = stepsEditor.getText().trim() ? stepsEditor.root.innerHTML : '';
    const data = {
      module: f.module.value.trim(), roleUser: f.roleUser.value.trim(), scenario: f.scenario.value.trim(),
      testCase: f.testCase.value.trim(),
      preconditions: f.preconditions.value.trim(), steps: f.steps.value.trim(), testData: f.testData.value.trim(),
      expectedResult: f.expectedResult.value.trim(), actualResult: f.actualResult.value.trim(),
      typeTest: f.typeTest.value, status: f.status.value,
      evidence: f.evidence.value.trim(),
      executionDate: f.executionDate.value,
      customFields: this.readCustomFields()
    };
    this.showModuleError(data.module ? '' : 'Module wajib diisi.');
    if (!data.module || !data.scenario || !data.testCase){
      Toast.show('Module, Scenario, dan Test Case wajib diisi.', 'error'); return;
    }
    if (this.ui.editingId){
      const idx = App.state.testcases.findIndex(t => t.id === this.ui.editingId);
      App.state.testcases[idx] = { ...App.state.testcases[idx], ...data };
      ActivityLog.record('testcase_update', `Test Case ${this.ui.editingId} diperbarui`);
      Toast.show(`Test case ${this.ui.editingId} diperbarui.`, 'success');
    } else {
      const id = IdGen.next(moduleAbbrev(data.module));
      const tc = { id, ...data, fileId: this.ui.activeFileId, createdBy: Auth.currentEmail() || '', createdAt: nowISO() };
      App.state.testcases.push(tc);
      ActivityLog.record('testcase_create', `Test Case ${id} dibuat`);
      Toast.show(`Test case ${id} dibuat.`, 'success');
    }
    App.saveTestcases();
    this.closeForm();
    this.render();
  },

  /* "Run" quick-execute modal — tester only edits Actual Result + Status, per spec. */
  openDetail(id){
    const tc = this.all().find(t => t.id === id);
    if (!tc) return;
    document.getElementById('tcDetailTitle').textContent = `Detail Test Case — ${tc.id}`;
    const block = (label, value) => `
      <div class="bug-detail-block">
        <div class="bug-detail-block-label">${label}</div>
        <div class="bug-detail-block-body">${value}</div>
      </div>`;
    const sideField = (label, value) => `
      <div class="bug-side-field">
        <div class="bug-side-label">${label}</div>
        <div class="bug-side-value">${value}</div>
      </div>`;
    document.getElementById('tcDetailBody').innerHTML = `
      <div class="bug-detail-grid">
        <div class="bug-detail-main">
          <h3 class="bug-detail-title">${escapeHtml(tc.scenario || '-')}</h3>
          ${block('Test Case', escapeHtml(tc.testCase || '-'))}
          ${block('Pre Kondisi', escapeHtml(tc.preconditions || '-'))}
          ${block('Test Step', tc.steps || '-')}
          ${block('Test Data', escapeHtml(tc.testData || '-'))}
          ${block('Expected Result', escapeHtml(tc.expectedResult || '-'))}
          ${block('Actual Result', escapeHtml(tc.actualResult || '-'))}
          ${block('Evidence', tc.evidence ? linkify(tc.evidence) : '-')}
        </div>
        <div class="bug-detail-side">
          <div class="bug-side-heading">Details</div>
          ${sideField('Module', escapeHtml(tc.module || '-'))}
          ${sideField('Role User', escapeHtml(tc.roleUser || '-'))}
          ${sideField('Type Test', escapeHtml(tc.typeTest || '-'))}
          ${sideField('Status', this.statusBadge(tc.status))}
          ${sideField('Execution Date', tc.executionDate ? formatDate(tc.executionDate) : '-')}
          ${sideField('Dibuat oleh', escapeHtml(tc.createdBy || '-'))}
        </div>
      </div>`;
    document.getElementById('tcDetailModalOverlay').classList.add('active');
  },

  openExecute(id){
    this.ui.executingId = id;
    const tc = this.all().find(t => t.id === id);
    document.getElementById('runModalTitle').textContent = `Execute — ${tc.id}`;
    document.getElementById('runScenario').textContent = tc.scenario;
    document.getElementById('runExpected').textContent = tc.expectedResult || '-';
    const f = document.getElementById('runForm');
    f.actualResult.value = tc.actualResult || '';
    f.evidence.value = tc.evidence || '';
    f.status.value = tc.status;
    document.getElementById('runModalOverlay').classList.add('active');
  },
  closeExecute(){ document.getElementById('runModalOverlay').classList.remove('active'); },
  submitExecute(e){
    e.preventDefault();
    const f = e.target;
    const idx = App.state.testcases.findIndex(t => t.id === this.ui.executingId);
    const from = App.state.testcases[idx].status;
    const id = App.state.testcases[idx].id;
    App.state.testcases[idx].actualResult = f.actualResult.value.trim();
    App.state.testcases[idx].evidence = f.evidence.value.trim();
    App.state.testcases[idx].status = f.status.value;
    App.state.testcases[idx].executionDate = todayISO();
    App.saveTestcases();
    if (from !== f.status.value) ActivityLog.record('testcase_update', `Test Case ${id} status diubah dari ${from} ke ${f.status.value} (Run)`);
    this.closeExecute();
    this.render();
    Toast.show(`Hasil eksekusi ${this.ui.executingId} disimpan.`, 'success');
  },

  duplicate(id){
    if (!Auth.can('testcase_create')) return;
    const tc = this.all().find(t => t.id === id);
    const newId = IdGen.next(moduleAbbrev(tc.module));
    App.state.testcases.push({ ...tc, id: newId, fileId: tc.fileId, status:'Open', actualResult:'', evidence:'', executionDate:'', createdBy: Auth.currentEmail() || '', createdAt: nowISO() });
    App.saveTestcases();
    this.render();
    Toast.show(`Duplikat dibuat sebagai ${newId}.`, 'success');
  },

  async remove(id){
    if (!Auth.can('testcase_delete')) return;
    const ok = await confirmDialog('Hapus Test Case?', `${id} akan dihapus. Tindakan ini dapat di-undo sebentar.`);
    if (!ok) return;
    const idx = App.state.testcases.findIndex(t => t.id === id);
    const removed = App.state.testcases.splice(idx, 1)[0];
    ActivityLog.record('testcase_delete', `Test Case ${id} dihapus`);
    App.saveTestcases();
    this.ui.selected.delete(id);
    this.render();
    Toast.show(`${id} dihapus.`, 'info', { undo: () => {
      App.state.testcases.splice(idx, 0, removed); App.saveTestcases(); this.render();
    }});
  },

  async bulkDelete(){
    if (!this.ui.selected.size || !Auth.can('testcase_delete')) return;
    const ids = [...this.ui.selected];
    const ok = await confirmDialog('Hapus Test Case Terpilih?', `${ids.length} test case akan dihapus.`);
    if (!ok) return;
    const removed = App.state.testcases.filter(t => ids.includes(t.id));
    App.state.testcases = App.state.testcases.filter(t => !ids.includes(t.id));
    ActivityLog.record('testcase_delete', `${ids.length} test case dihapus (bulk)`);
    App.saveTestcases();
    this.ui.selected.clear();
    this.render();
    Toast.show(`${ids.length} test case dihapus.`, 'info', { undo: () => {
      App.state.testcases.push(...removed); App.saveTestcases(); this.render();
    }});
  },

  bulkUpdateStatus(status){
    if (!this.ui.selected.size || !status || !Auth.can('testcase_update')) return;
    let changed = 0;
    App.state.testcases.forEach(t => { if (this.ui.selected.has(t.id) && t.status !== status){ t.status = status; changed++; } });
    App.saveTestcases();
    if (changed) ActivityLog.record('testcase_update', `${changed} test case status diubah menjadi ${status} (bulk)`);
    this.render();
    Toast.show(`Status ${this.ui.selected.size} test case diubah menjadi ${status}.`, 'success');
  },

  /* ---- Integration: Test Case (Failed) -> Bug Report ---- */
  createBugFromTestCase(id){
    App.goTo('bugreport');
    setTimeout(() => BugReportModule.openForm(null, id), 50);
  },

  /* ---- Import (Excel/CSV) ---- */
  importFile(file){
    if (!Auth.can('testcase_create')) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      try{
        const wb = XLSX.read(e.target.result, { type: 'array' });
        const sheet = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
        let count = 0;
        rows.forEach(r => {
          const module = r.Module || r.module;
          const scenario = r.Scenario || r.scenario;
          if (!module || !scenario) return;
          const id = (r['Test Case ID'] || r.id) && !this.all().some(t=>t.id === (r['Test Case ID']||r.id))
            ? (r['Test Case ID'] || r.id) : IdGen.next(moduleAbbrev(module));
          App.state.testcases.push({
            id, module, roleUser: r['Role User'] || r.roleUser || '',
            scenario, testCase: r['Test Case'] || r.testCase || '',
            preconditions: r['Pre Kondisi'] || r.Preconditions || r.preconditions || '',
            steps: textToStepsHtml(r['Test Step'] || r.Steps || r.steps || ''), testData: r['Test Data'] || r.testData || '',
            expectedResult: r['Expected Result'] || r.expectedResult || '',
            actualResult: '', evidence: r['Evidence'] || r.evidence || '', status: 'Open',
            typeTest: r['Type Test'] || r.typeTest || 'Positive',
            executionDate: '', customFields: {}, fileId: this.ui.activeFileId, createdBy: Auth.currentEmail() || '', createdAt: nowISO()
          });
          count++;
        });
        App.ensureDefaultFile();
        App.saveTestcases();
        ActivityLog.record('testcase_create', `${count} test case di-import dari file`);
        this.render();
        Toast.show(`${count} test case berhasil di-import.`, 'success');
      }catch(err){
        console.error(err);
        Toast.show('Gagal membaca file. Pastikan format sesuai template.', 'error');
      }
    };
    reader.readAsArrayBuffer(file);
  },

  /* ---- Export ---- */
  exportColumns(){
    const cols = [
      { key:'id', label:'Test Case ID', width:14 },
      { key:'module', label:'Module', width:16 },
      { key:'roleUser', label:'Role User', width:14 },
      { key:'scenario', label:'Scenario', width:30 },
      { key:'testCase', label:'Test Case', width:30 },
      { key:'preconditions', label:'Pre Kondisi', width:24 },
      { key:'steps', label:'Test Step', width:30 },
      { key:'testData', label:'Test Data', width:24 },
      { key:'typeTest', label:'Type Test', width:12, list:this.TYPE_TEST },
      { key:'expectedResult', label:'Expected Result', width:26 },
      { key:'actualResult', label:'Actual Result', width:26 },
      { key:'status', label:'Status', width:12, list:this.STATUS },
      { key:'evidence', label:'Evidence', width:26 },
      { key:'executionDate', label:'Execution Date', width:14 }
    ];
    this.customFieldDefs().forEach(d => cols.push({ key: d.label, label: d.label, width: 20 }));
    return cols;
  },

  /* Excel sheet name: max 31 chars, can't contain \ / ? * [ ] : ; dedup
     with a numeric suffix if two modules sanitize to the same name. */
  safeSheetName(name, used){
    let base = String(name || 'Tanpa Module').replace(/[\\/?*[\]:]/g, '-').trim().slice(0, 31) || 'Module';
    let candidate = base;
    let n = 2;
    while (used.has(candidate)){
      const suffix = ` (${n++})`;
      candidate = base.slice(0, 31 - suffix.length) + suffix;
    }
    used.add(candidate);
    return candidate;
  },

  /* One styled sheet: header fill, borders + wrap text on every cell, and a
     dropdown (data validation) on the Type Test / Status columns. */
  buildSheet(wb, sheetName, cols, rows){
    const ws = wb.addWorksheet(sheetName);
    ws.columns = cols.map(c => ({ header: c.label, key: c.key, width: c.width }));

    const headerRow = ws.getRow(1);
    headerRow.eachCell(cell => {
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2F5496' } };
      cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    });

    rows.forEach(r => ws.addRow(cols.map(c => r[c.key] ?? '')));

    const thin = { style: 'thin', color: { argb: 'FFB0B7C3' } };
    ws.eachRow(row => {
      row.eachCell(cell => {
        cell.border = { top: thin, left: thin, bottom: thin, right: thin };
        if (cell.row !== 1) cell.alignment = { vertical: 'top', wrapText: true };
      });
    });

    cols.forEach((c, i) => {
      if (!c.list) return;
      const colLetter = ws.getColumn(i + 1).letter;
      for (let r = 2; r <= rows.length + 1; r++){
        ws.getCell(`${colLetter}${r}`).dataValidation = {
          type: 'list', allowBlank: true, formulae: [`"${c.list.join(',')}"`]
        };
      }
    });

    ws.views = [{ state: 'frozen', ySplit: 1 }];
  },

  /* One sheet per Module (respects current search/filter via this.filtered()). */
  async exportExcel(){
    const cols = [{ key:'no', label:'No', width:6 }, ...this.exportColumns()];
    const rows = this.filtered().map(t => ({ ...t, ...(t.customFields || {}), steps: stepsHtmlToText(t.steps || '') }));

    const byModule = new Map();
    rows.forEach(r => {
      const key = r.module || 'Tanpa Module';
      if (!byModule.has(key)) byModule.set(key, []);
      byModule.get(key).push(r);
    });

    const wb = new ExcelJS.Workbook();
    const usedNames = new Set();
    byModule.forEach((moduleRows, moduleName) => {
      // Numbering restarts per sheet (one sheet per module).
      this.buildSheet(wb, this.safeSheetName(moduleName, usedNames), cols, moduleRows.map((r, i) => ({ ...r, no: i + 1 })));
    });

    const buf = await wb.xlsx.writeBuffer();
    downloadBlob(buf, `TestCases_${todayISO()}.xlsx`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    ActivityLog.record('testcase_export', `${rows.length} test case di-export ke Excel`);
    Toast.show('Export Excel Test Case berhasil.', 'success');
  },
  exportCSV(){
    const cols = [{ key:'no', label:'No' }, ...this.exportColumns()];
    const rows = this.filtered().map((t, i) => ({ ...t, ...(t.customFields || {}), steps: stepsHtmlToText(t.steps || ''), no: i + 1 }));
    downloadBlob(arrayToCSV(rows, cols), `TestCases_${todayISO()}.csv`, 'text/csv');
    ActivityLog.record('testcase_export', `${rows.length} test case di-export ke CSV`);
    Toast.show('Export CSV Test Case berhasil (siap import ke Google Spreadsheet).', 'success');
  },
  printList(){
    window.print();
  },

  bindStaticEvents(){
    bindPageSize('tcPageSize', this);
    stepsEditor = new Quill('#tcStepsEditor', {
      theme: 'snow',
      modules: {
        toolbar: [
          [{ header: [1, 2, 3, false] }],
          ['bold', 'italic', 'underline', 'strike'],
          [{ list: 'ordered' }, { list: 'bullet' }, { list: 'check' }],
          ['blockquote', 'code-block'],
          ['link', 'code'],
          ['clean']
        ]
      }
    });
    document.getElementById('tcAddBtn').addEventListener('click', () => this.openForm());
    document.getElementById('tcEmptyAddBtn').addEventListener('click', () => this.openForm());
    document.getElementById('tcForm').addEventListener('submit', e => this.submitForm(e));
    document.getElementById('runForm').addEventListener('submit', e => this.submitExecute(e));
    document.getElementById('tcTranslateFileBtn').addEventListener('click', () => this.translateActiveFile());
    document.getElementById('tcModuleTrigger').addEventListener('click', () => this.openModuleCombobox());
    document.getElementById('tcModuleSearch').addEventListener('input', e => { this.showModuleError(''); this.renderModuleList(e.target.value); });
    document.getElementById('tcModuleAddBtn').addEventListener('click', () => this.addNewModule());
    document.getElementById('tcSearchInput').addEventListener('input', debounce(e => this.setSearch(e.target.value), 200));
    document.getElementById('tcSelectAll').addEventListener('change', e => {
      const rows = this.filtered().slice((this.ui.page-1)*this.ui.pageSize, this.ui.page*this.ui.pageSize);
      rows.forEach(r => e.target.checked ? this.ui.selected.add(r.id) : this.ui.selected.delete(r.id));
      this.render();
    });
    ['tcFilterModule','tcFilterTypeTest','tcFilterStatus'].forEach(id => {
      document.getElementById(id).addEventListener('change', e => {
        const map = { tcFilterModule:'module', tcFilterTypeTest:'typeTest', tcFilterStatus:'status' };
        this.ui.filters[map[id]] = e.target.value; this.ui.page = 1; this.render();
      });
    });
    document.getElementById('tcFilterResetBtn').addEventListener('click', () => this.resetFilters());
    document.querySelectorAll('#tcTable thead th.sortable').forEach(th => {
      th.addEventListener('click', () => {
        const key = th.dataset.key;
        this.ui.sortDir = (this.ui.sortKey === key && this.ui.sortDir === 'asc') ? 'desc' : 'asc';
        this.ui.sortKey = key;
        this.render();
      });
    });
    document.getElementById('tcBulkDeleteBtn').addEventListener('click', () => this.bulkDelete());
    document.getElementById('tcBulkStatusSelect').addEventListener('change', e => { this.bulkUpdateStatus(e.target.value); e.target.value=''; });
    const importOverlay = document.getElementById('tcImportModalOverlay');
    const importDz = document.getElementById('tcImportDropzone');
    const importInput = document.getElementById('tcImportFileInput');
    const importPending = document.getElementById('tcImportPending');
    const importConfirmBtn = document.getElementById('tcImportConfirmBtn');
    let pendingFile = null;

    const stageFile = (file) => {
      if (!file) return;
      pendingFile = file;
      document.getElementById('tcImportFileName').textContent = file.name;
      document.getElementById('tcImportFileSize').textContent = `${(file.size / 1024).toFixed(1)} KB`;
      importDz.style.display = 'none';
      importPending.style.display = 'block';
      importConfirmBtn.style.display = 'inline-flex';
    };
    const resetImportModal = () => {
      pendingFile = null;
      importDz.style.display = 'flex';
      importPending.style.display = 'none';
      importConfirmBtn.style.display = 'none';
    };

    document.getElementById('tcImportBtn').addEventListener('click', () => { resetImportModal(); importOverlay.classList.add('active'); });
    document.getElementById('tcImportTemplateBtn').addEventListener('click', () => ImportPage.downloadTemplate());
    document.getElementById('tcImportCancelBtn').addEventListener('click', resetImportModal);
    importDz.addEventListener('click', () => importInput.click());
    importInput.addEventListener('change', e => { stageFile(e.target.files[0]); e.target.value = ''; });
    ['dragenter','dragover'].forEach(evt => importDz.addEventListener(evt, e => { e.preventDefault(); importDz.classList.add('dragover'); }));
    ['dragleave','drop'].forEach(evt => importDz.addEventListener(evt, e => { e.preventDefault(); importDz.classList.remove('dragover'); }));
    importDz.addEventListener('drop', e => stageFile(e.dataTransfer.files[0]));
    importConfirmBtn.addEventListener('click', () => {
      if (!pendingFile) return;
      this.importFile(pendingFile);
      importOverlay.classList.remove('active');
      resetImportModal();
    });
    document.getElementById('tcBackToFilesBtn').addEventListener('click', () => this.backToFiles());
    document.getElementById('tcNewFileBtn').addEventListener('click', async () => {
      if (Auth.isAdmin()){
        const result = await fileCreateDialog(Auth.workspaces());
        if (result) this.createFile(result.name, result.workspaceId);
      } else {
        const name = await promptDialog('File Baru', 'Nama file, misal: Sprint 12', '', 'Buat File');
        if (name) this.createFile(name);
      }
    });
  }
};

document.addEventListener('DOMContentLoaded', () => TestCaseModule.bindStaticEvents());
