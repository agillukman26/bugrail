/* ==========================================================
   notifications.js — topbar bell. Built from data that already
   exists (bug status log + assignment log, open test cases), so
   there's no separate notification store. Bugs: only the creator and
   the assignee, never for their own action. Test cases: a per-file
   "not run yet" reminder for the person who created/uploaded them, and a
   per-file "draft bug to finish" reminder for the tester of auto-made drafts.
   NotifCalc is pure (no DOM) — see qa-app/test/notifications.check.js.
   ========================================================== */

const NotifCalc = {
  LIMIT: 50,
  FIXED: ['Resolved', 'Closed'],
  REOPENED: ['Reopened', 'Retest'],
  DRAFT: 'Entry', // BugReportModule.DRAFT

  // overdueAt(bug) -> ISO due time when the bug is past its SLA and not finished, else '' (BUG_FORM in the app).
  // isHigh(bug) -> true for the top Priority levels (BUG_LEVELS in the app).
  // Each event: { at, icon, head ("Bug Baru"...), text, target, note }.
  /* Reminders carry `at` = newest item's time, or today's 00:00 once it's older: they show
     as unread again once a day (and when a new item joins), not on every bell open. */
  build({ bugs = [], testcases = [], me, canBug = true, canTc = true, overdueAt = () => '', isHigh = () => false, now = new Date() }){
    const norm = e => String(e || '').trim().toLowerCase();
    const name = e => String(e || '').split('@')[0]; // login name, same as userName()
    me = norm(me);
    const events = [];
    if (!me) return { events, reminders: [] };

    const tally = (map, key, at) => {
      const r = map.get(key) || { count: 0, newest: '' };
      r.count++; if (at && at > r.newest) r.newest = at;
      map.set(key, r);
    };
    const today = new Date(now); today.setHours(0, 0, 0, 0);
    const daily = (kind, map) => [...map].map(([fileId, r]) =>
      ({ kind, fileId, count: r.count, at: r.newest > today.toISOString() ? r.newest : today.toISOString() }));
    const drafts = new Map(); // fileId -> my unfinished draft bugs
    if (canBug) bugs.forEach(b => {
      if (b.status === this.DRAFT){
        if (norm(b.tester) === me) tally(drafts, b.fileId || '', b.reportDate);
        return; // not reported yet: no activity / SLA events
      }
      const target = { type: 'bug', id: b.id, fileId: b.fileId };
      const code = b.code || b.id; // display number (see bugCode in utils.js)
      const title = b.title ? `: ${b.title}` : '';
      let assignedAt = '';
      (b.assignments || []).forEach(a => {
        if (norm(a.to) !== me || norm(a.by) === me) return;
        assignedAt = a.at;
        const isNew = b.reportDate && Math.abs(new Date(a.at) - new Date(b.reportDate)) < 60000;
        events.push(isNew
          ? { at: a.at, icon: '🐞', target, head: 'Bug Baru', text: `Bug ${code} baru telah dilaporkan dan ditugaskan kepada Anda oleh ${name(a.by)}${title}` }
          : { at: a.at, icon: '👤', target, head: 'Bug Ditugaskan', text: `Bug ${code} telah ditugaskan kepada Anda oleh ${name(a.by)}${title}` });
      });
      const finished = [...this.FIXED, 'Rejected'].includes(b.status);
      // Assigned to me by someone else and still open: flag the top priorities.
      if (assignedAt && norm(b.assignee) === me && !finished && isHigh(b))
        events.push({ at: assignedAt, icon: '🔥', target, head: 'Bug Prioritas Tinggi', text: `Bug ${code} memiliki prioritas ${b.priority}${title}` });
      const involved = norm(b.tester) === me || norm(b.assignee) === me;
      if (!involved) return;
      const due = overdueAt(b); // dated at the due time, so it shows as new once the deadline passes
      if (due) events.push({ at: due, icon: '⏰', target, head: 'Bug Lewat SLA', text: `Bug ${code} sudah lewat SLA dan belum selesai${title}` });
      (b.activity || []).forEach(a => {
        if (norm(a.email) === me) return;
        const by = a.email ? ` oleh ${name(a.email)}` : '';
        events.push(this.FIXED.includes(a.to)
          ? { at: a.at, icon: '✅', target, note: a.note || '', head: 'Bug Selesai', text: `Bug ${code} telah ditandai sebagai ${a.to}${by}${title}` }
          : { at: a.at, icon: this.REOPENED.includes(a.to) ? '🔁' : '🔄', target, note: a.note || '', head: 'Bug Diubah', text: `Bug ${code} statusnya berubah menjadi ${a.to}${by}${title}` });
      });
    });

    events.sort((a, b) => new Date(b.at) - new Date(a.at));

    // Reminder for whoever created / uploaded (imported) the test cases: one
    // line per file that still has Open (not run) test cases — not one per test case.
    const byFile = new Map();
    if (canTc) testcases.forEach(t => {
      if (t.status !== 'Open') return;
      if (norm(t.createdBy) !== me) return;
      tally(byFile, t.fileId || '', t.createdAt);
    });
    const reminders = [...daily('draft', drafts), ...daily('reminder', byFile).sort((a, b) => b.count - a.count)];

    return { events: events.slice(0, this.LIMIT), reminders };
  }
};

