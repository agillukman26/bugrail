# Activity Log Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an admin-configurable Activity Log page that records login/logout and CRUD on Test Case, Bug Report, File, User, Role, and Workspace, so admins can see who did what and when.

**Architecture:** A single new module (`ActivityLog` recorder + `ActivityLogModule` page UI, both in `qa-app/js/activitylog.js`) that other modules call into via `ActivityLog.record(action, label)` at each CRUD call site. Entries persist through the existing `Storage`/`kv_store` sync pipeline under a new key, capped at 1000 entries (FIFO). Access is gated by a new `activitylog` permission key, following the exact pattern already used for every other page/permission in this app.

**Tech Stack:** Vanilla JS (no build step, no bundler — every `.js` file is loaded via a `<script>` tag in `index.html` and attaches to global objects), ExcelJS (already loaded via CDN) for Excel export, Node's `node --check` for syntax validation (this repo has no test runner or framework).

**Spec:** `docs/superpowers/specs/2026-09-18-activity-log-design.md`

## Global Constraints

- Cap the log at the most recent **1000** entries (FIFO) — every `ActivityLog.record()` call must enforce this, not just the UI.
- Do NOT log: theme toggle, translate, duplicate, import/export actions, settings/custom-field changes, master status CRUD (explicitly out of scope per spec).
- New permission key `activitylog` is **not** added to any role in `DEFAULT_ROLE_PERMISSIONS` — it's opt-in per role from the Role Permission page, same as any newly introduced key.
- This app has no test framework. "Test" steps below are `node --check <file>` for syntax (mechanical, always do this after editing a `.js` file) plus manual browser verification steps (which a human or the reviewing agent must actually perform against a running instance — see each task's Step for exact console commands / UI actions to run).
- Every edited `.js` file that is `<script src="...">`-tagged in `qa-app/index.html` has a `?v=N` cache-bust query string. Bump it by 1 whenever that file is modified in a task (the current values are called out per task below — re-check with `grep -n "js/<file>.js" qa-app/index.html` before bumping, in case a prior task already bumped it).

---

### Task 1: Storage plumbing + backend allowlist

**Files:**
- Modify: `qa-app/js/utils.js` (STORAGE_KEYS block, ~line 8-15)
- Modify: `qa-app/js/app.js` (`state`, `loadAll()`, add `saveActivityLog()`, ~lines 9-31 and 61-64)
- Modify: `server/server.js` (`ALLOWED_KEYS`, line 6)
- Modify: `qa-app/index.html` (bump `js/app.js` and `js/utils.js` version query strings)

**Interfaces:**
- Produces: `STORAGE_KEYS.ACTIVITY_LOG` (string constant `'qa_activity_log'`), `App.state.activityLog` (array, loaded on boot), `App.saveActivityLog()` (persists `App.state.activityLog` — takes no args, mirrors `App.saveFiles()`).

- [ ] **Step 1: Add the storage key**

In `qa-app/js/utils.js`, find:
```js
const STORAGE_KEYS = {
  TESTCASES: 'qa_testcases',
  BUGS: 'qa_bugs',
  FILES: 'qa_files', // Test Case grouping ("file"/folder)
  SETTINGS: 'qa_settings',
  COUNTERS: 'qa_counters',
  TRASH: 'qa_trash' // holds last deleted item(s) for Undo
};
```
Replace with:
```js
const STORAGE_KEYS = {
  TESTCASES: 'qa_testcases',
  BUGS: 'qa_bugs',
  FILES: 'qa_files', // Test Case grouping ("file"/folder)
  SETTINGS: 'qa_settings',
  COUNTERS: 'qa_counters',
  TRASH: 'qa_trash', // holds last deleted item(s) for Undo
  ACTIVITY_LOG: 'qa_activity_log' // audit trail: login/logout + CRUD, capped at 1000 entries
};
```

- [ ] **Step 2: Add `activityLog` to App state and load it on boot**

In `qa-app/js/app.js`, find:
```js
const App = {
  state: {
    testcases: [],
    bugs: [],
    files: [],
    settings: { theme: 'light', customFieldDefs: [] },
    currentPage: 'dashboard'
  },

  /* ---- Data load / persist ---- */
  loadAll(){
    this.state.testcases = Storage.get(STORAGE_KEYS.TESTCASES, []);
    this.state.bugs = Storage.get(STORAGE_KEYS.BUGS, []);
    this.state.files = Storage.get(STORAGE_KEYS.FILES, []);
    this.state.settings = Storage.get(STORAGE_KEYS.SETTINGS, { theme: 'light', customFieldDefs: [] });
```
Replace with:
```js
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
```
(Leave the rest of `loadAll()` — the lines after `this.state.settings = ...` — untouched.)

- [ ] **Step 3: Add `saveActivityLog()`**

In `qa-app/js/app.js`, find:
```js
  saveTestcases(){ Storage.set(STORAGE_KEYS.TESTCASES, this.state.testcases); this.onDataChanged(); },
  saveBugs(){ Storage.set(STORAGE_KEYS.BUGS, this.state.bugs); this.onDataChanged(); },
  saveFiles(){ Storage.set(STORAGE_KEYS.FILES, this.state.files); },
  saveSettings(){ Storage.set(STORAGE_KEYS.SETTINGS, this.state.settings); },
```
Replace with:
```js
  saveTestcases(){ Storage.set(STORAGE_KEYS.TESTCASES, this.state.testcases); this.onDataChanged(); },
  saveBugs(){ Storage.set(STORAGE_KEYS.BUGS, this.state.bugs); this.onDataChanged(); },
  saveFiles(){ Storage.set(STORAGE_KEYS.FILES, this.state.files); },
  saveActivityLog(){ Storage.set(STORAGE_KEYS.ACTIVITY_LOG, this.state.activityLog); },
  saveSettings(){ Storage.set(STORAGE_KEYS.SETTINGS, this.state.settings); },
```

- [ ] **Step 4: Allow the new key through the backend**

In `server/server.js`, find:
```js
const ALLOWED_KEYS = new Set(['qa_testcases', 'qa_bugs', 'qa_files', 'qa_settings', 'qa_counters']);
```
Replace with:
```js
const ALLOWED_KEYS = new Set(['qa_testcases', 'qa_bugs', 'qa_files', 'qa_settings', 'qa_counters', 'qa_activity_log']);
```

- [ ] **Step 5: Syntax-check the edited files**

Run:
```bash
node --check qa-app/js/utils.js && node --check qa-app/js/app.js && node --check server/server.js && echo OK
```
Expected: `OK`

- [ ] **Step 6: Bump cache-bust versions in index.html**

Run this to see current versions:
```bash
grep -n "js/utils.js\|js/app.js" qa-app/index.html
```
Then increment both `?v=N` values by 1 (e.g. `js/utils.js?v=20` → `js/utils.js?v=21`, `js/app.js?v=17` → `js/app.js?v=18` — use whatever `N` the grep actually shows, since later tasks in this plan may have already bumped one of them).

- [ ] **Step 7: Manual verification**

Open the app in a browser (or via `python -m http.server` from `qa-app/` and a browser), log in, open DevTools console, and run:
```js
App.state.activityLog
```
Expected: `[]` (empty array, not `undefined`).
```js
App.saveActivityLog();
```
Expected: no error thrown, and in the Network tab a `PUT /api/kv/qa_activity_log` request returns `200` (or, if the backend isn't running locally, the app falls back to localStorage silently — either is fine at this stage, the point is no error and no 400).

- [ ] **Step 8: Commit**

```bash
git add qa-app/js/utils.js qa-app/js/app.js server/server.js qa-app/index.html
git commit -m "feat: add activity log storage key and backend allowlist entry"
```

---

### Task 2: ActivityLog recorder module + login/logout hooks

**Files:**
- Create: `qa-app/js/activitylog.js`
- Modify: `qa-app/index.html` (add script tag after `js/app.js`, before `js/auth.js`)
- Modify: `qa-app/js/auth.js` (`enter()` line ~204-212, `logout()` line ~227-232; bump its version tag)

**Interfaces:**
- Consumes: `App.state.activityLog` (array), `App.saveActivityLog()` (from Task 1), `Auth.currentEmail()`, `Auth.role()`, `Auth.currentWorkspaceId()` (all existing), `nowISO()` (existing, in `utils.js`).
- Produces: `ActivityLog.record(action, label)` — global function other modules call (Tasks 3-6 depend on this exact signature: `action` is a short string code, `label` is a ready-to-render string). `ActivityLog.trim(entries)` — pure helper, exported for the self-check and reused by `record()`. `ActivityLog.selfTest()` — console-callable self-check, same convention as `Auth.selfTest()`.

- [ ] **Step 1: Create the recorder module**

Create `qa-app/js/activitylog.js`:
```js
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
```

- [ ] **Step 2: Syntax-check it**

Run:
```bash
node --check qa-app/js/activitylog.js && echo OK
```
Expected: `OK`

- [ ] **Step 3: Load it in index.html**

In `qa-app/index.html`, find:
```html
<script src="js/utils.js?v=21"></script>
<script src="js/app.js?v=18"></script>
<script src="js/auth.js?v=17"></script>
```
(Use whatever exact `?v=N` values Task 1 left — check first with `grep -n "js/utils.js\|js/app.js\|js/auth.js" qa-app/index.html`.)

Replace with (inserting the new script tag between `app.js` and `auth.js`):
```html
<script src="js/utils.js?v=21"></script>
<script src="js/app.js?v=18"></script>
<script src="js/activitylog.js?v=1"></script>
<script src="js/auth.js?v=17"></script>
```

- [ ] **Step 4: Hook login**

In `qa-app/js/auth.js`, find:
```js
  enter(role, email, workspaceId){
    sessionStorage.setItem(this.ROLE_KEY, role);
    sessionStorage.setItem(this.EMAIL_KEY, email);
    if (workspaceId) sessionStorage.setItem(this.WORKSPACE_KEY, workspaceId);
    else sessionStorage.removeItem(this.WORKSPACE_KEY);
    document.body.classList.remove('pre-auth');
    App.init();
    this.renderBadge();
  },
```
Replace with:
```js
  enter(role, email, workspaceId){
    sessionStorage.setItem(this.ROLE_KEY, role);
    sessionStorage.setItem(this.EMAIL_KEY, email);
    if (workspaceId) sessionStorage.setItem(this.WORKSPACE_KEY, workspaceId);
    else sessionStorage.removeItem(this.WORKSPACE_KEY);
    document.body.classList.remove('pre-auth');
    App.init();
    ActivityLog.record('login', `${email} login sebagai ${role}`);
    this.renderBadge();
  },
```
(`App.init()` must run first — it calls `loadAll()`, which is what populates `App.state.activityLog` in the first place. Calling `record()` before `App.init()` would push onto an array that gets immediately overwritten.)

- [ ] **Step 5: Hook logout**

In `qa-app/js/auth.js`, find:
```js
  logout(){
    sessionStorage.removeItem(this.ROLE_KEY);
    sessionStorage.removeItem(this.EMAIL_KEY);
    sessionStorage.removeItem(this.WORKSPACE_KEY);
    location.reload();
  },
```
Replace with:
```js
  logout(){
    ActivityLog.record('logout', `${this.currentEmail()} logout`);
    sessionStorage.removeItem(this.ROLE_KEY);
    sessionStorage.removeItem(this.EMAIL_KEY);
    sessionStorage.removeItem(this.WORKSPACE_KEY);
    location.reload();
  },
```
(Record *before* clearing session storage — `currentEmail()`/`role()` read from it.)

- [ ] **Step 6: Syntax-check auth.js**

Run:
```bash
node --check qa-app/js/auth.js && echo OK
```
Expected: `OK`

- [ ] **Step 7: Bump cache-bust versions**

Run:
```bash
grep -n "js/auth.js" qa-app/index.html
```
Bump its `?v=N` by 1 (the `js/activitylog.js?v=1` tag added in Step 3 is new, so it starts at 1 and needs no bump).

- [ ] **Step 8: Manual verification**

In the browser: log out (if logged in) and back in. In DevTools console:
```js
App.state.activityLog
```
Expected: an array with at least one entry, the most recent one having `action: 'login'` and a `label` like `"admin@bugrail.local login sebagai admin"`.

Then run the self-check:
```js
ActivityLog.selfTest()
```
Expected: console logs `ActivityLog self-test: 4/4 passed` and returns `true`.

Then log out and confirm (before the page finishes reloading, or by re-opening DevTools right after reload and checking `App.state.activityLog`) that a `logout` entry was recorded with the correct email.

- [ ] **Step 9: Commit**

```bash
git add qa-app/js/activitylog.js qa-app/js/auth.js qa-app/index.html
git commit -m "feat: add ActivityLog recorder and hook login/logout"
```

---

### Task 3: Permission key, nav item, page skeleton, routing

**Files:**
- Modify: `qa-app/js/auth.js` (`PERMISSION_KEYS`, ~line 35-52)
- Modify: `qa-app/js/app.js` (`PAGE_PERMISSIONS`, `applyNavPermissions()`, `goTo()` titles map + dispatch)
- Modify: `qa-app/index.html` (nav item, new `<section class="page" id="page-activitylog">` skeleton)
- Modify: `qa-app/js/activitylog.js` (add `ActivityLogModule` with a permission-gated `render()` stub)

**Interfaces:**
- Consumes: `Auth.can(permKey)` (existing), `Auth.PERMISSION_KEYS` (existing array, appended to).
- Produces: `ActivityLogModule.render()` — called by `App.goTo('activitylog')`; Task 7 fills in its body, this task only makes it permission-gate correctly and not crash.

- [ ] **Step 1: Add the permission key**

In `qa-app/js/auth.js`, find:
```js
    { key: 'testcase_delete', label: 'Test Case — Hapus' },
    { key: 'testcase_fileShare', label: 'Test Case — Share File antar Workspace' },
```
Replace with:
```js
    { key: 'testcase_delete', label: 'Test Case — Hapus' },
    { key: 'testcase_fileShare', label: 'Test Case — Share File antar Workspace' },
    { key: 'activitylog', label: 'Activity Log (lihat)' },
```
(Do not add `activitylog` to `DEFAULT_ROLE_PERMISSIONS` — it's opt-in per the design spec.)

- [ ] **Step 2: Add to the page-permission map**

In `qa-app/js/app.js`, find:
```js
  PAGE_PERMISSIONS: {
    dashboard: 'dashboard', summary: 'summary', testcase: 'testcase_read',
    bugreport: 'bugreport_read', masterstatus: 'master', usermanagement: 'usermanagement', settings: 'settings'
  },
```
Replace with:
```js
  PAGE_PERMISSIONS: {
    dashboard: 'dashboard', summary: 'summary', testcase: 'testcase_read',
    bugreport: 'bugreport_read', masterstatus: 'master', usermanagement: 'usermanagement', settings: 'settings',
    activitylog: 'activitylog'
  },
```

- [ ] **Step 3: Show/hide the nav item by permission**

In `qa-app/js/app.js`, find:
```js
    setVisible('settings', Auth.can('settings'));
```
Replace with:
```js
    setVisible('settings', Auth.can('settings'));
    setVisible('activitylog', Auth.can('activitylog'));
```

- [ ] **Step 4: Add the page title and routing dispatch**

In `qa-app/js/app.js`, find:
```js
      settings: ['Settings', 'Preferensi aplikasi & data'],
      masterstatus: ['Status Bug Report', 'Master data status bug report']
    };
```
Replace with:
```js
      settings: ['Settings', 'Preferensi aplikasi & data'],
      masterstatus: ['Status Bug Report', 'Master data status bug report'],
      activitylog: ['Activity Log', 'Riwayat aktivitas user dari login sampai logout']
    };
```

Then find:
```js
    if (page === 'masterstatus') MasterStatusModule.render();
```
Replace with:
```js
    if (page === 'masterstatus') MasterStatusModule.render();
    if (page === 'activitylog') ActivityLogModule.render();
```

- [ ] **Step 5: Add the nav item**

In `qa-app/index.html`, find:
```html
      <div class="nav-item" data-page="settings"><span class="icon">⚙</span> Settings</div>
```
Replace with:
```html
      <div class="nav-item" data-page="settings"><span class="icon">⚙</span> Settings</div>
      <div class="nav-item" data-page="activitylog"><span class="icon">🕒</span> Activity Log</div>
```

- [ ] **Step 6: Add the page section skeleton**

In `qa-app/index.html`, find:
```html
          <div class="table-wrap">
            <table class="data-table" id="workspaceTable">
              <thead><tr><th>Nama Workspace</th><th>Jumlah User</th><th>Jumlah File</th><th style="width:90px;">Aksi</th></tr></thead>
              <tbody id="workspaceTableBody"></tbody>
            </table>
          </div>
        </div>
      </section>

      <!-- ============ USER MANAGEMENT ============ -->
```
Replace with:
```html
          <div class="table-wrap">
            <table class="data-table" id="workspaceTable">
              <thead><tr><th>Nama Workspace</th><th>Jumlah User</th><th>Jumlah File</th><th style="width:90px;">Aksi</th></tr></thead>
              <tbody id="workspaceTableBody"></tbody>
            </table>
          </div>
        </div>
      </section>

      <!-- ============ ACTIVITY LOG ============ -->
      <section class="page" id="page-activitylog"></section>

      <!-- ============ USER MANAGEMENT ============ -->
```
(Left empty on purpose — Task 7 fills it with the real toolbar/table/pagination markup. This task only needs the container to exist so `ActivityLogModule.render()` has somewhere to write the access-denied message.)

- [ ] **Step 7: Add the permission-gated `render()` stub**

In `qa-app/js/activitylog.js`, add this below the closing `};` of the `ActivityLog` object (i.e. as a new top-level `const` in the same file):
```js
const ActivityLogModule = {
  render(){
    if (!Auth.can('activitylog')){
      document.getElementById('page-activitylog').innerHTML = `<p class="text-faint" style="padding:24px 0; text-align:center;">Anda tidak punya akses ke halaman ini.</p>`;
      return;
    }
    // Task 7 replaces this with the real table/filter/pagination/export UI.
    document.getElementById('page-activitylog').innerHTML = `<p class="text-faint" style="padding:24px 0; text-align:center;">Activity Log — ${App.state.activityLog.length} entri tercatat.</p>`;
  }
};
```

- [ ] **Step 8: Syntax-check everything touched**

Run:
```bash
node --check qa-app/js/auth.js && node --check qa-app/js/app.js && node --check qa-app/js/activitylog.js && echo OK
```
Expected: `OK`

- [ ] **Step 9: Bump cache-bust versions**

Run:
```bash
grep -n "js/auth.js\|js/app.js\|js/activitylog.js" qa-app/index.html
```
Bump `js/auth.js` and `js/app.js` `?v=N` by 1 each; bump `js/activitylog.js` from `?v=1` to `?v=2` (it changed in this task too).

- [ ] **Step 10: Manual verification**

As an admin (or any role with `activitylog` checked in Role Permission — check the checkbox from the Role Permission page first, since it's opt-in per Step 1): reload the app, confirm an "Activity Log" nav item with a 🕒 icon appears, click it, confirm it shows `Activity Log — N entri tercatat.` with `N` matching however many login/logout entries exist so far.

As a role WITHOUT `activitylog` permission: confirm the nav item does not appear. Manually navigate with `App.goTo('activitylog')` from the console and confirm it shows "Anda tidak punya akses ke halaman ini." instead of throwing an error.

- [ ] **Step 11: Commit**

```bash
git add qa-app/js/auth.js qa-app/js/app.js qa-app/js/activitylog.js qa-app/index.html
git commit -m "feat: add activitylog permission, nav item, and page routing"
```

---

### Task 4: Hook CRUD logging in testcase.js

**Files:**
- Modify: `qa-app/js/testcase.js` (`submitForm`, `remove`, `bulkDelete`, `createFile`, `renameFile`, `deleteFile`, `shareFile`)

**Interfaces:**
- Consumes: `ActivityLog.record(action, label)` (from Task 2).

- [ ] **Step 1: Log test case create/update**

In `qa-app/js/testcase.js`, find:
```js
    if (this.ui.editingId){
      const idx = App.state.testcases.findIndex(t => t.id === this.ui.editingId);
      App.state.testcases[idx] = { ...App.state.testcases[idx], ...data };
      Toast.show(`Test case ${this.ui.editingId} diperbarui.`, 'success');
    } else {
      const id = IdGen.next(moduleAbbrev(data.module));
      App.state.testcases.push({ id, ...data, fileId: this.ui.activeFileId, createdAt: nowISO() });
      Toast.show(`Test case ${id} dibuat.`, 'success');
    }
    App.saveTestcases();
```
Replace with:
```js
    if (this.ui.editingId){
      const idx = App.state.testcases.findIndex(t => t.id === this.ui.editingId);
      App.state.testcases[idx] = { ...App.state.testcases[idx], ...data };
      ActivityLog.record('testcase_update', `Test Case ${this.ui.editingId} diperbarui`);
      Toast.show(`Test case ${this.ui.editingId} diperbarui.`, 'success');
    } else {
      const id = IdGen.next(moduleAbbrev(data.module));
      App.state.testcases.push({ id, ...data, fileId: this.ui.activeFileId, createdAt: nowISO() });
      ActivityLog.record('testcase_create', `Test Case ${id} dibuat`);
      Toast.show(`Test case ${id} dibuat.`, 'success');
    }
    App.saveTestcases();
```

- [ ] **Step 2: Log test case delete**

In `qa-app/js/testcase.js`, find:
```js
  async remove(id){
    if (!Auth.can('testcase_delete')) return;
    const ok = await confirmDialog('Hapus Test Case?', `${id} akan dihapus. Tindakan ini dapat di-undo sebentar.`);
    if (!ok) return;
    const idx = App.state.testcases.findIndex(t => t.id === id);
    const removed = App.state.testcases.splice(idx, 1)[0];
    App.saveTestcases();
```
Replace with:
```js
  async remove(id){
    if (!Auth.can('testcase_delete')) return;
    const ok = await confirmDialog('Hapus Test Case?', `${id} akan dihapus. Tindakan ini dapat di-undo sebentar.`);
    if (!ok) return;
    const idx = App.state.testcases.findIndex(t => t.id === id);
    const removed = App.state.testcases.splice(idx, 1)[0];
    ActivityLog.record('testcase_delete', `Test Case ${id} dihapus`);
    App.saveTestcases();
```

- [ ] **Step 3: Log bulk delete (single summarized entry)**

In `qa-app/js/testcase.js`, find:
```js
  async bulkDelete(){
    if (!this.ui.selected.size || !Auth.can('testcase_delete')) return;
    const ids = [...this.ui.selected];
    const ok = await confirmDialog('Hapus Test Case Terpilih?', `${ids.length} test case akan dihapus.`);
    if (!ok) return;
    const removed = App.state.testcases.filter(t => ids.includes(t.id));
    App.state.testcases = App.state.testcases.filter(t => !ids.includes(t.id));
    App.saveTestcases();
```
Replace with:
```js
  async bulkDelete(){
    if (!this.ui.selected.size || !Auth.can('testcase_delete')) return;
    const ids = [...this.ui.selected];
    const ok = await confirmDialog('Hapus Test Case Terpilih?', `${ids.length} test case akan dihapus.`);
    if (!ok) return;
    const removed = App.state.testcases.filter(t => ids.includes(t.id));
    App.state.testcases = App.state.testcases.filter(t => !ids.includes(t.id));
    ActivityLog.record('testcase_delete', `${ids.length} test case dihapus (bulk)`);
    App.saveTestcases();
```

- [ ] **Step 4: Log file create/rename/delete/share**

In `qa-app/js/testcase.js`, find:
```js
  createFile(name, workspaceId = Auth.currentWorkspaceId()){
    name = (name || '').trim();
    if (!name) return;
    const file = { id: 'FILE-' + Date.now(), name, workspaceId, createdAt: nowISO() };
    App.state.files.push(file);
    App.saveFiles();
    this.renderFileList();
    Toast.show(`File "${name}" dibuat.`, 'success');
  },
  renameFile(fileId, name){
    name = (name || '').trim();
    if (!name) return;
    const file = this.files().find(f => f.id === fileId);
    if (!file) return;
    file.name = name;
    App.saveFiles();
    this.render();
  },

  async shareFile(fileId){
    const file = this.files().find(f => f.id === fileId);
    if (!file) return;
    if (!Auth.canShareFile(file)){ Toast.show('Tidak punya izin share file ini.', 'error'); return; }
    const others = Auth.workspaces().filter(w => w.id !== file.workspaceId);
    const shared = new Set(file.sharedWith || []);
    const ids = await checklistDialog(`Share File "${file.name}"`,
      others.map(w => ({ id: w.id, label: w.name, checked: shared.has(w.id) })), 'Simpan Sharing');
    if (ids === null) return;
    file.sharedWith = ids;
    App.saveFiles();
    this.render();
    Toast.show(ids.length ? `File "${file.name}" dibagikan ke ${ids.length} workspace.` : `Sharing file "${file.name}" dihapus.`, 'success');
  },
  async deleteFile(fileId){
    if (!Auth.isAdmin()){ Toast.show('Hanya Admin yang dapat menghapus file.', 'error'); return; }
    const file = this.files().find(f => f.id === fileId);
    const count = this.fileCount(fileId);
    const ok = await confirmDialog('Hapus File?', `File "${file.name}" beserta ${count} test case di dalamnya akan dihapus permanen.`, 'Hapus');
    if (!ok) return;
    App.state.files = App.state.files.filter(f => f.id !== fileId);
    App.state.testcases = App.state.testcases.filter(t => t.fileId !== fileId);
    App.saveFiles();
    App.saveTestcases();
    if (this.ui.activeFileId === fileId) this.ui.activeFileId = null;
    this.render();
    Toast.show(`File "${file.name}" dihapus.`, 'info');
  },
```
Replace with:
```js
  createFile(name, workspaceId = Auth.currentWorkspaceId()){
    name = (name || '').trim();
    if (!name) return;
    const file = { id: 'FILE-' + Date.now(), name, workspaceId, createdAt: nowISO() };
    App.state.files.push(file);
    App.saveFiles();
    ActivityLog.record('tc_file_create', `File Test Case "${name}" dibuat`);
    this.renderFileList();
    Toast.show(`File "${name}" dibuat.`, 'success');
  },
  renameFile(fileId, name){
    name = (name || '').trim();
    if (!name) return;
    const file = this.files().find(f => f.id === fileId);
    if (!file) return;
    const oldName = file.name;
    file.name = name;
    App.saveFiles();
    ActivityLog.record('tc_file_rename', `File Test Case "${oldName}" diganti nama jadi "${name}"`);
    this.render();
  },

  async shareFile(fileId){
    const file = this.files().find(f => f.id === fileId);
    if (!file) return;
    if (!Auth.canShareFile(file)){ Toast.show('Tidak punya izin share file ini.', 'error'); return; }
    const others = Auth.workspaces().filter(w => w.id !== file.workspaceId);
    const shared = new Set(file.sharedWith || []);
    const ids = await checklistDialog(`Share File "${file.name}"`,
      others.map(w => ({ id: w.id, label: w.name, checked: shared.has(w.id) })), 'Simpan Sharing');
    if (ids === null) return;
    file.sharedWith = ids;
    App.saveFiles();
    ActivityLog.record('tc_file_share', ids.length
      ? `File Test Case "${file.name}" dibagikan ke ${ids.length} workspace`
      : `Sharing File Test Case "${file.name}" dihapus`);
    this.render();
    Toast.show(ids.length ? `File "${file.name}" dibagikan ke ${ids.length} workspace.` : `Sharing file "${file.name}" dihapus.`, 'success');
  },
  async deleteFile(fileId){
    if (!Auth.isAdmin()){ Toast.show('Hanya Admin yang dapat menghapus file.', 'error'); return; }
    const file = this.files().find(f => f.id === fileId);
    const count = this.fileCount(fileId);
    const ok = await confirmDialog('Hapus File?', `File "${file.name}" beserta ${count} test case di dalamnya akan dihapus permanen.`, 'Hapus');
    if (!ok) return;
    App.state.files = App.state.files.filter(f => f.id !== fileId);
    App.state.testcases = App.state.testcases.filter(t => t.fileId !== fileId);
    App.saveFiles();
    App.saveTestcases();
    ActivityLog.record('tc_file_delete', `File Test Case "${file.name}" dihapus`);
    if (this.ui.activeFileId === fileId) this.ui.activeFileId = null;
    this.render();
    Toast.show(`File "${file.name}" dihapus.`, 'info');
  },
```

- [ ] **Step 5: Syntax-check**

Run:
```bash
node --check qa-app/js/testcase.js && echo OK
```
Expected: `OK`

- [ ] **Step 6: Bump cache-bust version**

Run:
```bash
grep -n "js/testcase.js" qa-app/index.html
```
Bump its `?v=N` by 1.

- [ ] **Step 7: Manual verification**

In the browser, open Test Case, create a test case, edit it, create a file, rename it, share it (if you have `testcase_fileShare` permission), then delete both the test case and the file. After each action, check in DevTools console:
```js
App.state.activityLog.slice(-1)[0]
```
Expected: each check shows a new entry with the matching `action` code (`testcase_create`, `testcase_update`, `tc_file_create`, `tc_file_rename`, `tc_file_share`, `testcase_delete`, `tc_file_delete`) and a readable `label`.

- [ ] **Step 8: Commit**

```bash
git add qa-app/js/testcase.js qa-app/index.html
git commit -m "feat: log test case and test-case-file CRUD to activity log"
```

---

### Task 5: Hook CRUD logging in bugreport.js

**Files:**
- Modify: `qa-app/js/bugreport.js` (`submitForm`, `remove`, `bulkDelete`, `createFile`, `renameFile`, `deleteFile`, `shareFile`)

**Interfaces:**
- Consumes: `ActivityLog.record(action, label)` (from Task 2).

- [ ] **Step 1: Log bug create/update**

In `qa-app/js/bugreport.js`, find:
```js
    if (this.ui.editingId){
      const idx = App.state.bugs.findIndex(b => b.id === this.ui.editingId);
      const prev = App.state.bugs[idx];
      if (prev.status !== data.status) this.logActivity(prev, prev.status, data.status);
      App.state.bugs[idx] = { ...prev, ...data };
      Toast.show(`Bug ${this.ui.editingId} diperbarui.`, 'success');
    } else {
      const id = IdGen.next('BUG');
      App.state.bugs.push({ id, ...data, fileId: this.ui.activeFileId, reportDate: nowISO() });
      Toast.show(`Bug ${id} dibuat.`, 'success');
    }
    App.saveBugs();
```
Replace with:
```js
    if (this.ui.editingId){
      const idx = App.state.bugs.findIndex(b => b.id === this.ui.editingId);
      const prev = App.state.bugs[idx];
      if (prev.status !== data.status) this.logActivity(prev, prev.status, data.status);
      App.state.bugs[idx] = { ...prev, ...data };
      ActivityLog.record('bugreport_update', `Bug ${this.ui.editingId} diperbarui`);
      Toast.show(`Bug ${this.ui.editingId} diperbarui.`, 'success');
    } else {
      const id = IdGen.next('BUG');
      App.state.bugs.push({ id, ...data, fileId: this.ui.activeFileId, reportDate: nowISO() });
      ActivityLog.record('bugreport_create', `Bug ${id} dibuat`);
      Toast.show(`Bug ${id} dibuat.`, 'success');
    }
    App.saveBugs();
```
(`this.logActivity(...)` here is `BugReportModule`'s own per-bug status-change timeline feature — a different, pre-existing concern. Do not confuse it with the global `ActivityLog.record()` call being added.)

- [ ] **Step 2: Log bug delete**

In `qa-app/js/bugreport.js`, find:
```js
  async remove(id){
    if (!Auth.can('bugreport_delete')){ Toast.show('Tidak punya izin menghapus Bug Report.', 'error'); return; }
    const ok = await confirmDialog('Hapus Bug Report?', `${id} akan dihapus.`);
    if (!ok) return;
    const idx = App.state.bugs.findIndex(b => b.id === id);
    const removed = App.state.bugs.splice(idx,1)[0];
    App.saveBugs(); this.ui.selected.delete(id); this.render();
```
Replace with:
```js
  async remove(id){
    if (!Auth.can('bugreport_delete')){ Toast.show('Tidak punya izin menghapus Bug Report.', 'error'); return; }
    const ok = await confirmDialog('Hapus Bug Report?', `${id} akan dihapus.`);
    if (!ok) return;
    const idx = App.state.bugs.findIndex(b => b.id === id);
    const removed = App.state.bugs.splice(idx,1)[0];
    ActivityLog.record('bugreport_delete', `Bug ${id} dihapus`);
    App.saveBugs(); this.ui.selected.delete(id); this.render();
```

- [ ] **Step 3: Log bulk delete (single summarized entry)**

In `qa-app/js/bugreport.js`, find:
```js
  async bulkDelete(){
    if (!this.ui.selected.size || !Auth.can('bugreport_delete')) return;
    const ids = [...this.ui.selected];
    const ok = await confirmDialog('Hapus Bug Terpilih?', `${ids.length} bug akan dihapus.`);
    if (!ok) return;
    const removed = App.state.bugs.filter(b => ids.includes(b.id));
    App.state.bugs = App.state.bugs.filter(b => !ids.includes(b.id));
    App.saveBugs(); this.ui.selected.clear(); this.render();
```
Replace with:
```js
  async bulkDelete(){
    if (!this.ui.selected.size || !Auth.can('bugreport_delete')) return;
    const ids = [...this.ui.selected];
    const ok = await confirmDialog('Hapus Bug Terpilih?', `${ids.length} bug akan dihapus.`);
    if (!ok) return;
    const removed = App.state.bugs.filter(b => ids.includes(b.id));
    App.state.bugs = App.state.bugs.filter(b => !ids.includes(b.id));
    ActivityLog.record('bugreport_delete', `${ids.length} bug dihapus (bulk)`);
    App.saveBugs(); this.ui.selected.clear(); this.render();
```

- [ ] **Step 4: Log file create/rename/delete/share**

In `qa-app/js/bugreport.js`, find:
```js
  createFile(name, workspaceId = Auth.currentWorkspaceId()){
    name = (name || '').trim();
    if (!name) return;
    const file = { id: 'FILE-' + Date.now(), name, workspaceId, createdAt: nowISO() };
    App.state.files.push(file);
    App.saveFiles();
    this.renderFileList();
    Toast.show(`File "${name}" dibuat.`, 'success');
  },
  renameFile(fileId, name){
    name = (name || '').trim();
    if (!name) return;
    const file = this.files().find(f => f.id === fileId);
    if (!file) return;
    file.name = name;
    App.saveFiles();
    this.render();
  },
  async shareFile(fileId){
    const file = this.files().find(f => f.id === fileId);
    if (!file) return;
    if (!Auth.canShareFile(file)){ Toast.show('Tidak punya izin share file ini.', 'error'); return; }
    const others = Auth.workspaces().filter(w => w.id !== file.workspaceId);
    const shared = new Set(file.sharedWith || []);
    const ids = await checklistDialog(`Share File "${file.name}"`,
      others.map(w => ({ id: w.id, label: w.name, checked: shared.has(w.id) })), 'Simpan Sharing');
    if (ids === null) return;
    file.sharedWith = ids;
    App.saveFiles();
    this.render();
    Toast.show(ids.length ? `File "${file.name}" dibagikan ke ${ids.length} workspace.` : `Sharing file "${file.name}" dihapus.`, 'success');
  },
  async deleteFile(fileId){
    if (!Auth.isAdmin()){ Toast.show('Hanya Admin yang dapat menghapus file.', 'error'); return; }
    const file = this.files().find(f => f.id === fileId);
    const count = this.fileCount(fileId);
    const ok = await confirmDialog('Hapus File?', `File "${file.name}" beserta ${count} bug di dalamnya akan dihapus permanen.`, 'Hapus');
    if (!ok) return;
    App.state.files = App.state.files.filter(f => f.id !== fileId);
    App.state.bugs = App.state.bugs.filter(b => b.fileId !== fileId);
    App.saveFiles();
    App.saveBugs();
    if (this.ui.activeFileId === fileId){ this.ui.activeFileId = null; sessionStorage.removeItem('qa_bug_active_file'); }
    this.render();
    Toast.show(`File "${file.name}" dihapus.`, 'info');
  },
```
Replace with:
```js
  createFile(name, workspaceId = Auth.currentWorkspaceId()){
    name = (name || '').trim();
    if (!name) return;
    const file = { id: 'FILE-' + Date.now(), name, workspaceId, createdAt: nowISO() };
    App.state.files.push(file);
    App.saveFiles();
    ActivityLog.record('bug_file_create', `File Bug Report "${name}" dibuat`);
    this.renderFileList();
    Toast.show(`File "${name}" dibuat.`, 'success');
  },
  renameFile(fileId, name){
    name = (name || '').trim();
    if (!name) return;
    const file = this.files().find(f => f.id === fileId);
    if (!file) return;
    const oldName = file.name;
    file.name = name;
    App.saveFiles();
    ActivityLog.record('bug_file_rename', `File Bug Report "${oldName}" diganti nama jadi "${name}"`);
    this.render();
  },
  async shareFile(fileId){
    const file = this.files().find(f => f.id === fileId);
    if (!file) return;
    if (!Auth.canShareFile(file)){ Toast.show('Tidak punya izin share file ini.', 'error'); return; }
    const others = Auth.workspaces().filter(w => w.id !== file.workspaceId);
    const shared = new Set(file.sharedWith || []);
    const ids = await checklistDialog(`Share File "${file.name}"`,
      others.map(w => ({ id: w.id, label: w.name, checked: shared.has(w.id) })), 'Simpan Sharing');
    if (ids === null) return;
    file.sharedWith = ids;
    App.saveFiles();
    ActivityLog.record('bug_file_share', ids.length
      ? `File Bug Report "${file.name}" dibagikan ke ${ids.length} workspace`
      : `Sharing File Bug Report "${file.name}" dihapus`);
    this.render();
    Toast.show(ids.length ? `File "${file.name}" dibagikan ke ${ids.length} workspace.` : `Sharing file "${file.name}" dihapus.`, 'success');
  },
  async deleteFile(fileId){
    if (!Auth.isAdmin()){ Toast.show('Hanya Admin yang dapat menghapus file.', 'error'); return; }
    const file = this.files().find(f => f.id === fileId);
    const count = this.fileCount(fileId);
    const ok = await confirmDialog('Hapus File?', `File "${file.name}" beserta ${count} bug di dalamnya akan dihapus permanen.`, 'Hapus');
    if (!ok) return;
    App.state.files = App.state.files.filter(f => f.id !== fileId);
    App.state.bugs = App.state.bugs.filter(b => b.fileId !== fileId);
    App.saveFiles();
    App.saveBugs();
    ActivityLog.record('bug_file_delete', `File Bug Report "${file.name}" dihapus`);
    if (this.ui.activeFileId === fileId){ this.ui.activeFileId = null; sessionStorage.removeItem('qa_bug_active_file'); }
    this.render();
    Toast.show(`File "${file.name}" dihapus.`, 'info');
  },
```

- [ ] **Step 5: Syntax-check**

Run:
```bash
node --check qa-app/js/bugreport.js && echo OK
```
Expected: `OK`

- [ ] **Step 6: Bump cache-bust version**

Run:
```bash
grep -n "js/bugreport.js" qa-app/index.html
```
Bump its `?v=N` by 1.

- [ ] **Step 7: Manual verification**

Same as Task 4 Step 7, but on the Bug Report page: create/edit/delete a bug, create/rename/share/delete a file, checking `App.state.activityLog.slice(-1)[0]` after each action for the matching `bugreport_*`/`bug_file_*` action code.

- [ ] **Step 8: Commit**

```bash
git add qa-app/js/bugreport.js qa-app/index.html
git commit -m "feat: log bug report and bug-report-file CRUD to activity log"
```

---

### Task 6: Hook CRUD logging in usermanagement.js

**Files:**
- Modify: `qa-app/js/usermanagement.js` (`saveUser`, `deleteUser`, `saveRole`, `deleteRole`, `saveWorkspace`, `deleteWorkspace`)

**Interfaces:**
- Consumes: `ActivityLog.record(action, label)` (from Task 2).

- [ ] **Step 1: Log user create/update**

In `qa-app/js/usermanagement.js`, find:
```js
      user.role = role;
      user.workspaceId = workspaceId;
      App.saveSettings();
      this.resetUserForm();
      this.closeUserModal();
      this.renderUsers();
      Toast.show('User diperbarui.', 'success');
      return;
    }

    if (!Auth.isValidEmail(email)){ Toast.show('Format email tidak valid.', 'error'); return; }
    if (Auth.findByEmail(users, email)){ Toast.show('Email sudah terdaftar.', 'error'); return; }
    if (password.length < 4){ Toast.show('Password minimal 4 karakter.', 'error'); return; }

    users.push({ email, password, role, workspaceId });
    App.saveSettings();
    this.resetUserForm();
    this.closeUserModal();
    this.renderUsers();
    Toast.show('User ditambahkan.', 'success');
  },
```
Replace with:
```js
      user.role = role;
      user.workspaceId = workspaceId;
      App.saveSettings();
      ActivityLog.record('user_update', `User ${email} diperbarui`);
      this.resetUserForm();
      this.closeUserModal();
      this.renderUsers();
      Toast.show('User diperbarui.', 'success');
      return;
    }

    if (!Auth.isValidEmail(email)){ Toast.show('Format email tidak valid.', 'error'); return; }
    if (Auth.findByEmail(users, email)){ Toast.show('Email sudah terdaftar.', 'error'); return; }
    if (password.length < 4){ Toast.show('Password minimal 4 karakter.', 'error'); return; }

    users.push({ email, password, role, workspaceId });
    App.saveSettings();
    ActivityLog.record('user_create', `User ${email} dibuat`);
    this.resetUserForm();
    this.closeUserModal();
    this.renderUsers();
    Toast.show('User ditambahkan.', 'success');
  },
```
(Never include `password` in the logged label — only `email`.)

- [ ] **Step 2: Log user delete**

In `qa-app/js/usermanagement.js`, find:
```js
    const ok = await confirmDialog('Hapus User?', `User "${user.email}" akan dihapus permanen.`, 'Hapus');
    if (!ok) return;
    App.state.settings.users = users.filter(u => u !== user);
    App.saveSettings();
    if (this.editingEmail === user.email) this.resetUserForm();
    this.renderUsers();
    Toast.show('User dihapus.', 'info');
  },
```
Replace with:
```js
    const ok = await confirmDialog('Hapus User?', `User "${user.email}" akan dihapus permanen.`, 'Hapus');
    if (!ok) return;
    App.state.settings.users = users.filter(u => u !== user);
    App.saveSettings();
    ActivityLog.record('user_delete', `User ${user.email} dihapus`);
    if (this.editingEmail === user.email) this.resetUserForm();
    this.renderUsers();
    Toast.show('User dihapus.', 'info');
  },
```

- [ ] **Step 3: Log role create/update**

In `qa-app/js/usermanagement.js`, find:
```js
    if (this.roleEditingValue){
      const result = Auth.updateRole(this.roleEditingValue, label);
      if (!result.ok){ Toast.show(result.error, 'error'); return; }
      App.state.settings.rolePermissions[this.roleEditingValue] = perms;
      App.saveSettings();
      Toast.show('Role diperbarui.', 'success');
    } else {
      const result = Auth.addRole(label, code);
      if (!result.ok){ Toast.show(result.error, 'error'); return; }
      App.state.settings.rolePermissions[result.value] = perms;
      App.saveSettings();
      Toast.show('Role dibuat.', 'success');
    }
```
Replace with:
```js
    if (this.roleEditingValue){
      const result = Auth.updateRole(this.roleEditingValue, label);
      if (!result.ok){ Toast.show(result.error, 'error'); return; }
      App.state.settings.rolePermissions[this.roleEditingValue] = perms;
      App.saveSettings();
      ActivityLog.record('role_update', `Role "${label}" diperbarui`);
      Toast.show('Role diperbarui.', 'success');
    } else {
      const result = Auth.addRole(label, code);
      if (!result.ok){ Toast.show(result.error, 'error'); return; }
      App.state.settings.rolePermissions[result.value] = perms;
      App.saveSettings();
      ActivityLog.record('role_create', `Role "${label}" dibuat`);
      Toast.show('Role dibuat.', 'success');
    }
```

- [ ] **Step 4: Log role delete**

In `qa-app/js/usermanagement.js`, find:
```js
  async deleteRole(value){
    const role = Auth.findRole(value);
    if (!role) return;
    const ok = await confirmDialog('Hapus Role?', `Role "${role.label}" akan dihapus permanen.`, 'Hapus');
    if (!ok) return;
    const result = Auth.deleteRole(value);
    if (!result.ok){ Toast.show(result.error, 'error'); return; }
    this.renderRolePermissions();
```
Replace with:
```js
  async deleteRole(value){
    const role = Auth.findRole(value);
    if (!role) return;
    const ok = await confirmDialog('Hapus Role?', `Role "${role.label}" akan dihapus permanen.`, 'Hapus');
    if (!ok) return;
    const result = Auth.deleteRole(value);
    if (!result.ok){ Toast.show(result.error, 'error'); return; }
    ActivityLog.record('role_delete', `Role "${role.label}" dihapus`);
    this.renderRolePermissions();
```

- [ ] **Step 5: Log workspace create/update**

In `qa-app/js/usermanagement.js`, find:
```js
  saveWorkspace(){
    const name = document.getElementById('workspaceFormName').value;
    const result = this.workspaceEditingId
      ? Auth.updateWorkspace(this.workspaceEditingId, name)
      : Auth.addWorkspace(name);
    if (!result.ok){ Toast.show(result.error, 'error'); return; }
    Toast.show(this.workspaceEditingId ? 'Workspace diperbarui.' : 'Workspace dibuat.', 'success');
    this.closeWorkspaceModal();
    this.resetWorkspaceForm();
    this.renderWorkspaces();
    this.refreshWorkspaceSelect();
  },
```
Replace with:
```js
  saveWorkspace(){
    const name = document.getElementById('workspaceFormName').value;
    const wasEditing = !!this.workspaceEditingId;
    const result = this.workspaceEditingId
      ? Auth.updateWorkspace(this.workspaceEditingId, name)
      : Auth.addWorkspace(name);
    if (!result.ok){ Toast.show(result.error, 'error'); return; }
    ActivityLog.record(wasEditing ? 'workspace_update' : 'workspace_create', `Workspace "${name}" ${wasEditing ? 'diperbarui' : 'dibuat'}`);
    Toast.show(wasEditing ? 'Workspace diperbarui.' : 'Workspace dibuat.', 'success');
    this.closeWorkspaceModal();
    this.resetWorkspaceForm();
    this.renderWorkspaces();
    this.refreshWorkspaceSelect();
  },
```
(`this.workspaceEditingId` is captured into `wasEditing` before either `Auth.updateWorkspace`/`Auth.addWorkspace` runs, since neither of those clears it — `resetWorkspaceForm()` a few lines down does. Reading `this.workspaceEditingId` again after the `if (!result.ok)` guard would still work today, but `wasEditing` makes the intent explicit and is safe against future changes to when it gets cleared.)

- [ ] **Step 6: Log workspace delete**

In `qa-app/js/usermanagement.js`, find:
```js
  async deleteWorkspace(id){
    const ws = Auth.findWorkspace(id);
    if (!ws) return;
    const ok = await confirmDialog('Hapus Workspace?', `Workspace "${ws.name}" akan dihapus permanen.`, 'Hapus');
    if (!ok) return;
    const result = Auth.deleteWorkspace(id);
    if (!result.ok){ Toast.show(result.error, 'error'); return; }
    this.renderWorkspaces();
    this.refreshWorkspaceSelect();
    Toast.show('Workspace dihapus.', 'info');
  },
```
Replace with:
```js
  async deleteWorkspace(id){
    const ws = Auth.findWorkspace(id);
    if (!ws) return;
    const ok = await confirmDialog('Hapus Workspace?', `Workspace "${ws.name}" akan dihapus permanen.`, 'Hapus');
    if (!ok) return;
    const result = Auth.deleteWorkspace(id);
    if (!result.ok){ Toast.show(result.error, 'error'); return; }
    ActivityLog.record('workspace_delete', `Workspace "${ws.name}" dihapus`);
    this.renderWorkspaces();
    this.refreshWorkspaceSelect();
    Toast.show('Workspace dihapus.', 'info');
  },
```

- [ ] **Step 7: Syntax-check**

Run:
```bash
node --check qa-app/js/usermanagement.js && echo OK
```
Expected: `OK`

- [ ] **Step 8: Bump cache-bust version**

Run:
```bash
grep -n "js/usermanagement.js" qa-app/index.html
```
Bump its `?v=N` by 1.

- [ ] **Step 9: Manual verification**

As admin: create/edit/delete a user, a role, and a workspace (using throwaway values so nothing real gets clobbered — e.g. a role code like `zztest`, a workspace named `ZZ Test WS`, deleting them right after). After each action, check `App.state.activityLog.slice(-1)[0]` in the console for the matching `user_*`/`role_*`/`workspace_*` action code and a label that never contains a password.

- [ ] **Step 10: Commit**

```bash
git add qa-app/js/usermanagement.js qa-app/index.html
git commit -m "feat: log user/role/workspace CRUD to activity log"
```

---

### Task 7: Activity Log page UI (table, filters, pagination, export)

**Files:**
- Modify: `qa-app/index.html` (fill in `#page-activitylog` with the real toolbar/table/pagination markup)
- Modify: `qa-app/js/activitylog.js` (replace the `ActivityLogModule.render()` stub with the full page: filtered table, pagination, Excel/CSV export)

**Interfaces:**
- Consumes: `App.state.activityLog` (populated by Tasks 2/4/5/6), `escapeHtml`, `formatDateTime`, `debounce`, `downloadBlob`, `arrayToCSV` (all existing, in `utils.js`), `ExcelJS` (already loaded via CDN in `index.html`).

- [ ] **Step 1: Build the page markup**

In `qa-app/index.html`, find:
```html
      <!-- ============ ACTIVITY LOG ============ -->
      <section class="page" id="page-activitylog"></section>
```
Replace with:
```html
      <!-- ============ ACTIVITY LOG ============ -->
      <section class="page" id="page-activitylog">
        <div class="toolbar">
          <div class="search-box"><span>🔎</span><input type="text" id="alSearchInput" placeholder="Cari aktivitas..."></div>

          <div class="dropdown" id="alFilterDropdown">
            <button class="btn sm" type="button">▾ Filter</button>
            <div class="dropdown-panel">
              <select class="filter-select" id="alFilterUser" data-label="Semua User"></select>
              <select class="filter-select" id="alFilterAction" data-label="Semua Jenis Aksi">
                <option value="">Semua Jenis Aksi</option>
                <option value="auth">Login / Logout</option>
                <option value="testcase">Test Case</option>
                <option value="bugreport">Bug Report</option>
                <option value="file">File</option>
                <option value="usermanagement">User Management</option>
              </select>
            </div>
          </div>

          <div class="spacer"></div>

          <div class="dropdown" id="alExportDropdown">
            <button class="btn sm" type="button">⇧ Export</button>
            <div class="dropdown-panel">
              <button class="dropdown-item" id="alExportExcelBtn">⇧ Excel (.xlsx)</button>
              <button class="dropdown-item" id="alExportCsvBtn">⇧ CSV</button>
            </div>
          </div>
        </div>

        <div class="table-wrap" id="alTableWrap">
          <table class="data-table" id="alTable">
            <thead>
              <tr>
                <th>Waktu</th>
                <th>User</th>
                <th>Role</th>
                <th>Aksi</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody id="alTableBody"></tbody>
          </table>
        </div>
        <div class="empty-state" id="alEmptyState" style="display:none;">
          <div class="glyph">🕒</div><h4>Belum ada aktivitas tercatat</h4>
          <p>Aktivitas login/logout dan CRUD akan muncul di sini.</p>
        </div>
        <div class="flex-between">
          <span class="text-faint" id="alResultInfo" style="font-size:12.5px;"></span>
          <div class="pagination" id="alPagination"></div>
        </div>
      </section>
```

- [ ] **Step 2: Replace the module stub with the full implementation**

In `qa-app/js/activitylog.js`, find:
```js
const ActivityLogModule = {
  render(){
    if (!Auth.can('activitylog')){
      document.getElementById('page-activitylog').innerHTML = `<p class="text-faint" style="padding:24px 0; text-align:center;">Anda tidak punya akses ke halaman ini.</p>`;
      return;
    }
    // Task 7 replaces this with the real table/filter/pagination/export UI.
    document.getElementById('page-activitylog').innerHTML = `<p class="text-faint" style="padding:24px 0; text-align:center;">Activity Log — ${App.state.activityLog.length} entri tercatat.</p>`;
  }
};
```
Replace with:
```js
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
      <tr>
        <td class="text-dim" style="white-space:nowrap;">${formatDateTime(e.ts)}</td>
        <td>${escapeHtml(e.actorEmail || '-')}</td>
        <td>${escapeHtml(e.actorRole || '-')}</td>
        <td><span class="badge st-notrun">${escapeHtml(e.action)}</span></td>
        <td>${escapeHtml(e.label)}</td>
      </tr>
    `).join('');

    document.getElementById('alResultInfo').textContent = `Menampilkan ${pageRows.length} dari ${total} aktivitas`;
    this.renderPagination(totalPages);
  },

  renderFilterOptions(){
    const el = document.getElementById('alFilterUser');
    const current = this.ui.filters.user;
    el.innerHTML = `<option value="">Semua User</option>` +
      this.uniqueUsers().map(u => `<option value="${escapeHtml(u)}" ${u === current ? 'selected' : ''}>${escapeHtml(u)}</option>`).join('');
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
    document.getElementById('alExportExcelBtn').addEventListener('click', () => this.exportExcel());
    document.getElementById('alExportCsvBtn').addEventListener('click', () => this.exportCSV());
  }
};

document.addEventListener('DOMContentLoaded', () => ActivityLogModule.bindStaticEvents());
```

(`todayISO()` is the existing date-stamp helper already used by every other export function in this codebase, e.g. `TestCaseModule.exportExcel()` in `qa-app/js/testcase.js`.)

- [ ] **Step 3: Syntax-check**

Run:
```bash
node --check qa-app/js/activitylog.js && echo OK
```
Expected: `OK`

- [ ] **Step 4: Bump cache-bust version**

Run:
```bash
grep -n "js/activitylog.js" qa-app/index.html
```
Bump it by 1 (from whatever Task 3 left it at).

- [ ] **Step 5: Manual verification**

As a role with `activitylog` permission (or admin): open Activity Log. Confirm:
- Every entry from prior tasks' manual testing shows up, newest first.
- Typing in the search box filters by user email / label text.
- The User filter dropdown lists every distinct `actorEmail` seen; picking one filters the table.
- The Jenis Aksi filter's "Test Case", "Bug Report", "File", "User Management", "Login / Logout" groups each show only their matching rows.
- With more than 20 entries (do a few throwaway edits if needed to cross that threshold), pagination controls appear and paging works.
- Clicking "Export → Excel (.xlsx)" downloads a file with one row per **filtered** entry (apply a filter first, confirm the export respects it) and columns Waktu/User/Role/Aksi/Detail.
- Clicking "Export → CSV" downloads a matching CSV.
- With zero entries matching the current filter, the empty-state message renders instead of a blank table.

- [ ] **Step 6: Commit**

```bash
git add qa-app/index.html qa-app/js/activitylog.js
git commit -m "feat: build Activity Log page UI (table, filters, pagination, export)"
```

---

## Self-Review Notes

- **Spec coverage:** data model (Task 2), retention cap (Task 2), hook points — auth (Task 2), testcase/file (Task 4), bugreport/file (Task 5), usermanagement (Task 6) — permission (Task 3), UI table/filters/pagination/export (Task 7), backend allowlist (Task 1). All spec sections have a task.
- **Out-of-scope reminder carried into Global Constraints** so no task accidentally hooks theme/translate/duplicate/import-export/settings/master-status.
- **Type/name consistency checked:** `ActivityLog.record(action, label)` signature is identical across every call site in Tasks 2/4/5/6. `STORAGE_KEYS.ACTIVITY_LOG` / `App.state.activityLog` / `App.saveActivityLog()` names match between Task 1 (defines them) and Task 2 (`ActivityLog.record()` uses them).
