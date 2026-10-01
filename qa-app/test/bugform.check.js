// Run: node qa-app/test/bugform.check.js
// Bug report form rules: required fields (Environment section optional), URL lines, similar titles.
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '../js/utils.js'), 'utf8');
const ctx = { URL };
vm.createContext(ctx);
vm.runInContext(src.match(/const BUG_FORM = \{[\s\S]*?\n\};/)[0] + '\n' + src.match(/function normPriority.*/)[0] + '\nthis.F = BUG_FORM; this.normPriority = normPriority;', ctx);
const { F, normPriority } = ctx;

const valid = {
  title: 'Login gagal dengan password valid', module: 'Login', steps: '1. Buka login 2. Klik', expectedResult: 'Masuk dashboard',
  actualResult: 'Error invalid', description: '', severity: 'High', attachments: 'https://prnt.sc/abc'
};
const keys = o => Object.keys(o).sort().join(',');

assert.strictEqual(keys(F.errors(valid)), '', 'complete form is valid');
assert.strictEqual(keys(F.errors({})), 'actualResult,expectedResult,module,severity,steps,title', 'Environment fields are optional');
assert.strictEqual(keys(F.errors({}, false)), 'actualResult,title', 'edit keeps the old minimum');

assert.ok(F.errors({ ...valid, title: 'abcd' }).title, 'title < 5');
assert.ok(F.errors({ ...valid, title: 'x'.repeat(151) }).title, 'title > 150');
assert.ok(!F.errors({ ...valid, title: '  abcde  ' }).title, 'title is trimmed');
assert.ok(F.errors({ ...valid, steps: 'short' }).steps, 'steps < 10');
assert.ok(F.errors({ ...valid, description: 'x'.repeat(2001) }).description, 'notes > 2000');

// Conditional Browser / Device (shown, not required)
assert.strictEqual(keys(F.errors({ ...valid, platform: 'Web', browser: '' })), '', 'Browser optional');
assert.strictEqual(JSON.stringify(F.conditionalFields('Web')), '{"browser":true,"device":false}');
assert.strictEqual(JSON.stringify(F.conditionalFields('Mobile App')), '{"browser":false,"device":true}');
assert.strictEqual(JSON.stringify(F.conditionalFields('Desktop')), '{"browser":false,"device":false}');
assert.strictEqual(JSON.stringify(F.conditionalFields('')), '{"browser":false,"device":false}');

// Attachment links: each line an http(s) URL
assert.ok(!F.errors({ ...valid, attachments: 'https://a.com/x\n\nhttp://b.id' }).attachments);
assert.ok(F.errors({ ...valid, attachments: 'https://a.com\nprnt.sc/abc' }).attachments, 'missing scheme');
assert.ok(F.errors({ ...valid, attachments: 'javascript:alert(1)' }).attachments, 'non-http scheme');

// Similar open bugs by title
const bugs = [
  { id: 1, title: 'Login gagal dengan password valid', status: 'Open' },
  { id: 2, title: 'Login gagal dengan password valid', status: 'Closed' },
  { id: 3, title: 'Tombol simpan tidak muncul', status: 'Open' },
  { id: 4, title: 'Gagal login walau password benar dan valid', status: 'Retest' }
];
assert.strictEqual(JSON.stringify(F.similar('login gagal password', bugs).map(b => b.id)), JSON.stringify([1, 4]), 'closed bugs skipped');
assert.strictEqual(JSON.stringify(F.similar('abc', bugs).map(b => b.id)), JSON.stringify([]), 'min 5 chars');
assert.strictEqual(JSON.stringify(F.similar('Export excel error', bugs).map(b => b.id)), JSON.stringify([]));

assert.strictEqual(normPriority('Highest'), 'Urgent');
assert.strictEqual(normPriority('Critical'), 'Urgent');
assert.strictEqual(normPriority('High'), 'High');

console.log('bugform.check.js OK');
