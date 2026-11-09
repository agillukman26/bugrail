// Run: node qa-app/test/notifications.check.js
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');
const path = require('path');

const ctx = {};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/notifications.js'), 'utf8') + '\nthis.NotifCalc = NotifCalc;', ctx);
const N = ctx.NotifCalc;

// Draft bug (Entry): no events, one reminder per file for its tester only.
const dr = N.build({ bugs: [
  { id: 'D1', status: 'Entry', tester: 'qa@x.com', fileId: 'F1', reportDate: '2026-01-01T00:00:00Z', assignments: [{ at: '2026-01-01T00:00:00Z', to: 'qa@x.com', by: 'x@x.com' }] },
  { id: 'D2', status: 'Entry', tester: 'qa@x.com', fileId: 'F1' }
], me: 'qa@x.com', overdueAt: () => '2026-01-02T00:00:00Z' });
assert.strictEqual(dr.events.length, 0);
assert.strictEqual(JSON.stringify(dr.reminders.map(({ at, ...r }) => r)), '[{"kind":"draft","fileId":"F1","count":2}]');
// Daily: an old draft's reminder is dated today 00:00; one made today keeps its own time.
const day0 = new Date('2026-03-10T15:00:00'); const mid = new Date(day0); mid.setHours(0, 0, 0, 0);
const draftAt = d => N.build({ bugs: [{ id: 'D', status: 'Entry', tester: 'qa@x.com', reportDate: d }], me: 'qa@x.com', now: day0 }).reminders[0].at;
assert.strictEqual(draftAt('2026-01-01T00:00:00Z'), mid.toISOString());
assert.strictEqual(draftAt(new Date('2026-03-10T14:00:00').toISOString()), new Date('2026-03-10T14:00:00').toISOString());
assert.strictEqual(N.build({ bugs: [{ id: 'D1', status: 'Entry', tester: 'qa@x.com' }], me: 'dev@x.com' }).reminders.length, 0);
const texts = r => r.events.map(e => e.text);

const bugs = [{
  id: 'BUG-1', title: 'Gagal bayar', tester: 'qa@x.com', assignee: 'dev@x.com', fileId: 'F1',
  reportDate: '2026-01-01T00:00:00Z',
  assignments: [{ at: '2026-01-01T00:00:10Z', to: 'dev@x.com', by: 'qa@x.com' }],
  activity: [
    { at: '2026-01-02T00:00:00Z', from: 'Open', to: 'In Progress', email: 'dev@x.com', note: 'mulai' },
    { at: '2026-01-03T00:00:00Z', from: 'In Progress', to: 'Closed', email: 'dev@x.com', note: 'fixed' }
  ]
}, {
  id: 'BUG-2', title: 'Orang lain', tester: 'other@x.com', assignee: 'other2@x.com',
  activity: [{ at: '2026-01-02T00:00:00Z', from: 'Open', to: 'Closed', email: 'other2@x.com' }]
}];

// Creator gets the status changes made by others, never BUG-2 (not involved)
const qa = N.build({ bugs, me: 'QA@x.com' });
assert.strictEqual(qa.events.length, 2);
assert.ok(texts(qa)[0].includes('telah ditandai sebagai Closed oleh dev'), 'newest first + fixed label');
assert.strictEqual(qa.events[0].head, 'Bug Selesai');
assert.strictEqual(qa.events[1].head, 'Bug Diubah');
assert.strictEqual(qa.events[0].target.fileId, 'F1');

// Assignee gets "new bug assigned", but not their own status changes
const dev = N.build({ bugs, me: 'dev@x.com' });
assert.strictEqual(dev.events.length, 1);
assert.ok(texts(dev)[0].startsWith('Bug BUG-1 baru telah dilaporkan dan ditugaskan kepada Anda oleh qa'));
assert.strictEqual(dev.events[0].head, 'Bug Baru');
// High priority, still open, assigned by someone else: one extra event for the assignee only.
const high = { isHigh: b => b.id === 'BUG-1' };
assert.strictEqual(N.build({ bugs: [{ ...bugs[0], status: 'Open', priority: 'Urgent' }], me: 'dev@x.com', ...high }).events.filter(e => e.head === 'Bug Prioritas Tinggi').length, 1);
assert.strictEqual(N.build({ bugs: [{ ...bugs[0], status: 'Closed' }], me: 'dev@x.com', ...high }).events.filter(e => e.head === 'Bug Prioritas Tinggi').length, 0, 'Closed: no flag');
assert.strictEqual(N.build({ bugs: [{ ...bugs[0], status: 'Open' }], me: 'qa@x.com', ...high }).events.filter(e => e.head === 'Bug Prioritas Tinggi').length, 0, 'tester: no flag');

// Uninvolved user: nothing; no user: nothing
assert.strictEqual(N.build({ bugs, me: 'nobody@x.com' }).events.length, 0);
assert.strictEqual(N.build({ bugs, me: '' }).events.length, 0);
assert.strictEqual(N.build({ bugs, me: 'qa@x.com', canBug: false }).events.length, 0, 'respects bugreport_read');

// Test cases: per-file reminder for the creator/uploader only
const testcases = [
  { id: 'TC-1', status: 'Open', createdBy: 'dev@x.com', fileId: 'F1' },
  { id: 'TC-2', status: 'Open', createdBy: 'DEV@x.com', fileId: 'F1' },
  { id: 'TC-3', status: 'Open', createdBy: 'dev@x.com', fileId: 'F2' },
  { id: 'TC-4', status: 'Passed', createdBy: 'dev@x.com', fileId: 'F1' },  // already run: no reminder
  { id: 'TC-5', status: 'Open', createdBy: 'qa@x.com', fileId: 'F1' }       // someone else's
];
const devTc = N.build({ testcases, me: 'dev@x.com' });
assert.strictEqual(devTc.events.length, 0, 'no test case events, reminders only');
assert.strictEqual(JSON.stringify(devTc.reminders.map(({ at, ...r }) => r)), JSON.stringify([{ kind: 'reminder', fileId: 'F1', count: 2 }, { kind: 'reminder', fileId: 'F2', count: 1 }]));
assert.strictEqual(N.build({ testcases, me: 'qa@x.com' }).reminders.length, 1);
assert.strictEqual(N.build({ testcases, me: 'dev@x.com', canTc: false }).reminders.length, 0);

// Past SLA: creator and assignee both get it, dated at the due time; others don't
{
  const overdueAt = b => (b.id === 'BUG-1' ? '2026-01-04T23:59:59.000Z' : '');
  const late = r => r.events.filter(e => e.icon === '⏰');
  assert.strictEqual(late(N.build({ bugs, me: 'qa@x.com', overdueAt })).length, 1, 'creator');
  const dev = late(N.build({ bugs, me: 'dev@x.com', overdueAt }));
  assert.strictEqual(dev.length, 1, 'assignee');
  assert.strictEqual(dev[0].at, '2026-01-04T23:59:59.000Z');
  assert.ok(dev[0].text.includes('lewat SLA'));
  assert.strictEqual(late(N.build({ bugs, me: 'other@x.com', overdueAt })).length, 0, 'BUG-2 not overdue');
  assert.strictEqual(late(N.build({ bugs, me: 'x@x.com', overdueAt })).length, 0, 'not involved');
}

console.log('notifications.check.js: all checks passed');
