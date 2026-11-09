// Run: node qa-app/test/storage.check.js
// A save that doesn't reach the server must survive a reload and be re-sent,
// instead of being overwritten by the (older) server copy.
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '../js/utils.js'), 'utf8');
const storageSrc = src.match(/const Storage = \{[\s\S]*?\n\};/)[0] + '\n' + src.match(/const KvMerge = \{[\s\S]*?\n\};/)[0];

function makeEnv(server){
  const ls = {};
  const puts = [];
  const expired = { n: 0 };
  const toasts = [];
  const ctx = {
    localStorage: { getItem: k => (k in ls ? ls[k] : null), setItem: (k, v) => { ls[k] = String(v); }, removeItem: k => { delete ls[k]; } },
    STORAGE_KEYS: { TESTCASES: 'qa_testcases' },
    API_BASE: '/api',
    Auth: { role: () => 'admin', currentWorkspaceId: () => '', can: () => true, sessionExpired(){ expired.n++; this._expiring = true; } },
    authHeaders: (extra = {}) => ({ ...extra, Authorization: 'Bearer t' }),
    Toast: { show: msg => toasts.push(msg) },
    AbortSignal: { timeout: () => undefined },
    console: { error(){} },
    fetch: async (url, opts = {}) => {
      if (!server.up) throw new Error('ERR_CONNECTION_REFUSED');
      if (server.status401 || (server.status401OnGet && opts.method !== 'PUT')) return { ok: false, status: 401, json: async () => ({ error: 'x' }) };
      server.revs = server.revs || {};
      const key = url.split('/').pop();
      if (opts.method === 'PUT'){
        const { value, rev } = JSON.parse(opts.body);
        if (server.putStatus === 200 && rev !== (server.revs[key] || 0)) return { ok: false, status: 409, json: async () => ({ stale: true }) };
        if (server.putStatus === 200){ server.data[key] = value; server.revs[key] = (server.revs[key] || 0) + 1; }
        puts.push(key);
        return { ok: server.putStatus === 200, status: server.putStatus, json: async () => ({ rev: server.revs[key] }) };
      }
      const copy = v => JSON.parse(JSON.stringify(v));
      const auth = server.old ? {} : { _auth: 1 }; // old server builds don't send _auth
      if (key !== 'kv') return { ok: true, status: 200, json: async () => ({ value: copy(server.data[key] ?? null), rev: server.revs[key] || 0, ...auth }) };
      return { ok: true, status: 200, json: async () => ({ ...copy(server.data), _revs: { ...server.revs }, ...auth }) };
    }
  };
  vm.createContext(ctx);
  vm.runInContext(storageSrc + '\nthis.Storage = Storage;', ctx);
  return { S: ctx.Storage, ls, puts, ctx, expired, toasts };
}

