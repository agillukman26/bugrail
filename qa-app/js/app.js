/* ==========================================================
   app.js — application bootstrap: state, routing, sidebar,
   theme switching, keyboard shortcuts.
   All other js/*.js files attach to the global `App` object
   so this stays a clean, dependency-free multi-file structure
   without a bundler.
   ========================================================== */

const App = {
  state: {
    testcases: [],
    bugs: [],
    files: [],
    activityLog: [],
    settings: { theme: 'light', customFieldDefs: [] },
    currentPage: 'dashboard'
  },

  /* ---- Data load / persist ---- */
  loadAll(){
    this.state.testcases = Storage.get(STORAGE_KEYS.TESTCASES, []);
    this.state.bugs = Storage.get(STORAGE_KEYS.BUGS, []);
    this.state.files = Storage.get(STORAGE_KEYS.FILES, []);
    this.state.activityLog = Storage.get(STORAGE_KEYS.ACTIVITY_LOG, []);
    this.state.settings = Storage.get(STORAGE_KEYS.SETTINGS, { theme: 'light', customFieldDefs: [] });
    this.state.testcases.forEach(t => { if (t.status === 'Not Run') t.status = 'Open'; });
    this.ensureRoles();
    this.ensureRolePermissions();
    if (!this.state.settings.workspaces) this.state.settings.workspaces = [];
    this.ensureDefaultFile();
    IdGen.syncAllFromExisting(this.state.testcases.map(t => t.id));
    IdGen.syncFromExisting('BUG', this.state.bugs.map(b => b.id));
  },
  /* Merge default permissions into settings so newly-added permission keys
     show up on the matrix, without clobbering an admin's saved overrides. */
  ensureRolePermissions(){
    if (!this.state.settings.rolePermissions) this.state.settings.rolePermissions = {};
    Auth.customRoles().forEach(r => {
      this.state.settings.rolePermissions[r.value] = { ...(Auth.DEFAULT_ROLE_PERMISSIONS[r.value] || {}), ...(this.state.settings.rolePermissions[r.value] || {}) };
    });
  },
  /* First load: seed settings.roles from the legacy hardcoded list so existing
     accounts keep working; from then on roles are managed entirely from the UI. */
  ensureRoles(){
    if (!this.state.settings.roles) this.state.settings.roles = Auth.DEFAULT_ROLES.slice();
  },
  /* Test cases created before file grouping existed (or imported without one)
     fall back into an auto-created "Default" file. */
  ensureDefaultFile(){
    const needsDefault = this.state.testcases.some(t => !t.fileId) || this.state.bugs.some(b => !b.fileId);
    if (!needsDefault) return;
    let def = this.state.files.find(f => f.id === 'FILE-DEFAULT');
    if (!def){
      def = { id: 'FILE-DEFAULT', name: 'Default', createdAt: nowISO() };
      this.state.files.unshift(def);
      this.saveFiles();
    }
    this.state.testcases.forEach(t => { if (!t.fileId) t.fileId = def.id; });
    this.state.bugs.forEach(b => { if (!b.fileId) b.fileId = def.id; });
    this.saveTestcases();
    this.saveBugs();
  },
  saveTestcases(){ Storage.set(STORAGE_KEYS.TESTCASES, this.state.testcases); this.onDataChanged(); },
  saveBugs(){ Storage.set(STORAGE_KEYS.BUGS, this.state.bugs); this.onDataChanged(); },
  saveFiles(){ Storage.set(STORAGE_KEYS.FILES, this.state.files); },
  saveActivityLog(){ Storage.set(STORAGE_KEYS.ACTIVITY_LOG, this.state.activityLog); },
  saveSettings(){ Storage.set(STORAGE_KEYS.SETTINGS, this.state.settings); },

  /* Called after any mutation — keeps sidebar counts & any open
     dashboard/summary views in sync (simple pub/sub substitute). */
  onDataChanged(){
    this.renderSidebarCounts();
    if (this.state.currentPage === 'dashboard') Dashboard.render();
    if (this.state.currentPage === 'summary') Summary.render();
  },

  /* ---- Routing (simple show/hide, no history API needed offline) ---- */
  goTo(page){
    this.state.currentPage = page;
    sessionStorage.setItem(this.LAST_PAGE_KEY, page);
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.nav-item, .nav-subitem').forEach(n => n.classList.remove('active'));
    const pageEl = document.getElementById(`page-${page}`);
    const navEl = document.querySelector(`.nav-item[data-page="${page}"], .nav-subitem[data-page="${page}"]`);
    if (pageEl) pageEl.classList.add('active');
    if (navEl){
      navEl.classList.add('active');
      const group = navEl.closest('.nav-group');
      if (group) group.classList.add('open');
    }

    const fabWrap = document.getElementById('fabWrap');
    if (fabWrap){
      fabWrap.classList.remove('open');
      fabWrap.style.display = (page === 'dashboard' || page === 'summary') ? 'flex' : 'none';
    }

    const titles = {
      dashboard: ['Dashboard', 'Ringkasan status pengujian & bug secara realtime'],
      testcase: ['Test Case', 'Kelola skenario pengujian'],
      bugreport: ['Bug Report', 'Laporan bug terintegrasi dengan Test Case'],
      summary: ['Summary', 'Rekap progres testing & bug'],
      importexport: ['Import & Export', 'Import Test Case, export data, backup & restore'],
      usermanagement: ['User Management', 'Kelola akun login (Admin & User)'],
      rolepermission: ['Role Permission', 'Atur hak akses tiap role'],
      settings: ['Settings', 'Preferensi aplikasi & data'],
      masterstatus: ['Status Bug Report', 'Master data status bug report'],
      activitylog: ['Activity Log', 'Riwayat aktivitas user dari login sampai logout']
    };
    const [t, s] = titles[page] || [page, ''];
    document.getElementById('pageTitle').textContent = t;
    document.getElementById('pageSub').textContent = s;

    // Lazy render per page so tables always reflect the latest data.
    if (page === 'dashboard') Dashboard.render();
    if (page === 'testcase') TestCaseModule.render();
    if (page === 'bugreport') BugReportModule.render();
    if (page === 'summary') Summary.render();
    if (page === 'masterstatus') MasterStatusModule.render();
    if (page === 'activitylog') ActivityLogModule.render();

    document.getElementById('sidebar').classList.remove('open');
  },

  /* Hides sidebar entries the current role can't use. Role Permission stays
     admin-only always (managing roles/permissions is a superadmin action). */
  applyNavPermissions(){
    const setVisible = (page, visible) => {
      const el = document.querySelector(`.nav-item[data-page="${page}"], .nav-subitem[data-page="${page}"]`);
      if (el) el.style.display = visible ? '' : 'none';
    };
    setVisible('dashboard', Auth.can('dashboard'));
    setVisible('summary', Auth.can('summary'));
    setVisible('testcase', Auth.can('testcase_read'));
    setVisible('bugreport', Auth.can('bugreport_read'));
    setVisible('masterstatus', Auth.can('master'));
    setVisible('usermanagement', Auth.can('usermanagement'));
    setVisible('rolepermission', Auth.isAdmin());
    setVisible('workspace', Auth.isAdmin());
    setVisible('settings', Auth.can('settings'));
    setVisible('activitylog', Auth.can('activitylog'));
    const masterGroup = document.getElementById('navGroupMaster');
    if (masterGroup) masterGroup.style.display = Auth.can('master') ? '' : 'none';
    const userMgmtGroup = document.getElementById('navGroupUserManagement');
    if (userMgmtGroup) userMgmtGroup.style.display = (Auth.can('usermanagement') || Auth.isAdmin()) ? '' : 'none';
  },

  renderSidebarCounts(){
    const tcOpen = this.state.testcases.length;
    const bugOpen = this.state.bugs.filter(b => b.status !== 'Closed').length;
    const tcCountEl = document.querySelector('[data-count="testcase"]');
    const bugCountEl = document.querySelector('[data-count="bugreport"]');
    if (tcCountEl) tcCountEl.textContent = tcOpen;
    if (bugCountEl) bugCountEl.textContent = bugOpen;
  },

  /* ---- Theme ---- */
  applyTheme(){
    document.documentElement.setAttribute('data-theme', this.state.settings.theme);
    const label = document.getElementById('themeLabel');
    if (label) label.textContent = this.state.settings.theme === 'dark' ? 'Dark Mode' : 'Light Mode';
    const icon = document.getElementById('themeIcon');
    if (icon) icon.textContent = this.state.settings.theme === 'dark' ? '🌙' : '☀️';
  },
  toggleTheme(){
    this.state.settings.theme = this.state.settings.theme === 'dark' ? 'light' : 'dark';
    this.saveSettings();
    this.applyTheme();
  },

  /* ---- Init ---- */
  init(){
    this.loadAll();
    this.applyTheme();
    this.renderSidebarCounts();
    this.applyNavPermissions();

    const closeSidebar = () => {
      document.getElementById('sidebar').classList.remove('open');
      document.getElementById('sidebarBackdrop').classList.remove('open');
    };
    document.querySelectorAll('.nav-item').forEach(item => {
      if (item.classList.contains('nav-group-toggle')){
        item.addEventListener('click', () => item.closest('.nav-group').classList.toggle('open'));
        return;
      }
      item.addEventListener('click', () => { this.goTo(item.dataset.page); closeSidebar(); });
    });
    document.querySelectorAll('.nav-subitem').forEach(item => {
      item.addEventListener('click', () => { this.goTo(item.dataset.page); closeSidebar(); });
    });
    document.getElementById('themeToggleBtn').addEventListener('click', () => this.toggleTheme());
    document.getElementById('hamburgerBtn').addEventListener('click', () => {
      document.getElementById('sidebar').classList.toggle('open');
      document.getElementById('sidebarBackdrop').classList.toggle('open');
    });
    document.getElementById('sidebarBackdrop').addEventListener('click', closeSidebar);

    // Generic toolbar dropdowns (Filter / Export buttons) — click toggles, outside click closes.
    document.querySelectorAll('.dropdown > button').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const dd = btn.closest('.dropdown');
        document.querySelectorAll('.dropdown.open').forEach(o => { if (o !== dd) o.classList.remove('open'); });
        dd.classList.toggle('open');
      });
    });
    document.querySelectorAll('.dropdown .dropdown-item').forEach(item => {
      item.addEventListener('click', () => item.closest('.dropdown').classList.remove('open'));
    });
    document.addEventListener('click', e => {
      document.querySelectorAll('.dropdown.open').forEach(dd => { if (!dd.contains(e.target)) dd.classList.remove('open'); });
    });

    // Global realtime search (topbar) — routes to whichever module owns the current page.
    const globalSearch = document.getElementById('globalSearch');
    globalSearch.addEventListener('input', debounce(e => {
      const term = e.target.value.trim();
      if (this.state.currentPage === 'testcase') TestCaseModule.setSearch(term);
      if (this.state.currentPage === 'bugreport') BugReportModule.setSearch(term);
    }, 200));

    // Keyboard shortcuts: N = new item on current page, Ctrl/Cmd+S = manual "save" toast (data is autosaved).
    document.addEventListener('keydown', e => {
      const typing = ['INPUT','TEXTAREA','SELECT'].includes(document.activeElement.tagName);
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's'){
        e.preventDefault();
        Toast.show('Semua perubahan tersimpan otomatis di Local Storage.', 'success');
      }
      if (!typing && e.key.toLowerCase() === 'n'){
        if (this.state.currentPage === 'testcase'){
          if (TestCaseModule.ui.activeFileId) TestCaseModule.openForm();
          else Toast.show('Buka atau buat file dulu sebelum menambah test case.', 'info');
        }
        if (this.state.currentPage === 'bugreport') BugReportModule.openForm();
      }
      if (!typing && e.key === '/'){
        e.preventDefault();
        globalSearch.focus();
      }
    });

    this.goTo(this.restorePage());
  },

  /* Pages gated purely by Auth.can(); rolepermission/workspace (admin-only)
     and importexport (no gate) are checked separately in canAccessPage(). */
  PAGE_PERMISSIONS: {
    dashboard: 'dashboard', summary: 'summary', testcase: 'testcase_read',
    bugreport: 'bugreport_read', masterstatus: 'master', usermanagement: 'usermanagement', settings: 'settings',
    activitylog: 'activitylog'
  },
  canAccessPage(page){
    if (page === 'rolepermission' || page === 'workspace') return Auth.isAdmin();
    if (page === 'importexport') return true;
    const perm = this.PAGE_PERMISSIONS[page];
    return perm ? Auth.can(perm) : false;
  },
  firstAllowedPage(){
    const order = ['dashboard','summary','testcase','bugreport'];
    return order.find(p => this.canAccessPage(p)) || 'dashboard';
  },
  /* Reload lands back on whatever page the user had open (see goTo's
     sessionStorage write below), falling back to the first allowed page
     if that page no longer exists or the role can't access it anymore. */
  LAST_PAGE_KEY: 'qa_last_page',
  restorePage(){
    const saved = sessionStorage.getItem(this.LAST_PAGE_KEY);
    return (saved && document.getElementById(`page-${saved}`) && this.canAccessPage(saved)) ? saved : this.firstAllowedPage();
  }
};

/* App.init() is triggered by Auth once a role (Admin/User) is chosen — see auth.js. */
