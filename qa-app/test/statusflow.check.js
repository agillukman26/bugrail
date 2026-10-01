// Run: node qa-app/test/statusflow.check.js
// Bug status rules: free dev flow, QA restricted to moves out of Retest (with a note).
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '../js/utils.js'), 'utf8');
const ctx = {};
vm.createContext(ctx);
vm.runInContext(src.match(/function statusTransitionRule[\s\S]*?\r?\n}/)[0] + '\nthis.rule = statusTransitionRule;', ctx);
const { rule } = ctx;

// Dev flow: no note
assert.deepStrictEqual({ ...rule('OPEN', 'IN_PROGRESS', false) }, { ok: true, needNote: false });
assert.deepStrictEqual({ ...rule('IN_PROGRESS', 'RETEST', false) }, { ok: true, needNote: false });
assert.deepStrictEqual({ ...rule('RETEST', 'OPEN', false) }, { ok: true, needNote: false });
// Outside the dev flow: note required
assert.deepStrictEqual({ ...rule('RETEST', 'CLOSED', false) }, { ok: true, needNote: true });
assert.deepStrictEqual({ ...rule('OPEN', 'REJECTED', false) }, { ok: true, needNote: true });

// QA: only from Retest to Open/Blocked/Resolved/Closed, always with a note
['OPEN', 'BLOCKED', 'RESOLVED', 'CLOSED'].forEach(to =>
  assert.deepStrictEqual({ ...rule('RETEST', to, true) }, { ok: true, needNote: true }, to));
assert.strictEqual(rule('RETEST', 'IN_PROGRESS', true).ok, false);
assert.strictEqual(rule('RETEST', 'REJECTED', true).ok, false);
assert.strictEqual(rule('OPEN', 'IN_PROGRESS', true).ok, false);
assert.strictEqual(rule('CLOSED', 'OPEN', true).ok, false);

console.log('statusflow.check.js OK');
