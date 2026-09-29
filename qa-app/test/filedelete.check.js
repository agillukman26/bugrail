// Run: node qa-app/test/filedelete.check.js
// Test Case and Bug Report share one file list, so deleting a file from
// either page must remove BOTH its test cases and its bugs (no orphans).
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');
const path = require('path');

const ctx = {};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/app.js'), 'utf8') + '\nthis.App = App;', ctx);
const App = ctx.App;
const saved = [];
App.saveFiles = () => saved.push('files');
App.saveTestcases = () => saved.push('testcases');
App.saveBugs = () => saved.push('bugs');

App.state.files = [{ id: 'F1' }, { id: 'F2' }];
App.state.testcases = [{ id: 'T1', fileId: 'F1' }, { id: 'T2', fileId: 'F2' }];
App.state.bugs = [{ id: 'B1', fileId: 'F1' }, { id: 'B2', fileId: 'F2' }, { id: 'B3', fileId: 'F1' }];

App.deleteFileCascade('F1');

assert.strictEqual(JSON.stringify(App.state.files.map(f => f.id)), '["F2"]');
assert.strictEqual(JSON.stringify(App.state.testcases.map(t => t.id)), '["T2"]');
assert.strictEqual(JSON.stringify(App.state.bugs.map(b => b.id)), '["B2"]', 'bugs in the deleted file are removed too');
assert.ok(['files', 'testcases', 'bugs'].every(k => saved.includes(k)), 'all three collections persisted');

console.log('filedelete.check.js: all checks passed');
