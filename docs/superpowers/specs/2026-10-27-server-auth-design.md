# Server-side Auth — Design

Date: 2026-10-27

## Why

Today login is checked only in the browser (`Auth.matchCredentials`, `qa-app/js/auth.js`).
The server has no notion of who is calling:

- `GET /api/kv` returns everything — including `qa_settings.users[].password` in
  plaintext — to anyone who can reach the VM URL, logged in or not.
- `PUT /api/kv/*` trusts `x-role` / `x-workspace` / `x-can-share` headers. Sending
  `x-role: admin` bypasses every check. Any caller can also PUT `qa_settings` and
  make themselves admin, or overwrite `qa_testcases` with `[]`.

Goal: the server knows who is calling and decides what they may do, and passwords
never leave the server.

## Hard constraint (from the user)

**Every existing account keeps logging in with its current password.** No password
reset, no visible change to users, no migration script that rewrites the DB in bulk.
Other data (bugs, test cases, files, workspaces, roles, activity log) is not touched.

The app is used only through the server on the VM. The offline / `file://`
localStorage-only mode no longer needs to support login.

## Goals

1. Passwords stored as hashes, migrated lazily and invisibly.
2. Login verified by the server; server issues a session token.
3. Every `/api/*` route except login requires a valid token.
4. Role, permissions and workspace membership derived server-side from the token's
   user, never from client headers.
5. Passwords (plaintext or hash) never sent to the client.
6. Only admins / holders of the `usermanagement` permission can change accounts,
   roles or the permission matrix.

## Non-goals

- No change to the KV storage model, optimistic locking, merge logic, SSE design.
- No per-row authorization on `qa_testcases` / `qa_bugs` content beyond what exists
  today (existing file/bug workspace checks stay, just fed by trusted identity).
- No password reset / forgot-password flow, no password policy changes (min 4 stays).
- No SSO, no refresh tokens, no cookies-vs-header debate beyond what's below.
- No new npm dependencies (use `node:crypto`).

## Anti-goals (failure even if it "works")

**Top rule (from the user): nothing may cause data loss.** No change in this work may
delete, overwrite or drop any stored data — accounts, passwords, workspaces, roles,
files, test cases, bugs, activity log, or a browser's unsynced local changes. Every
server-side write this work adds touches only the exact field it means to change.

- Any existing user unable to log in with their current password after deploy.
- Any write that drops or rewrites stored passwords of users the request didn't edit
  (the client PUTs `qa_settings` whole and will no longer have passwords — see below).
- Bulk-modifying `qa_settings` on deploy/boot.

## Design

### Password storage (lazy migration)

- Hash format: a string `scrypt$<saltHex>$<hashHex>` from `crypto.scrypt` (random
  16-byte salt, 64-byte key). Stored in the same field `users[i].password` so the
  user record shape doesn't change. Compare with `crypto.timingSafeEqual`.
- A stored value **not** starting with `scrypt$` is legacy plaintext.
- **Local dev and prod share ONE MongoDB (confirmed by the user).** So the hash
  upgrade below runs only when `PASSWORD_HASH_UPGRADE=1` is set in the server's
  `.env`; default off. With it off, the new server verifies plaintext as-is and never
  writes passwords — so testing the new build locally, or rolling prod back to the
  old build, can't lock anyone out. The user turns it on in the VM `.env` once the
  new build is confirmed stable. Document this in `server/.env.example`.
- On successful login against a plaintext value, the server rewrites **only that
  user's** `password` to the hash, with a targeted atomic update — filter on that
  user's email **and** the old plaintext value, `$set` only `value.users.$.password`,
  `$inc rev` — never a read-modify-write of the whole `qa_settings`. If the filter no
  longer matches (someone edited meanwhile), skip the upgrade; next login retries.
  Broadcast like any PUT so open tabs re-read (their next PUT merges via the existing
  409 path). The user sees nothing.
- Seed: if `qa_settings` has no users at all, login with the existing default
  (`admin@bugrail.local` / `sama`) is created server-side, stored hashed. The client
  no longer seeds users (`Auth.ensureSeedUsers` / `DEFAULT_USERS` removed).

### Sessions

