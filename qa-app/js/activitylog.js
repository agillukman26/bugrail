/* ==========================================================
   activitylog.js — audit trail: login/logout + CRUD on Test
   Case, Bug Report, File, User, Role, Workspace.
   ActivityLog.record() is called from auth.js and every CRUD
   call site (see the design spec for the full list). Capped
   at 1000 entries (FIFO) so the stored blob stays small.
   ========================================================== */

const ActivityLog = {
  MAX_ENTRIES: 1000,

  /* Pure — keeps only the most recent MAX_ENTRIES entries. Exported so
     selfTest() can verify the cap without touching App.state/Storage. */
  trim(entries){
    return entries.length > this.MAX_ENTRIES ? entries.slice(entries.length - this.MAX_ENTRIES) : entries;
  },

  record(action, label){
    const entry = {
      id: 'LOG-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
      ts: nowISO(),
      actorEmail: Auth.currentEmail(),
      actorRole: Auth.role(),
      workspaceId: Auth.currentWorkspaceId(),
      action,
      label
    };
    App.state.activityLog = this.trim([...(App.state.activityLog || []), entry]);
    App.saveActivityLog();
  },

  /* ---- Self-check for the pure trim() logic.
     Run manually from the browser console: ActivityLog.selfTest() ---- */
  selfTest(){
    let pass = 0, total = 0;
    const check = (label, cond) => {
      total++;
      if (cond) pass++; else console.error('FAIL:', label);
    };
    const small = [{ id: 1 }, { id: 2 }, { id: 3 }];
    check('trim() is a no-op under the cap', this.trim(small).length === 3);
    const over = Array.from({ length: this.MAX_ENTRIES + 10 }, (_, i) => ({ id: i }));
    const trimmed = this.trim(over);
    check('trim() caps at MAX_ENTRIES', trimmed.length === this.MAX_ENTRIES);
    check('trim() keeps the newest entries', trimmed[trimmed.length - 1].id === this.MAX_ENTRIES + 9);
    check('trim() drops the oldest entries', trimmed[0].id === 10);
    console.log(`ActivityLog self-test: ${pass}/${total} passed`);
    return pass === total;
  }
};