const NotificationCenter = {
  seenKey(){ return `qa_notif_seen_${(Auth.currentEmail() || '').toLowerCase()}`; },
  /* "Read up to" lives on the server (GET/PUT /api/notif-seen) so every laptop agrees;
     localStorage only covers the moment before that answer (or a server without the route). */
  _serverSeen: '',
  lastSeen(){
    let local = '';
    try{ local = localStorage.getItem(this.seenKey()) || ''; }catch(e){}
    return local > this._serverSeen ? local : this._serverSeen;
  },
  markSeen(){
    try{ localStorage.setItem(this.seenKey(), nowISO()); }catch(e){}
    this.seenApi('PUT');
  },
  syncSeen(){ return this.seenApi('GET'); },
  async seenApi(method){
    try{
      const res = await fetch(`${API_BASE}/notif-seen`, { method, headers: authHeaders(), signal: AbortSignal.timeout(10000) });
      if (!res.ok) return;
      const { at } = await res.json();
      if (at && at > this._serverSeen){ this._serverSeen = at; this.renderBadge(); }
    }catch(e){} // offline: the local value still works on this laptop
  },

  data(){
    return NotifCalc.build({
      bugs: BugReportModule.all(), testcases: TestCaseModule.all(), me: Auth.currentEmail(),
      canBug: Auth.can('bugreport_read'), canTc: Auth.can('testcase_read'),
      overdueAt: b => (BUG_FORM.isOverdue(b) ? BUG_FORM.dueDate(b) : ''),
      isHigh: b => BUG_LEVELS.names('priority').slice(0, 2).includes(b.priority) // e.g. Urgent, High
    });
  },

  renderBadge(){
    const badge = document.getElementById('notifBadge');
    if (!badge || !Auth.currentEmail()) return;
    const seen = this.lastSeen();
    const { events, reminders } = this.data();
    const unread = [...events, ...reminders].filter(e => !seen || e.at > seen).length;
    badge.textContent = unread > 99 ? '99+' : unread;
    badge.style.display = unread ? '' : 'none';
  },

  renderPanel(){
    const { events, reminders } = this.data();
    const seen = this.lastSeen();
    const fileName = id => (App.state.files.find(f => f.id === id) || { name: 'Tanpa File' }).name;
    // Title + file on top, one-line text below (cut with "…", full text on hover).
    const item = ({ unread, attrs, icon, head, fileId, text, note, at }) => `
        <div class="notif-item ${unread ? 'unread' : ''}" ${attrs}>
          <span class="notif-icon">${icon}</span>
          <div class="notif-body">
            <div class="notif-head"><b>${escapeHtml(head)}</b><span class="notif-file" title="${escapeHtml(fileName(fileId))}">${escapeHtml(fileName(fileId))}</span></div>
            <div class="notif-text" title="${escapeHtml(text)}">${escapeHtml(text)}</div>
            ${note ? `<div class="notif-note" title="${escapeHtml(note)}">${escapeHtml(note)}</div>` : ''}
            <div class="notif-meta">${formatDateTime(at)}</div>
          </div>
        </div>`;
    const reminderHtml = reminders.length ? `
      <div class="gs-group">Pengingat</div>
      ${reminders.map(r => item({ unread: !seen || r.at > seen, attrs: `data-kind="${r.kind}" data-file="${escapeHtml(r.fileId)}"`,
        icon: r.kind === 'draft' ? '📝' : '⏳', fileId: r.fileId, at: r.at,
        head: r.kind === 'draft' ? 'Draft Bug' : 'Test Case Belum Dijalankan',
        text: r.kind === 'draft' ? `${r.count} draft bug (Entry) belum dilengkapi.` : `${r.count} test case belum dijalankan.` })).join('')}` : '';
    const eventHtml = events.length ? `
      <div class="gs-group">Aktivitas</div>
      ${events.map(e => item({ ...e, unread: !seen || e.at > seen, fileId: e.target.fileId,
        attrs: `data-kind="${e.target.type}" data-id="${escapeHtml(e.target.id)}" data-file="${escapeHtml(e.target.fileId || '')}"` })).join('')}` : '';
    document.getElementById('notifPanel').innerHTML = (reminderHtml + eventHtml)
      || '<div class="gs-empty">Belum ada notifikasi untuk Anda.</div>';
  },

  /* "Direct ke tujuan": open the page, then the file, then the item's detail. */
  go(item){
    const { kind, id, file } = item.dataset;
    if (kind === 'bug'){
      App.goTo('bugreport');
      if (file) BugReportModule.openFile(file);
      BugReportModule.openDetail(id);
    } else if (kind === 'draft'){
      App.goTo('bugreport'); // the file's list, drafts show as "Entry"
      if (file) BugReportModule.openFile(file);
    } else {
      App.goTo('testcase');
      if (file) TestCaseModule.openFile(file); // reminder: open that file's test cases
    }
  },

  bindStaticEvents(){
    const btn = document.getElementById('notifBtn');
    const panel = document.getElementById('notifPanel');
    btn.addEventListener('click', e => {
      e.stopPropagation();
      if (panel.classList.toggle('open')){
        this.renderPanel();
        this.markSeen();
        this.renderBadge();
      }
    });
    panel.addEventListener('click', e => {
      const item = e.target.closest('.notif-item');
      if (!item) return;
      panel.classList.remove('open');
      this.go(item);
    });
    document.addEventListener('click', e => { if (!e.target.closest('.notif-wrap')) panel.classList.remove('open'); });
    // Tab left open past midnight: daily reminders turn unread again without any data change.
    setInterval(() => this.renderBadge(), 10 * 60 * 1000);
  }
};

if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', () => NotificationCenter.bindStaticEvents());
