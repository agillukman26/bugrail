// Run: node qa-app/test/storage.check.js
// A save that doesn't reach the server must survive a reload and be re-sent,
// instead of being overwritten by the (older) server copy.
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '../js/utils.js'), 'utf8');
const storageSrc = src.match(/const Storage = \{[\s\S]*?\n\};/)[0];

function makeEnv(server){
  const ls = {};
  const puts = [];
  const ctx = {
    localStorage: { getItem: k => (k in ls ? ls[k] : null), setItem: (k, v) => { ls[k] = String(v); }, removeItem: k => { delete ls[k]; } },
    STORAGE_KEYS: { TESTCASES: 'qa_testcases' },
    API_BASE: '/api',
    Auth: { role: () => 'admin', currentWorkspaceId: () => '', can: () => true },
    Toast: { show(){} },
    AbortSignal: { timeout: () => undefined },
    console: { error(){} },
    fetch: async (url, opts = {}) => {
      if (!server.up) throw new Error('ERR_CONNECTION_REFUSED');
      if (opts.method === 'PUT'){
        const key = url.split('/').pop();
        server.data[key] = JSON.parse(opts.body).value;
        puts.push(key);
        return { ok: server.putStatus === 200, status: server.putStatus, json: async () => ({}) };
      }
      return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(server.data)) };
    }
  };
  vm.createContext(ctx);
  vm.runInContext(storageSrc + '\nthis.Storage = Storage;', ctx);
  return { S: ctx.Storage, ls, puts, ctx };
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

  console.log('storage.check.js: all checks passed');
})().catch(e => { console.error(e); process.exit(1); });
