/* ==========================================================
   notifications.js — topbar bell. Built from data that already
   exists (bug status log + assignment log, open test cases), so
   there's no separate notification store. Bugs: only the creator and
   the assignee, never for their own action. Test cases: a per-file
   "not run yet" reminder for the person who created/uploaded them.
   NotifCalc is pure (no DOM) — see qa-app/test/notifications.check.js.
   ========================================================== */

const NotifCalc = {
  LIMIT: 50,
  FIXED: ['Resolved', 'Closed'],
  REOPENED: ['Reopened', 'Retest'],

  build({ bugs = [], testcases = [], me, canBug = true, canTc = true }){
    const norm = e => String(e || '').trim().toLowerCase();
    me = norm(me);
    const events = [];
    if (!me) return { events, reminders: [] };

    if (canBug) bugs.forEach(b => {
      const target = { type: 'bug', id: b.id, fileId: b.fileId };
      const code = b.code || b.id; // display number (see bugCode in utils.js)
      const title = b.title ? `: ${b.title}` : '';
      (b.assignments || []).forEach(a => {
        if (norm(a.to) !== me || norm(a.by) === me) return;
        const isNew = b.reportDate && Math.abs(new Date(a.at) - new Date(b.reportDate)) < 60000;
        events.push({ at: a.at, icon: '🐞', target,
          text: isNew ? `Bug baru ${code} dibuat & di-assign ke Anda oleh ${a.by}${title}` : `${code} di-assign ke Anda oleh ${a.by}${title}` });
      });
      const involved = norm(b.tester) === me || norm(b.assignee) === me;
      if (!involved) return;
      (b.activity || []).forEach(a => {
        if (norm(a.email) === me) return;
        const icon = this.FIXED.includes(a.to) ? '✅' : this.REOPENED.includes(a.to) ? '🔁' : '🔄';
        const label = this.FIXED.includes(a.to) ? ' (diperbaiki)' : '';
        events.push({ at: a.at, icon, target, note: a.note || '',
          text: `${code}: ${a.from} → ${a.to}${label}${a.email ? ` oleh ${a.email}` : ''}${title}` });
      });
    });

    events.sort((a, b) => new Date(b.at) - new Date(a.at));

    // Reminder for whoever created / uploaded (imported) the test cases: one
    // line per file that still has Open (not run) test cases — not one per test case.
    const byFile = new Map();
    if (canTc) testcases.forEach(t => {
      if (t.status !== 'Open') return;
      if (norm(t.createdBy) !== me) return;
      const key = t.fileId || '';
      byFile.set(key, (byFile.get(key) || 0) + 1);
    });
    const reminders = [...byFile].map(([fileId, count]) => ({ fileId, count })).sort((a, b) => b.count - a.count);

    return { events: events.slice(0, this.LIMIT), reminders };
  }
};

const NotificationCenter = {
  seenKey(){ return `qa_notif_seen_${(Auth.currentEmail() || '').toLowerCase()}`; },
  lastSeen(){
    try{ return localStorage.getItem(this.seenKey()) || ''; }catch(e){ return ''; }
  },
  markSeen(){
    try{ localStorage.setItem(this.seenKey(), nowISO()); }catch(e){}
  },

  data(){
    return NotifCalc.build({
      bugs: BugReportModule.all(), testcases: TestCaseModule.all(), me: Auth.currentEmail(),
      canBug: Auth.can('bugreport_read'), canTc: Auth.can('testcase_read')
    });
  },

  renderBadge(){
    const badge = document.getElementById('notifBadge');
    if (!badge || !Auth.currentEmail()) return;
    const seen = this.lastSeen();
    const unread = this.data().events.filter(e => !seen || e.at > seen).length;
    badge.textContent = unread > 99 ? '99+' : unread;
    badge.style.display = unread ? '' : 'none';
  },

  renderPanel(){
    const { events, reminders } = this.data();
    const seen = this.lastSeen();
    const fileName = id => (App.state.files.find(f => f.id === id) || { name: 'Tanpa File' }).name;
    const reminderHtml = reminders.length ? `
      <div class="gs-group">Pengingat</div>
      ${reminders.map(r => `
        <div class="notif-item" data-kind="reminder" data-file="${escapeHtml(r.fileId)}">
          <span class="notif-icon">⏳</span>
          <div><div class="notif-text">${r.count} test case belum dijalankan</div><div class="notif-meta">File: ${escapeHtml(fileName(r.fileId))}</div></div>
        </div>`).join('')}` : '';
    const eventHtml = events.length ? `
      <div class="gs-group">Aktivitas</div>
      ${events.map(e => `
        <div class="notif-item ${!seen || e.at > seen ? 'unread' : ''}" data-kind="${e.target.type}" data-id="${escapeHtml(e.target.id)}" data-file="${escapeHtml(e.target.fileId || '')}">
          <span class="notif-icon">${e.icon}</span>
          <div>
            <div class="notif-text">${escapeHtml(e.text)}</div>
            ${e.note ? `<div class="notif-note">${escapeHtml(e.note)}</div>` : ''}
            <div class="notif-meta">${formatDateTime(e.at)}</div>
          </div>
        </div>`).join('')}` : '';
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
  }
};

if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', () => NotificationCenter.bindStaticEvents());
