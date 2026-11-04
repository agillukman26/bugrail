# Server-side Auth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Server verifies login, issues session tokens, gates every `/api/*` call by the token's user, and never sends passwords to the client — without any existing user losing their password or any data being lost.

**Architecture:** New `server/auth.js` holds pure helpers (hashing, permission lookup, settings sanitize/merge). `server/app.js` gains `/api/login`, `/api/logout`, a `requireAuth` middleware, and uses `req.user` instead of client headers. Frontend logs in via the API, keeps the token as the existing per-tab `qa_sid`, sends it on every call, and only loads data after login.

**Tech Stack:** Node `node:crypto` (scrypt, randomBytes), Express 4, MongoDB driver 6, vanilla JS frontend. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-27-server-auth-design.md`

## Global Constraints

- **No data loss, ever.** No write may drop/overwrite stored data it didn't mean to change. Only schema addition: collection `sessions`.
- **Local dev and prod share ONE MongoDB.** Server tests must mock `db.getDb` (never the real DB). Do not run the new server against the real DB with `PASSWORD_HASH_UPGRADE=1`.
- `PASSWORD_HASH_UPGRADE=1` in `.env` enables writing hashes; default off. Off ⇒ passwords stay in their stored format (plaintext stays plaintext, new passwords stored plaintext).
- Hash format: `scrypt$<saltHex>$<hashHex>`, 16-byte salt, 64-byte key.
- Token: `crypto.randomBytes(32).toString('hex')`; `sessions` doc `{ _id: token, email, createdAt }`, TTL 30 days (`expireAfterSeconds: 2592000`).
- Login rate limit: 10 attempts / 5 min per `ip + normalized email`.
- No `Authorization` header and no `?token=` ⇒ `503 { error: 'Aplikasi diperbarui — muat ulang halaman (Ctrl+F5).' }`. Present but invalid ⇒ `401`.
- Wrong login ⇒ `401 { error: 'Email atau password salah.' }`.
- **Do not commit.** The user commits their own changes after testing. Leave everything in the working tree.
- Server tests: `cd server && npm test`. Frontend checks: `node qa-app/test/<name>.check.js`.

## Review Focus

1. Old browser with an unsynced `qa_settings` (plaintext passwords inside) boots after deploy → re-send must not change any stored password. Test in Task 1 (`applySettingsWrite ignores incoming password`).
2. Non-admin saves theme / boots with defaults filled by `ensureRoles`/`ensureRolePermissions` → must not 403. Test in Task 1 (`additions only are not a change`).
3. User Management sets a new password, then later another settings save happens → `newPassword` must not linger and get re-applied. Covered in Task 4 step (clear after confirmed save) + manual checklist.
4. Login race: someone edits users while the lazy hash upgrade runs → upgrade must touch only that user's `password` and skip if it changed. Test in Task 2 (`login upgrade uses targeted filter`).
5. Token expires mid-edit → the PUT's change must stay unsynced and be re-sent after re-login. Task 3 step + manual checklist.

---

### Task 1: `server/auth.js` pure helpers

**Files:**
- Create: `server/auth.js`
- Test: `server/test/auth.test.js`

**Interfaces:**
- Produces:
  - `hashPassword(plain: string): Promise<string>` — `scrypt$…` format.
  - `isHashed(stored: string): boolean` — starts with `scrypt$`.
  - `verifyPassword(stored: string, plain: string): Promise<boolean>` — hashed: scrypt + `timingSafeEqual`; otherwise exact string equality (same as old `user.password !== password`). Empty/missing stored ⇒ false.
  - `normalizeEmail(e): string` — trim + lowercase.
  - `userWorkspaceIds(user): string[]` — copy of `WorkspaceCalc.userWorkspaceIds` (`qa-app/js/workspace.js:21`).
  - `DEFAULT_ROLE_PERMISSIONS` — verbatim copy of `qa-app/js/auth.js:65-70`, with a comment pointing back to it.
  - `can(settings, role, permKey): boolean` — `role === 'admin'` ⇒ true; `'user'` ⇒ `'user_umum'`; map = `{ ...DEFAULT_ROLE_PERMISSIONS[role], ...settings.rolePermissions?.[role] }`.
  - `findUser(settings, email): object|null` — by normalized email.
  - `sanitizeSettings(value): object` — copy with `password` and `newPassword` removed from every `users[]` entry. Never mutates input.
  - `applySettingsWrite(stored, incoming, actor, { hashUpgrade }): Promise<{ value } | { status, error }>` — `actor = { email, role }`. Rules in order:
    1. For every incoming user, drop incoming `password`; restore the stored user's `password` (matched by normalized email).
    2. `newPassword` present ⇒ requires `can(stored, actor.role, 'usermanagement')`, length ≥ 4 (else 400), becomes `password` (`hashPassword` if `hashUpgrade`, else plaintext); `newPassword` removed.
    3. Incoming user with no stored match and no `newPassword` ⇒ `400`.
    4. Per-key gate: `GATES = { users: 'usermanagement', roles: 'usermanagement', rolePermissions: 'usermanagement', workspaces: 'usermanagement', bugStatusMaster: 'master', customFieldDefs: 'settings', geminiApiKey: 'settings' }`; other keys (e.g. `theme`) open. A gated key counts as changed only if `!onlyAdds(sanitized stored[k], sanitized incoming[k])` ⇒ `403` without the permission.
    5. Non-admin actor: giving `role: 'admin'` to a user not stored as admin, or changing / removing / `newPassword` on a user stored as admin ⇒ `403`.
  - `onlyAdds(a, b): boolean` — `a === undefined` ⇒ true; both plain objects ⇒ every key of `a` in `b` and `onlyAdds(a[k], b[k])`; else `JSON.stringify(a) === JSON.stringify(b)`.

- [ ] **Step 1: Write failing tests** in `server/test/auth.test.js` (`node:test`, `assert/strict`, no DB):
  - `hashPassword/verifyPassword round-trip`; `verifyPassword rejects wrong`; `verifyPassword accepts legacy plaintext 'sama'`; `isHashed`.
  - `can: admin always true`; `can: 'user' maps to user_umum`; `can: stored override beats default` (`rolePermissions.pm_ba.report = false` ⇒ false).
  - `sanitizeSettings strips password and newPassword, input untouched`.
  - `applySettingsWrite ignores incoming password` — stored `{email:'a@x', password:'new1'}`, incoming `{email:'a@x', password:'old0'}` ⇒ value keeps `'new1'`.
  - `applySettingsWrite newPassword hashes when hashUpgrade` (result `isHashed`, verifies) / `stores plaintext when off` (`=== 'abcd'`) / `403 without usermanagement` / `400 when < 4 chars`.
  - `applySettingsWrite new user without newPassword ⇒ 400`.
  - `additions only are not a change` — non-admin `qa_vendor`, stored `rolePermissions: { pm_ba: { report: true } }`, incoming adds `pm_ba.dashboard` and `theme` changed ⇒ `{ value }`.
  - `changing stored rolePermissions value without permission ⇒ 403`.
  - `non-admin with usermanagement cannot grant admin` / `cannot edit admin user` / `cannot remove admin user` ⇒ 403; admin can.
  - `bugStatusMaster change needs master`.
- [ ] **Step 2: Run** `cd server && node --test test/auth.test.js` — Expected: FAIL, `Cannot find module '../auth'`.
- [ ] **Step 3: Implement `server/auth.js`** with the interfaces above. scrypt via `util.promisify(crypto.scrypt)`.
- [ ] **Step 4: Run** `cd server && node --test test/auth.test.js` — Expected: all pass.

---

### Task 2: Server routes, sessions, middleware

**Files:**
- Modify: `server/app.js` (replace `readClientAuth` uses at `:43-50`, `:62`, `:150`; GET routes `:14-37`; SSE `:174`; PUT `:183`; settings validator `:113`)
- Modify: `server/.env.example` (add `PASSWORD_HASH_UPGRADE=0` with a comment: "1 = rewrite plaintext passwords as hashes on login. Keep 0 until the new build is stable on the VM — old builds can't read hashes, and local dev shares the prod DB.")
- Test: `server/test/app.test.js`

**Interfaces:**
- Consumes: everything from Task 1.
- Produces (HTTP):
  - `POST /api/login {email, password}` ⇒ `200 {token, email, role, workspaceIds}` | `401` | `429`.
  - `POST /api/logout` (auth) ⇒ `200 {ok:true}`, session deleted.
  - All other `/api/*` behind `requireAuth`. Token from `Authorization: Bearer <t>`, or `?token=` (used by `/api/events`).
  - `req.user = { email, role, workspaceIds }`, `req.settings` (stored settings value), `req.workspace` (validated `x-workspace` or `''`), `req.canShare = can(req.settings, role, 'testcase_fileShare')`.
  - `GET /api/kv`, `GET /api/kv/qa_settings` return `sanitizeSettings` for `qa_settings`.

- [ ] **Step 1: Test helper.** In `app.test.js` add `mockDb({ kv = {}, sessions = {} })` returning a `getDb` whose `collection(name)` dispatches by name (`kv_store`: `findOne`, `find().toArray`, `findOneAndUpdate`, `updateOne` recording calls; `sessions`: `findOne`, `insertOne`, `deleteOne`, `createIndex`). Add `const AUTH = { Authorization: 'Bearer t1' }` with a session `t1 → a@x`. Update the existing 38 tests that hit `/api/kv` or `/api/testforge` / `/api/bug/analyze` to use `mockDb` + `AUTH`, and replace their `x-role`/`x-workspace`/`x-can-share` headers with matching users in mocked `qa_settings` (behavior they assert stays the same).
- [ ] **Step 2: Write failing tests:**
  - `no auth header ⇒ 503 with reload message`; `bad token ⇒ 401`; `token of deleted user ⇒ 401`.
  - `spoofed x-role: admin is ignored` — non-admin user, PUT `qa_files` into another workspace ⇒ 403.
  - `foreign x-workspace ⇒ 403`; `admin any x-workspace ok`.
  - `login ok returns token and inserts session`; `login wrong password ⇒ 401 'Email atau password salah.'`; `login email case-insensitive`; `11th login attempt ⇒ 429`.
  - `login upgrade uses targeted filter` — with `PASSWORD_HASH_UPGRADE=1` and plaintext user: one `updateOne` call whose filter matches `_id: 'qa_settings'` + `$elemMatch {email, password: <old plaintext>}` and update is `$set {'value.users.$.password': <hash>}` + `$inc {rev: 1}`; no `findOneAndUpdate` on settings.
  - `login does not write password when flag off`.
  - `login with no users seeds admin@bugrail.local / sama` (filter requires users empty/missing).
  - `GET /api/kv strips passwords`; `GET /api/kv/qa_settings strips passwords`.
  - `PUT qa_settings keeps stored passwords` (incoming has none ⇒ stored value written via `findOneAndUpdate` still has them).
  - `logout deletes session`.
  - `events accepts ?token=`.
- [ ] **Step 3: Run** `cd server && npm test` — Expected: new tests FAIL.
- [ ] **Step 4: Implement** in `server/app.js`:
  - `requireAuth` mounted with `app.use('/api', …)` after `POST /api/login` is declared; skip it for `/login`.
  - `sessions` TTL index created once lazily (`createIndex({createdAt:1},{expireAfterSeconds:2592000})`, ignore errors).
  - Login rate limit: generalize the existing limiter into `hitLimit(map, key, limit, windowMs)`; keep `isTestForgeRateLimited` exported and passing its tests.
  - Lazy upgrade only when `process.env.PASSWORD_HASH_UPGRADE === '1'`; on `modifiedCount` ⇒ `broadcast({ key: 'qa_settings', rev })` (read rev back with `findOne`).
  - Seed when settings has no users: `updateOne({_id:'qa_settings', $or:[{'value.users':{$exists:false}},{'value.users':{$size:0}}]}, {$set:{'value.users':[seedUser]}, $inc:{rev:1}}, {upsert:true})` — seed password hashed only when the flag is on. Upsert dup-key error ⇒ treat as not seeded.
  - `validateFilesWrite` / `validateBugsWrite`: read `req.user.role`, `req.workspace`, `req.canShare`.
  - `validateSettingsWrite`: keep missing-top-level-key 409 check, then `applySettingsWrite(stored, incoming, req.user, { hashUpgrade })`; on `{status}` respond; else set `req.body.value = result.value`.
- [ ] **Step 5: Run** `cd server && npm test` — Expected: all pass (old + new).

---

### Task 3: Frontend storage layer sends the token

**Files:**
- Modify: `qa-app/js/utils.js` (`Storage.hydrate :85`, `refresh`, `refreshKey`, `sendWithMerge :176`, `mergeFromServer`)
- Modify: `qa-app/js/app.js:171` (EventSource), `qa-app/js/bugreport.js:759`, `qa-app/js/testforge.js:183`

**Interfaces:**
- Produces: `authHeaders(extra = {}): object` in `utils.js` — `{ ...extra, Authorization: 'Bearer ' + sessionStorage.getItem('qa_sid') }`.
- Produces: `Storage.hydrate(): Promise<'ok'|'unauthorized'|'offline'>`.
- Consumes (from Task 4): `Auth.sessionExpired(): void`.

- [ ] **Step 1:** Every `fetch(`${API_BASE}/…`)` in the files above passes `headers: authHeaders(...)`. `sendWithMerge` drops the `x-role` and `x-can-share` headers, keeps `x-workspace`. EventSource URL becomes `${API_BASE}/events?token=${encodeURIComponent(sessionStorage.getItem('qa_sid') || '')}`.
- [ ] **Step 2:** `hydrate()`: `401` ⇒ return `'unauthorized'` without touching localStorage or unsynced markers. Network error ⇒ existing offline fallback, return `'offline'`. Success ⇒ existing flow, then scrub: delete `password` / `newPassword` from every `cache.qa_settings.users[]` entry and rewrite `localStorage.qa_settings` from cache. Return `'ok'`.
- [ ] **Step 3:** `sendWithMerge`: `res.status === 401` ⇒ do **not** clear the unsynced marker, call `Auth.sessionExpired()`, return false. Placed before the generic 4xx branch.
- [ ] **Step 4:** `refresh` / `refreshKey` / `mergeFromServer`: `401` ⇒ `Auth.sessionExpired()`.
- [ ] **Step 5: Run** every `node qa-app/test/*.check.js` — Expected: all pass (storage.check.js may need `sessionStorage`/`Auth` stubs added to its vm context; add only what it needs).

---

### Task 4: Login flow, boot order, user management

**Files:**
- Modify: `qa-app/js/auth.js` (remove `DEFAULT_USERS :17`, `ensureSeedUsers :232`, `matchCredentials :218`; rewrite `login :253`, `logout`, `init :325`, `DOMContentLoaded :361`; update `selfTest`)
- Modify: `qa-app/js/app.js:76` (`saveSettings` returns the `Storage.set` promise)
- Modify: `qa-app/js/usermanagement.js:105-128`
- Modify: `qa-app/index.html:1022-1038` (bump `?v=` on utils, app, auth, bugreport, testforge, usermanagement)

**Interfaces:**
- Consumes: `authHeaders`, `Storage.hydrate()` from Task 3; `POST /api/login`, `POST /api/logout` from Task 2.
- Produces: `Auth.sessionExpired()` — clears `ROLE/EMAIL/SID/WORKSPACE` session keys, removes `SESSION_SEED_KEY` only if its `sid` equals this tab's, sets `Storage.leaving = true`, `location.reload()`.

- [ ] **Step 1: `async login(email, password)`** — `POST /api/login`. Non-ok ⇒ `errEl.textContent = body.error`; network error ⇒ `'Server tidak terhubung.'`. Ok ⇒ set `ROLE_KEY`, `EMAIL_KEY`, `SID_KEY = token`, seed `{role, email, sid: token}`, remove `WORKSPACE_KEY`, `_freshLogin = true`, `await Storage.hydrate()`, then existing `WorkspacePicker.resolveOnStart()` ⇒ `startApp()`. Disable the submit button while waiting.
- [ ] **Step 2: Boot.** `DOMContentLoaded`: `await Auth.init()` (no more `Storage.hydrate()` before it). `init()`: existing seed/sid restore logic, `bindLoginScreen()`, then if `role()`: `r = await Storage.hydrate()`; `'unauthorized'` ⇒ clear session keys (+ seed if same sid), stay on login; else `resolveOnStart()` ⇒ `startApp()`.
- [ ] **Step 3: `logout()`** — after `Storage.settle()`, `fetch POST /api/logout` with `authHeaders()` (ignore failure), then existing cleanup.
- [ ] **Step 4: User Management.** `saveUser`: edit with password ⇒ `user.newPassword = password` (not `user.password`); create ⇒ push `{ email, newPassword: password, role, workspaceIds, workspaceId }`. After `App.saveSettings()` resolves `true`: `delete user.newPassword` and rewrite `localStorage.qa_settings` from `Storage.cache`. If it resolves false, leave it (unsynced re-send will carry it).
- [ ] **Step 5: `selfTest`** — drop the `matchCredentials` checks, keep email checks.
- [ ] **Step 6: Run** all `node qa-app/test/*.check.js` and `cd server && npm test` — Expected: all pass.
- [ ] **Step 7: Hand the user this manual checklist** (they test locally with `PASSWORD_HASH_UPGRADE` unset — shared DB):
  1. Open app ⇒ login screen shows before any data loads.
  2. Login with an existing account + its current password ⇒ works. Wrong password ⇒ "Email atau password salah."
  3. DevTools Network ⇒ `/api/kv` response has no `password` in `qa_settings.users`. `localStorage.qa_settings` has no passwords.
  4. Open a second tab ⇒ already logged in. Logout in one ⇒ the other goes to login on next action/reload.
  5. Non-admin user: toggle theme, edit a bug, add a test case ⇒ saves fine.
  6. Admin: create user with password, log in as them in a private window. Change their password ⇒ old fails, new works. Then change something unrelated in settings ⇒ that password still works.
  7. Non-admin with User Management permission: try to set a user to Admin ⇒ refused toast.
  8. In DevTools set sessionStorage `qa_sid` to `x`, edit a bug ⇒ page reloads (the tab picks the real login back up from the browser) and the edit is saved, not lost. Then logout, log back in ⇒ edit still there.
  9. Bug chat live update / SSE still arrives in another tab.
  10. AI analyze on failed test case still works (if enabled).
