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
vm.runInContext(pick(/function bugCode.*/) + '\n' + pick(/function compareRows[\s\S]*?\r?\n}/) + '\n' + pick(/const IdGen = \{[\s\S]*?\n\};/) + '\nthis.IdGen = IdGen; this.bugCode = bugCode; this.compareRows = compareRows;', ctx);
const { IdGen, bugCode, compareRows } = ctx;

// Next number = highest number still present in that workspace + 1 (no stored counter),
// so deleting test cases / bugs frees their numbers instead of leaving the counter high.
assert.strictEqual(IdGen.nextInScope('BUG', []), 'BUG-0001', 'empty workspace starts at 0001');
assert.strictEqual(IdGen.nextInScope('BUG', ['BUG-0001', 'BUG-0002']), 'BUG-0003');
assert.strictEqual(IdGen.nextInScope('BUG', ['BUG-0001']), 'BUG-0002', 'after deleting BUG-0002, it is reused');

const a = IdGen.uid('BUG'), b = IdGen.uid('BUG');
assert.notStrictEqual(a, b, 'internal ids are unique');
assert.strictEqual(bugCode({ id: a, code: 'BUG-0001' }), 'BUG-0001');
assert.strictEqual(bugCode({ id: 'BUG-0009' }), 'BUG-0009', 'legacy bugs without code show their id');

// Test cases: per module prefix; other prefixes and legacy/odd ids are ignored
assert.strictEqual(IdGen.nextInScope('LOG', ['LOG-0001', 'LOG-0003', 'PAY-0009', 'ERP-1', 'x']), 'LOG-0004', 'gap in the middle stays (no renumbering)');
assert.strictEqual(IdGen.nextInScope('PAY', ['LOG-0001']), 'PAY-0001');
assert.strictEqual(IdGen.nextInScope('LOG', []), 'LOG-0001', 'all deleted -> back to 0001');

// Sorting by the "id" column uses the shown number, naturally (not the random internal key)
const rows = [{ id: 'TC-z', code: 'LOG-0010' }, { id: 'TC-a', code: 'LOG-0002' }, { id: 'TC-m', code: 'LOG-0001' }];
const code = r => r.code || r.id;
assert.strictEqual(JSON.stringify(rows.slice().sort((a, b) => compareRows(a, b, 'id', 'asc', code)).map(code)), '["LOG-0001","LOG-0002","LOG-0010"]');
assert.strictEqual(JSON.stringify(rows.slice().sort((a, b) => compareRows(a, b, 'id', 'desc', code)).map(code)), '["LOG-0010","LOG-0002","LOG-0001"]');

console.log('bugcode.check.js: all checks passed');
