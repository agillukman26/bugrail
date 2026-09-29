// Run: node qa-app/test/bugcode.check.js
// Bug display numbers are counted per workspace; the internal id stays unique.
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '../js/utils.js'), 'utf8');
const pick = re => src.match(re)[0];
const store = {};
const ctx = { Storage: { get: (k, d) => store[k] ?? d, set: (k, v) => { store[k] = JSON.parse(JSON.stringify(v)); } }, STORAGE_KEYS: { COUNTERS: 'qa_counters' } };
vm.createContext(ctx);
vm.runInContext(pick(/function bugCode.*/) + '\n' + pick(/const IdGen = \{[\s\S]*?\n\};/) + '\nthis.IdGen = IdGen; this.bugCode = bugCode;', ctx);
const { IdGen, bugCode } = ctx;

assert.strictEqual(IdGen.nextFor('BUG', 'WS-A'), 'BUG-0001');
assert.strictEqual(IdGen.nextFor('BUG', 'WS-A'), 'BUG-0002');
assert.strictEqual(IdGen.nextFor('BUG', 'WS-B'), 'BUG-0001', 'each workspace starts at 0001');
assert.strictEqual(IdGen.nextFor('BUG', null), 'BUG-0001', 'files without workspace share one counter');
assert.strictEqual(IdGen.nextFor('BUG', undefined), 'BUG-0002');

const a = IdGen.uid('BUG'), b = IdGen.uid('BUG');
assert.notStrictEqual(a, b, 'internal ids are unique');
assert.strictEqual(bugCode({ id: a, code: 'BUG-0001' }), 'BUG-0001');
assert.strictEqual(bugCode({ id: 'BUG-0009' }), 'BUG-0009', 'legacy bugs without code show their id');

console.log('bugcode.check.js: all checks passed');
