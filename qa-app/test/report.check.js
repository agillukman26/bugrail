// Run: node qa-app/test/report.check.js
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');
const path = require('path');

const ctx = {};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/report.js'), 'utf8') + '\nthis.ReportCalc = ReportCalc;', ctx);
const R = ctx.ReportCalc;

const tcs = (passed, other = {}) => [
  ...Array(passed).fill({ status: 'Passed' }),
  ...Object.entries(other).flatMap(([status, n]) => Array(n).fill({ status }))
];
const bug = (severity, status, extra = {}) => ({ id: 'B', title: 't', severity, status, ...extra });

// Go-live verdicts
assert.strictEqual(R.goLive([], []).verdict, 'NO_GO', 'no test cases = NO GO');
assert.strictEqual(R.goLive(tcs(100), [bug('Critical', 'Closed'), bug('High', 'Rejected')]).verdict, 'GO');
assert.strictEqual(R.goLive(tcs(100), [bug('High', 'Resolved')]).verdict, 'CONDITIONAL', 'Resolved still counts as open');
assert.strictEqual(R.goLive(tcs(92, { Failed: 8 }), [bug('High', 'Open'), bug('High', 'Open')]).verdict, 'CONDITIONAL');
assert.strictEqual(R.goLive(tcs(92, { Failed: 8 }), [bug('High', 'Open'), bug('High', 'Open'), bug('High', 'Open')]).verdict, 'NO_GO', '3 High open');
assert.strictEqual(R.goLive(tcs(100), [bug('Critical', 'In Progress')]).verdict, 'NO_GO', 'Critical open');
assert.strictEqual(R.goLive(tcs(89, { Failed: 11 }), []).verdict, 'NO_GO', 'pass rate < 90');
assert.strictEqual(R.goLive(tcs(99, { Open: 1 }), []).verdict, 'CONDITIONAL', 'not-run blocks GO only');

// Per module: app verdict = worst module
const mod = (m, list) => list.map(x => ({ ...x, module: m }));
const two = R.goLive([...mod('A', tcs(100)), ...mod('B', tcs(80, { Failed: 20 }))], []);
assert.strictEqual(JSON.stringify(two.modules.map(m => [m.module, m.verdict])), JSON.stringify([['A', 'GO'], ['B', 'NO_GO']]));
assert.strictEqual(two.verdict, 'NO_GO', 'one NO GO module = app NO GO');
assert.strictEqual(two.passRate, 90, 'totals still across all modules');
assert.strictEqual(R.goLive([...mod('A', tcs(100)), ...mod('B', tcs(100))], mod('B', [bug('High', 'Open')])).verdict, 'CONDITIONAL');
assert.strictEqual(R.goLive(mod('A', tcs(100)), mod('C', [bug('Low', 'Closed')])).verdict, 'NO_GO', 'module with bugs but no test case');

// Reopen ranking
const reo = R.reopenStats([
  bug('Low', 'Open', { id: 'A', module: 'Login', activity: [{ to: 'Reopened', note: 'x' }] }),
  bug('Low', 'Open', { id: 'B', module: 'Login', activity: [{ to: 'Retest' }, { to: 'Reopened', note: 'last' }, { to: 'Closed' }] }),
  bug('Low', 'Open', { id: 'C', module: 'Pay', activity: [{ to: 'Closed' }] })
]);
assert.strictEqual(JSON.stringify(reo.rows.map(r => [r.bug.id, r.count])), JSON.stringify([['B', 2], ['A', 1]]));
assert.strictEqual(reo.rows[0].lastNote, 'last');
assert.strictEqual(reo.totalReopens, 3);
assert.strictEqual(reo.byModule[0].module, 'Login');

// Speed vs SLA
const day = 864e5, t0 = Date.parse('2026-01-01T00:00:00Z');
const at = d => new Date(t0 + d * day).toISOString();
const sp = R.speedStats([
  bug('Critical', 'Closed', { reportDate: at(0), activity: [{ to: 'Closed', at: at(0.5) }] }), // on time
  bug('High', 'Closed', { reportDate: at(0), activity: [{ to: 'Closed', at: at(5) }] }),       // late (SLA 3)
  bug('Low', 'Closed', { reportDate: at(0) }),                                                   // unmeasured
  bug('Medium', 'Open', { reportDate: at(0) }),                                                  // overdue at day 10
  bug('Low', 'Open', { reportDate: at(0) })                                                      // within 14d
], t0 + 10 * day);
assert.strictEqual(sp.measured, 2);
assert.strictEqual(sp.unmeasured, 1);
assert.strictEqual(sp.onTimePct, 50);
assert.strictEqual(sp.verdict, 'WATCH');
assert.strictEqual(sp.overdueOpen.length, 1);
assert.strictEqual(R.speedStats([]).verdict, 'NA');

// Business summary always gives a verdict + at least one next step
const biz = R.businessSummary(R.goLive([], []), R.reopenStats([]), R.speedStats([]));
assert.ok(biz.verdictText.includes('BELUM SIAP'));
assert.ok(biz.nextSteps.length >= 1);

console.log('report.check.js: all checks passed');