const ActivityLogModule = {
  ui: { search: '', filters: { user: '', actionGroup: '' }, page: 1, pageSize: 20 },

  /* Maps an entry's `action` code to the Filter dropdown's group value. */
  actionGroupOf(action){
    if (action === 'login' || action === 'logout') return 'auth';
    if (action.startsWith('testcase_')) return 'testcase';
    if (action.startsWith('bugreport_')) return 'bugreport';
    if (action.startsWith('tc_file_') || action.startsWith('bug_file_')) return 'file';
    if (action.startsWith('user_') || action.startsWith('role_') || action.startsWith('workspace_')) return 'usermanagement';
    return 'other';
  },

  all(){ return App.state.activityLog.slice().sort((a, b) => b.ts.localeCompare(a.ts)); },

  filtered(){
    const { search, filters } = this.ui;
    return this.all().filter(e => {
      if (filters.user && e.actorEmail !== filters.user) return false;
      if (filters.actionGroup && this.actionGroupOf(e.action) !== filters.actionGroup) return false;
      if (search){
        const hay = `${e.actorEmail} ${e.label}`.toLowerCase();
        const words = search.toLowerCase().trim().split(/\s+/).filter(Boolean);
        if (!words.every(w => hay.includes(w))) return false;
      }
      return true;
    });
  },

  uniqueUsers(){ return [...new Set(this.all().map(e => e.actorEmail).filter(Boolean))].sort(); },

  render(){
    if (!Auth.can('activitylog')){
      document.getElementById('page-activitylog').innerHTML = `<p class="text-faint" style="padding:24px 0; text-align:center;">Anda tidak punya akses ke halaman ini.</p>`;
      return;
    }
    this.renderFilterOptions();
    const rows = this.filtered();
    const total = rows.length;
    const totalPages = Math.max(1, Math.ceil(total / this.ui.pageSize));
    if (this.ui.page > totalPages) this.ui.page = totalPages;
    const start = (this.ui.page - 1) * this.ui.pageSize;
    const pageRows = rows.slice(start, start + this.ui.pageSize);

    document.getElementById('alEmptyState').style.display = total ? 'none' : 'flex';
    document.getElementById('alTableWrap').style.display = total ? 'block' : 'none';

    document.getElementById('alTableBody').innerHTML = pageRows.map(e => `
      <tr class="al-row" data-id="${escapeHtml(e.id)}" style="cursor:pointer;">
        <td class="text-dim" style="white-space:nowrap;">${formatDateTime(e.ts)}</td>
        <td class="truncate" style="max-width:180px;" title="${escapeHtml(e.actorEmail || '-')}">${escapeHtml(e.actorEmail || '-')}</td>
        <td>${escapeHtml(e.actorRole || '-')}</td>
        <td><span class="badge st-notrun">${escapeHtml(e.action)}</span></td>
        <td class="truncate" style="max-width:280px;" title="${escapeHtml(e.label)}">${escapeHtml(e.label)}</td>
      </tr>
    `).join('');
    document.querySelectorAll('#alTableBody .al-row').forEach(row => {
      row.addEventListener('click', () => this.openDetail(row.dataset.id));
    });

    document.getElementById('alResultInfo').textContent = `Menampilkan ${pageRows.length} dari ${total} aktivitas`;
    this.renderPagination(totalPages);
  },

  openDetail(id){
    const entry = this.all().find(e => e.id === id);
    if (!entry) return;
    const field = (label, value) => `
      <div class="bug-side-field">
        <div class="bug-side-label">${label}</div>
        <div class="bug-side-value">${value}</div>
      </div>`;
    document.getElementById('alDetailBody').innerHTML = `
      <div style="display:flex; flex-direction:column; gap:14px;">
        ${field('Waktu', formatDateTime(entry.ts))}
        ${field('User', escapeHtml(entry.actorEmail || '-'))}
        ${field('Role', escapeHtml(entry.actorRole || '-'))}
        ${field('Workspace', escapeHtml((Auth.findWorkspace(entry.workspaceId) || {}).name || '(Semua / Shared)'))}
        ${field('Jenis Aksi', `<span class="badge st-notrun">${escapeHtml(entry.action)}</span>`)}
        ${field('Detail', escapeHtml(entry.label))}
      </div>`;
    document.getElementById('alDetailModalOverlay').classList.add('active');
  },

  renderFilterOptions(){
    const el = document.getElementById('alFilterUser');
    const current = this.ui.filters.user;
    el.innerHTML = `<option value="">Semua User</option>` +
      this.uniqueUsers().map(u => `<option value="${escapeHtml(u)}" ${u === current ? 'selected' : ''}>${escapeHtml(u)}</option>`).join('');
  },

  resetFilters(){
    this.ui.filters = { user: '', actionGroup: '' };
    this.ui.page = 1;
    document.getElementById('alFilterAction').value = '';
    this.render();
  },

  renderPagination(totalPages){
    const el = document.getElementById('alPagination');
    let html = `<button ${this.ui.page === 1 ? 'disabled' : ''} data-pg="prev">‹</button>`;
    for (let i = 1; i <= totalPages; i++){
      if (totalPages > 7 && Math.abs(i - this.ui.page) > 2 && i !== 1 && i !== totalPages){
        if (i === 2 || i === totalPages - 1) html += `<span>…</span>`;
        continue;
      }
      html += `<button class="${i === this.ui.page ? 'active' : ''}" data-pg="${i}">${i}</button>`;
    }
    html += `<button ${this.ui.page === totalPages ? 'disabled' : ''} data-pg="next">›</button>`;
    el.innerHTML = html;
    el.querySelectorAll('button[data-pg]').forEach(b => b.addEventListener('click', () => {
      const v = b.dataset.pg;
      if (v === 'prev') this.ui.page--;
      else if (v === 'next') this.ui.page++;
      else this.ui.page = parseInt(v, 10);
      this.render();
    }));
  },

  exportColumns(){
    return [
      { key: 'ts', label: 'Waktu', width: 20 },
      { key: 'actorEmail', label: 'User', width: 26 },
      { key: 'actorRole', label: 'Role', width: 16 },
      { key: 'action', label: 'Aksi', width: 20 },
      { key: 'label', label: 'Detail', width: 44 }
    ];
  },

  async exportExcel(){
    const cols = this.exportColumns();
    const rows = this.filtered().map(e => ({ ...e, ts: formatDateTime(e.ts) }));

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Activity Log');
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
    ws.views = [{ state: 'frozen', ySplit: 1 }];

    const buf = await wb.xlsx.writeBuffer();
    downloadBlob(buf, `ActivityLog_${todayISO()}.xlsx`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    Toast.show('Export Excel Activity Log berhasil.', 'success');
  },

  exportCSV(){
    const cols = this.exportColumns();
    const rows = this.filtered().map(e => ({ ...e, ts: formatDateTime(e.ts) }));
    downloadBlob(arrayToCSV(rows, cols), `ActivityLog_${todayISO()}.csv`, 'text/csv');
    Toast.show('Export CSV Activity Log berhasil.', 'success');
  },

  bindStaticEvents(){
    document.getElementById('alSearchInput').addEventListener('input', debounce(e => {
      this.ui.search = e.target.value; this.ui.page = 1; this.render();
    }, 200));
    document.getElementById('alFilterUser').addEventListener('change', e => {
      this.ui.filters.user = e.target.value; this.ui.page = 1; this.render();
    });
    document.getElementById('alFilterAction').addEventListener('change', e => {
      this.ui.filters.actionGroup = e.target.value; this.ui.page = 1; this.render();
    });
    document.getElementById('alFilterResetBtn').addEventListener('click', () => this.resetFilters());
    document.getElementById('alExportExcelBtn').addEventListener('click', () => this.exportExcel());
    document.getElementById('alExportCsvBtn').addEventListener('click', () => this.exportCSV());
  }
};

document.addEventListener('DOMContentLoaded', () => ActivityLogModule.bindStaticEvents());
