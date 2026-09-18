# Activity Log — Design

## Purpose
Give admins (and permitted roles) visibility into who did what: login/logout
plus CRUD on the app's core entities (Test Case, Bug Report, File, User,
Role, Workspace). Addresses "no audit trail" gap in the current app —
today nothing records who created/edited/deleted what or when.

## Data model
New storage key `qa_activity_log`, synced through the existing
`Storage`/`kv_store` pipeline exactly like `qa_testcases`/`qa_bugs`/etc.

Entry shape:
```js
{
  id: 'LOG-<timestamp>',
  ts: '<ISO datetime>',
  actorEmail: string,
  actorRole: string,        // role code at time of action
  workspaceId: string|null, // actor's workspace at time of action
  action: string,           // short code, see below
  label: string             // human-readable, ready to render
}
```

`action` codes:
- `login`, `logout`
- `testcase_create`, `testcase_update`, `testcase_delete`
- `bugreport_create`, `bugreport_update`, `bugreport_delete`
- `tc_file_create`, `tc_file_rename`, `tc_file_delete`, `tc_file_share`
- `bug_file_create`, `bug_file_rename`, `bug_file_delete`, `bug_file_share`
- `user_create`, `user_update`, `user_delete`
- `role_create`, `role_update`, `role_delete`
- `workspace_create`, `workspace_update`, `workspace_delete`

Out of scope (not logged, to avoid noise): theme toggle, translate,
duplicate, import/export actions, settings/custom-field changes, master
status CRUD. Can be added later the same way if needed.

## Retention
Cap at the most recent **1000** entries. `ActivityLog.record()` appends
then `slice(-1000)` before saving — oldest entries silently drop off
(FIFO), keeping the blob small for both localStorage and the Mongo
`kv_store` document.

## Central logging module
New `ActivityLog` object (in `qa-app/js/activitylog.js`, loaded early —
right after `auth.js` since login logging needs it at login time):

```js
const ActivityLog = {
  record(action, label){
    const entry = {
      id: 'LOG-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
      ts: nowISO(),
      actorEmail: Auth.currentEmail(),
      actorRole: Auth.role(),
      workspaceId: Auth.currentWorkspaceId(),
      action, label
    };
    App.state.activityLog = [...(App.state.activityLog || []), entry].slice(-1000);
    Storage.set(STORAGE_KEYS.ACTIVITY_LOG, App.state.activityLog);
  }
};
```

The random suffix on `id` avoids collisions when multiple entries are
recorded within the same millisecond (e.g. bulk delete).

## Hook points (call sites)
- `auth.js`:
  - `enter(role, email, workspaceId)` — record `login` right after session
    is set (so actor info is available), label: `"<email> login sebagai
    <role>"`.
  - `logout()` — record `logout` **before** clearing `sessionStorage` (actor
    info must still be readable), label: `"<email> logout"`.
- `testcase.js`:
  - `submitForm()` — after create: `testcase_create`, label `Test Case
    <id> dibuat`. After update: `testcase_update`, label `Test Case <id>
    diperbarui`.
  - `remove(id)` — `testcase_delete`, label `Test Case <id> dihapus`.
  - `bulkDelete()` — a single summarized entry (`testcase_delete`, label
    `"N test case dihapus (bulk)"`) instead of one entry per id, to avoid
    flooding the log/burning through the 1000-entry cap on large bulk ops.
  - `createFile/renameFile/deleteFile/shareFile` — `tc_file_*` actions,
    label includes file name (and target workspace count for share).
- `bugreport.js`: mirrors testcase.js — `bugreport_create/update/delete`,
  bulk delete summarized, `bug_file_*` for file actions.
- `usermanagement.js`: `addUser/updateUser/deleteUser` →
  `user_create/update/delete` (label includes target email, never
  password); `addRole/updateRole/deleteRole` → `role_*` (label includes
  role name); `addWorkspace/updateWorkspace/deleteWorkspace` →
  `workspace_*` (label includes workspace name).

## Permission
New `PERMISSION_KEYS` entry: `{ key: 'activitylog', label: 'Activity Log
(lihat)' }`. Follows the exact existing pattern (`Auth.can('activitylog')`,
admin always full access via `Auth.can()`'s admin short-circuit). Not
added to any `DEFAULT_ROLE_PERMISSIONS` seed (opt-in per role from the
Role Permission page, same as any new permission key added to an
existing role set).

## UI
New page `activitylog.js` + `page-activitylog` section in `index.html`,
new sidebar nav item (admin-configurable visibility via the permission
above, same `applyNavPermissions()` pattern as other pages).

Table columns: Waktu (formatted date/time), User (email), Role, Aksi
(badge per action-family color), Detail (the `label`).

Filters: search text (matches label/email), user dropdown (unique
`actorEmail` values), action-type dropdown (grouped: Login/Logout, Test
Case, Bug Report, File, User Management). Sort by `ts` desc by default.
Pagination: same 10-per-page pattern as Test Case/Bug Report tables.

Export: Excel + CSV buttons, same `exportColumns()`/`downloadBlob()`
pattern as Test Case module, respecting current filter/search (same
convention established for Test Case export).

No create/edit/delete actions on this page itself — it's a read-only
audit trail. (Whether an admin can clear/purge the log is explicitly
**out of scope** for this iteration — the FIFO cap is the only retention
control.)

## Backend
Add `'qa_activity_log'` to `ALLOWED_KEYS` in `server/server.js` — no
other backend change needed (existing generic KV PUT/GET already
handles it, same as every other key).

## Testing
Manual: log in as different roles, perform each hooked CRUD action,
confirm entries appear with correct actor/label; verify FIFO cap by
checking `.slice(-1000)` logic; verify a role without `activitylog`
permission can't see the nav item or open the page directly; verify
Export produces a readable file matching on-screen filtered rows.