- `POST /api/login` `{ email, password }` →
  `200 { token, email, role, workspaceIds }` or `401 { error: 'Email atau password salah.' }`.
  Email matched case-insensitively (same as today's `Auth.normalizeEmail`).
- Token: `crypto.randomBytes(32).toString('hex')`. Stored in Mongo collection
  `sessions`: `{ _id: token, email, createdAt }`, TTL index on `createdAt`
  (30 days). The collection is new; creating it is not a change to existing data.
- `POST /api/logout` deletes the caller's session.
- Login rate limit: reuse the in-memory fixed-window pattern (`isTestForgeRateLimited`
  style), per IP + email, e.g. 10 attempts / 5 min.

### Auth middleware

- Applies to every `/api/*` route except `POST /api/login`. Static frontend files stay
  public (login page must load).
- Token from `Authorization: Bearer <token>`; for `GET /api/events` from `?token=`
  (EventSource can't set headers).
- Looks up the session, then the user in `qa_settings.users` by email. Missing session
  or user deleted since → `401`. Sets `req.user = { email, role, workspaceIds, perms }`
  where `perms` comes from `qa_settings.rolePermissions[role]` (admin = everything,
  same as `Auth.can`). Role `'user'` normalizes to `'user_umum'` as in `Auth.role()`.
- Active workspace: client still sends `x-workspace`. Server accepts it only if the
  user is admin or the id is in the user's workspaces (`WorkspaceCalc.userWorkspaceIds`
  semantics — check that helper for the legacy `workspaceId` field). Otherwise `403`.
- `readClientAuth(req)` is replaced by `req.user` + validated workspace; `x-role` and
  `x-can-share` headers are ignored (client stops sending them). `canShare` =
  `perms.testcase_fileShare`.

### Never leak passwords

- `GET /api/kv` and `GET /api/kv/qa_settings` strip `password` from every user.
- `PUT /api/kv/qa_settings` (client no longer has passwords):
  - The server **always ignores** an incoming `password` field and keeps the stored
    value for that user. Reason: browsers from before this change hold old copies of
    `qa_settings` with plaintext passwords in localStorage and re-send them as
    "unsynced" on boot — accepting them could silently revert a password someone
    changed since.
  - A new or changed password from User Management travels in a separate field,
    `newPassword`, on that user. Server hashes it into `password` and strips
    `newPassword` before storing. New user without `newPassword` → `400`.
  - Per-key permission, mirroring the UI gates (`app.js` `setVisible`). A key counts
    as changed only if a value **already stored** differs (ignoring passwords); keys
    that are merely added — e.g. defaults filled in by `App.ensureRoles()` /
    `ensureRolePermissions()` on every boot — are not a change, so a normal save by
    any user never gets 403'd for that. *(Designer's call.)*
    - `users`, `roles`, `rolePermissions`, `workspaces`, any `newPassword` → admin or
      `usermanagement`.
    - `bugStatusMaster` → admin or `master`.
    - `theme`, `customFieldDefs`, other Settings-page keys → admin or `settings`.
      Builder: confirm which keys `settings.js` writes; theme toggle in the header
      must keep working for everyone if it writes `qa_settings` — if so, leave
      `theme` open.
  - Only an admin may give the `admin` role, or edit / delete / set a password on an
    account whose stored role is `admin`. *(Designer's call — closes "usermanagement
    can make themselves admin".)*
  - Server-side `perms` for a role = `{ ...DEFAULT_ROLE_PERMISSIONS[role],
    ...stored.rolePermissions[role] }` — same merge as `ensureRolePermissions`, with a
    server copy of the defaults, so server and UI agree. *(Designer's call.)*
  - Existing `validateSettingsWrite` rule (no dropping top-level keys) stays.
- User email rename isn't possible (`startEditUser` disables the email input), so
  stored passwords are matched to incoming users by normalized email.

### Frontend

- Boot order changes: today `Storage.hydrate()` runs before `Auth.init()`. New:
  1. If a token is in `localStorage`, call `hydrate()` with it. `401` → clear token,
     show login.
  2. Login form → `POST /api/login` → store token + email/role (existing
     sessionStorage/seed keys can carry it) → `hydrate()` → existing workspace picker
     → `startApp()`.
- Every `fetch` to `/api` sends `Authorization: Bearer`. Call sites: `utils.js`
  (hydrate, refresh, refreshKey, sendWithMerge, mergeFromServer), `bugreport.js`
  (`/bug/analyze`), `testforge.js` (`/testforge/generate`), `app.js` EventSource
  (`?token=`). One small helper for headers; no wrapper framework.
- Any `401` during use → drop token, back to login screen (reload is fine). A `401`
  on a PUT must leave the key marked unsynced (`qa_unsynced_v2`) with its value in
  localStorage — today's 4xx branch in `sendWithMerge` clears the marker, which would
  lose that change. After re-login, `hydrate()` re-sends it as it already does.
  Same for the one-time logout everyone gets on deploy: unsynced changes survive it.
- Logout → `POST /api/logout`, then today's cleanup.
- The multi-tab "logout anywhere ends it" behavior stays, keyed on the token instead
  of the client-made `sid`.
- `Auth.role()` / `can()` remain for UI gating (hiding buttons) — fed by the login
  response / settings as today. The server is the real gate.
- Remove offline login: `hydrate()`'s localStorage fallback no longer lets someone
  in without the server. Unsynced-changes re-send (`qa_unsynced_v2`) stays.
- Old browsers' `localStorage.qa_settings` copies contain plaintext passwords: after a
  successful hydrate, overwrite the local copy with the sanitized server value.
- User Management form: password field blank on edit = "keep current" (already the
  behavior). The users list must not display or expect a password.

### Deploy behavior

- Every logged-in user is logged out once after deploy (no token yet) and logs in
  again with the same password. Acceptable.
- **Tabs still open with the old JS at deploy time.** Their PUTs carry no
  `Authorization` header. Old `sendWithMerge` treats any 4xx as "rejected, give up"
  and clears the unsynced marker — that change would be lost. So: a request with **no
  `Authorization` header at all** gets `503 { error: 'Aplikasi diperbarui — muat ulang
  halaman (Ctrl+F5).' }`. Old code keeps 5xx writes as unsynced in localStorage; after
  reload + login, the new `hydrate()` re-sends them. `401` is only for a present but
  invalid/expired token (new client, handled above).
- Old tabs' settings PUTs that still contain plaintext `password` fields are safe:
  server ignores `password` (see above).
- New Mongo collection `sessions` (+ TTL index) is the only schema addition. Nothing
  existing is dropped, renamed or bulk-rewritten.

## Testing

- Server: extend `server/test/app.test.js` (mocked `db.getDb`, never the real DB):
  login plaintext→hash upgrade, login with hash, wrong password, 401 without token,
  spoofed `x-role` ignored, foreign `x-workspace` rejected, GET strips passwords,
  settings PUT keeps passwords of untouched users, settings PUT hashes new password,
  non-admin can't change users/roles/rolePermissions.
- Note: `server/test/` is currently in `.gitignore` — flag to user, don't change.
- Frontend: manual checklist for the user (no browser automation).

## Left to the builder

- Exact module layout (new `server/auth.js` vs inside `app.js`) — keep it small.
- TTL length, rate-limit numbers within reason.
- How the client stores the token (localStorage key name).