(async () => {
  // 1) Server down while saving -> kept as unsynced, survives reload, re-sent when server is back
  const server = { up: true, putStatus: 200, data: { qa_testcases: [{ id: 'OLD' }] } };
  let env = makeEnv(server);
  await env.S.hydrate();
  server.up = false;
  await env.S.set('qa_testcases', [{ id: 'OLD' }, { id: 'NEW' }]);
  assert.ok(env.S.hasUnsynced(), 'failed save is marked unsynced');

  server.up = true;
  const reopened = makeEnv(server);
  Object.assign(reopened.ls, env.ls);                 // same browser, new page load
  await reopened.S.hydrate();
  assert.strictEqual(JSON.stringify(reopened.S.get('qa_testcases').map(t => t.id)), '["OLD","NEW"]', 'local unsynced copy wins over older server copy');
  assert.deepStrictEqual(reopened.puts, [], 'hydrate merges but does not PUT (no workspace chosen yet)');
  assert.strictEqual(JSON.stringify(server.data.qa_testcases.map(t => t.id)), '["OLD"]');
  assert.strictEqual(await reopened.S.flushPending(), 1);
  assert.ok(reopened.toasts.some(m => /1 perubahan yang belum tersimpan sudah dikirim/.test(m)), 'flush toast');
  assert.strictEqual(JSON.stringify(server.data.qa_testcases.map(t => t.id)), '["OLD","NEW"]', 're-sent to server on load');
  assert.ok(!reopened.S.hasUnsynced(), 'cleared once the server has it');

  // 2) HTTP error (e.g. 500/403) is a failure too, not a silent success
  server.putStatus = 500;
  await reopened.S.set('qa_testcases', [{ id: 'X' }]);
  assert.ok(reopened.S.hasUnsynced(), 'HTTP 500 keeps the change unsynced');
  server.putStatus = 200;

  // 3) Normal save: nothing left pending
  const ok = makeEnv({ up: true, putStatus: 200, data: {} });
  await ok.S.hydrate();
  await ok.S.set('qa_testcases', [{ id: 'A' }]);
  assert.ok(!ok.S.hasUnsynced());

  // 4) Booted offline (fresh browser, no real data): saves stay local and are NEVER
  //    sent later — this is how a seed qa_settings once replaced the real one.
  const real = { up: false, putStatus: 200, data: { qa_settings: { users: ['a', 'b'], workspaces: ['WS-1'] } } };
  const offline = makeEnv(real);
  await offline.S.hydrate();
  await offline.S.set('qa_settings', { users: ['seed-admin'] });
  real.up = true;
  await offline.S.set('qa_settings', { users: ['seed-admin'], theme: 'dark' }); // server back mid-session: still local only
  assert.deepStrictEqual(offline.puts, [], 'offline-boot session never PUTs');
  const later = makeEnv(real);
  Object.assign(later.ls, offline.ls);
  await later.S.hydrate();
  assert.deepStrictEqual(later.puts, [], 'nothing re-sent on the next online load');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(real.data.qa_settings)), { users: ['a', 'b'], workspaces: ['WS-1'] }, 'real settings untouched');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(later.S.get('qa_settings'))), { users: ['a', 'b'], workspaces: ['WS-1'] }, 'online load shows server data');

  // 5) Two tabs, same old copy: tab A edits row 1, tab B (stale) edits row 2.
  //    B's write is refused (409), merged with A's, re-sent: both edits survive.
  const shared = { up: true, putStatus: 200, data: { qa_testcases: [{ id: '1', status: 'Open' }, { id: '2', status: 'Open' }] } };
  const A = makeEnv(shared), B = makeEnv(shared);
  await A.S.hydrate(); await B.S.hydrate();
  await A.S.set('qa_testcases', [{ id: '1', status: 'Failed' }, { id: '2', status: 'Open' }]);
  let merged = 0; B.S.onMerged = () => merged++;
  await B.S.set('qa_testcases', [{ id: '1', status: 'Open' }, { id: '2', status: 'Passed' }, { id: '3', status: 'Open' }]);
  assert.strictEqual(JSON.stringify(shared.data.qa_testcases.map(t => t.status)), '["Failed","Passed","Open"]', "stale tab keeps the other tab's Failed");
  assert.strictEqual(merged, 1, 'app told to reload the merged data');
  assert.ok(!B.S.hasUnsynced());

  // 6) Deletes merge too: A deletes row 1, stale B adds row 4 -> row 1 stays deleted.
  await A.S.refresh();
  await A.S.set('qa_testcases', shared.data.qa_testcases.filter(t => t.id !== '1'));
  await B.S.set('qa_testcases', [...B.S.get('qa_testcases'), { id: '4', status: 'Open' }]);
  assert.strictEqual(JSON.stringify(shared.data.qa_testcases.map(t => t.id)), '["2","3","4"]');

  // 7) Back-to-back saves from one tab are queued, not refused as stale by each other.
  const q = makeEnv({ up: true, putStatus: 200, data: { qa_testcases: [] } });
  await q.S.hydrate();
  await Promise.all([q.S.set('qa_testcases', [{ id: 'a' }]), q.S.set('qa_testcases', [{ id: 'a' }, { id: 'b' }])]);
  assert.ok(!q.S.hasUnsynced());

  // 8) refreshKey (live chat poll): pulls another tab's write, then no-ops while nothing changed.
  const live = { up: true, putStatus: 200, data: { qa_bugs: [] } };
  const L1 = makeEnv(live), L2 = makeEnv(live);
  await L1.S.hydrate(); await L2.S.hydrate();
  assert.strictEqual(await L2.S.refreshKey('qa_bugs'), false, 'nothing new yet');
  await L1.S.set('qa_bugs', [{ id: 'chat' }]);
  assert.strictEqual(await L2.S.refreshKey('qa_bugs'), true, 'newer rev pulled');
  assert.strictEqual(L2.S.get('qa_bugs')[0].id, 'chat');
  assert.strictEqual(await L2.S.refreshKey('qa_bugs'), false, 'same rev: nothing to redraw');
  await L2.S.set('qa_bugs', [{ id: 'chat' }, { id: 'b' }]);
  assert.deepStrictEqual(L2.puts, ['qa_bugs'], 'rev from refreshKey accepted first try (no 409)');

  // 9) 401 on PUT: unsynced marker + local copy survive, session-expired fired; hydrate 401 touches nothing.
  const au = { up: true, putStatus: 200, data: { qa_testcases: [{ id: 'S' }] } };
  const U = makeEnv(au);
  assert.strictEqual(await U.S.hydrate(), 'ok');
  au.status401 = true;
  assert.strictEqual(await U.S.set('qa_testcases', [{ id: 'S' }, { id: 'N' }]), false);
  assert.ok(U.S.hasUnsynced(), '401 keeps the unsynced marker');
  assert.ok(U.ls.qa_testcases.includes('"N"'), '401 keeps the local copy');
  assert.strictEqual(U.expired.n, 1, 'Auth.sessionExpired called');
  const U2 = makeEnv(au);
  Object.assign(U2.ls, U.ls);
  assert.strictEqual(await U2.S.hydrate(), 'unauthorized');
  assert.ok(U2.S.hasUnsynced() && U2.ls.qa_testcases.includes('"N"'), 'hydrate 401 leaves unsynced data alone');
  au.status401 = false;
  assert.strictEqual(await U2.S.hydrate(), 'ok');
  assert.deepStrictEqual(U2.puts, [], 'not sent before the workspace is chosen');
  await U2.S.flushPending();
  assert.deepStrictEqual(au.data.qa_testcases.map(t => t.id), ['S', 'N'], 're-sent after re-login');

  // 10) hydrate scrubs password from settings users (cache + localStorage).
  const pw = makeEnv({ up: true, putStatus: 200, data: { qa_settings: { users: [{ email: 'a', password: 'p', role: 'x' }] } } });
  await pw.S.hydrate();
  assert.deepStrictEqual(JSON.parse(JSON.stringify(pw.S.get('qa_settings').users)), [{ email: 'a', role: 'x' }]);
  assert.ok(!pw.ls.qa_settings.includes('password'));

  // 10b) An unsynced newPassword survives hydrate, is re-sent by flushPending, then dropped locally.
  const np = { up: true, putStatus: 200, data: { qa_settings: { users: [{ email: 'a', role: 'x' }] } } };
  const NP = makeEnv(np);
  NP.ls.qa_settings = JSON.stringify({ users: [{ email: 'a', role: 'x', password: 'old' }, { email: 'b', role: 'x', newPassword: 'pw-b' }] });
  NP.ls.qa_unsynced_v2 = '["qa_settings"]';
  await NP.S.hydrate();
  assert.strictEqual(NP.S.get('qa_settings').users[1].newPassword, 'pw-b', 'pending newPassword kept by hydrate');
  assert.ok(!NP.ls.qa_settings.includes('"password"'), 'stored password scrubbed');
  await NP.S.flushPending();
  assert.strictEqual(np.data.qa_settings.users[1].newPassword, 'pw-b', 'new user re-sent with its password');
  assert.ok(!NP.S.hasUnsynced());
  assert.ok(!('newPassword' in NP.S.get('qa_settings').users[1]) && !NP.ls.qa_settings.includes('newPassword'), 'dropped once confirmed');

  // 10c) forgetNewPasswords only drops the one that was sent, and only if unchanged.
  NP.S.cache.qa_settings.users = [{ email: 'a', newPassword: 'changed' }, { email: 'b', newPassword: 'other' }];
  NP.S.forgetNewPasswords([['a', 'sent'], ['b', 'other']]);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(NP.S.cache.qa_settings.users)), [{ email: 'a', newPassword: 'changed' }, { email: 'b' }]);

  // 11) PUT 409 stale, then the merge GET 401s: marker + local copy must survive.
  const m = { up: true, putStatus: 200, data: { qa_testcases: [{ id: 'S' }] } };
  const M = makeEnv(m), M2 = makeEnv(m);
  await M.S.hydrate(); await M2.S.hydrate();
  await M2.S.set('qa_testcases', [{ id: 'S' }, { id: 'T' }]); // bumps rev: M is now stale
  m.status401OnGet = true;
  assert.strictEqual(await M.S.set('qa_testcases', [{ id: 'S' }, { id: 'U' }]), false);
  assert.ok(M.S.hasUnsynced(), '409 then merge-GET 401 keeps the unsynced marker');
  assert.strictEqual(M.expired.n, 1);

  // 12) Old server build (GET without _auth): hydrate boots offline and never PUTs.
  const old = { up: true, putStatus: 200, old: true, data: { qa_settings: { users: [{ email: 'a', password: 'p' }] }, qa_testcases: [] } };
  const O = makeEnv(old);
  O.ls.qa_testcases = '[{"id":"LOCAL"}]';
  O.ls.qa_unsynced_v2 = '["qa_testcases"]';
  assert.strictEqual(await O.S.hydrate(), 'offline');
  assert.ok(O.S.offlineBoot);
  assert.ok(O.toasts.some(m => /Server versi lama terdeteksi/.test(m)));
  assert.strictEqual(await O.S.flushPending(), 0);
  await O.S.set('qa_settings', { users: [{ email: 'a' }], theme: 'dark' });
  assert.deepStrictEqual(O.puts, [], 'never writes to an old server');
  assert.deepStrictEqual(JSON.parse(O.ls.qa_unsynced_v2), ['qa_testcases'], 'unsynced marker kept for the new server');

  // 13) Rolled back mid-session: refresh / refreshKey see no _auth => stop writing.
  const rb = { up: true, putStatus: 200, data: { qa_bugs: [] } };
  const R = makeEnv(rb), R2 = makeEnv(rb);
  await R.S.hydrate(); await R2.S.hydrate();
  rb.old = true;
  assert.strictEqual(await R.S.refresh(), false);
  assert.ok(R.S.offlineBoot && R.toasts.some(m => /Server versi lama/.test(m)));
  await R.S.set('qa_bugs', [{ id: 'x' }]);
  assert.deepStrictEqual(R.puts, [], 'no PUT after refresh saw an old server');
  assert.strictEqual(await R2.S.refreshKey('qa_bugs'), false);
  assert.ok(R2.S.offlineBoot);

  // 14) PUT 409, then the merge GET hits an old server: marker kept, no retry PUT.
  const ms = { up: true, putStatus: 200, data: { qa_testcases: [{ id: 'S' }] } };
  const MS = makeEnv(ms), MS2 = makeEnv(ms);
  await MS.S.hydrate(); await MS2.S.hydrate();
  await MS2.S.set('qa_testcases', [{ id: 'S' }, { id: 'T' }]);
  ms.old = true;
  assert.strictEqual(await MS.S.set('qa_testcases', [{ id: 'S' }, { id: 'U' }]), false);
  assert.ok(MS.S.hasUnsynced(), 'old server on merge keeps the unsynced marker');
  assert.deepStrictEqual(ms.data.qa_testcases.map(t => t.id), ['S', 'T'], 'nothing written after the old server was seen');

  // 15) Stale unsynced copy from an earlier session must not revert newer server rows.
  //     Browser X saved row 2 + new row 3 while the server was down; meanwhile another
  //     user ran row 1 (Open -> Failed). X reloads: row 1 stays Failed, X's edits land.
  const sv = { up: true, putStatus: 200, data: { qa_testcases: [{ id: '1', status: 'Open' }, { id: '2', status: 'Open' }] } };
  const X = makeEnv(sv);
  await X.S.hydrate();
  sv.up = false;
  await X.S.set('qa_testcases', [{ id: '1', status: 'Open' }, { id: '2', status: 'Passed' }, { id: '3', status: 'Open' }]);
  sv.up = true;
  const other = makeEnv(sv);
  await other.S.hydrate();
  await other.S.set('qa_testcases', [{ id: '1', status: 'Failed' }, { id: '2', status: 'Open' }]);
  const X2 = makeEnv(sv);
  Object.assign(X2.ls, X.ls);
  await X2.S.hydrate();
  await X2.S.flushPending();
  assert.strictEqual(JSON.stringify(sv.data.qa_testcases.map(t => t.status)), '["Failed","Passed","Open"]', "other user's run survives, X's edits land");
  assert.strictEqual(X2.ls['qa_testcases__base'], undefined, 'base dropped once synced');

  // 16) Legacy pending copy (no saved base): server wins on its rows, only new rows are added.
  const lg = { up: true, putStatus: 200, data: { qa_testcases: [{ id: '1', status: 'Failed' }] } };
  const LG = makeEnv(lg);
  LG.ls.qa_testcases = JSON.stringify([{ id: '1', status: 'Open' }, { id: '9', status: 'Open' }]);
  LG.ls.qa_unsynced_v2 = JSON.stringify(['qa_testcases']);
  await LG.S.hydrate();
  assert.strictEqual(JSON.stringify(LG.S.get('qa_testcases').map(t => t.id + t.status)), '["1Failed","9Open"]');

  console.log('storage.check.js: all checks passed');
})().catch(e => { console.error(e); process.exit(1); });
