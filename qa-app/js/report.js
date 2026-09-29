/* ==========================================================
   report.js — Go-Live readiness report for PM/BA:
   go-live verdict, reopen/retest ranking, bug fix speed vs SLA,
   and a plain-language summary for the business team.
   ReportCalc is pure (no DOM) so it can be checked in Node —
   see qa-app/test/report.check.js.
   ========================================================== */

const ReportCalc = {
  // Thresholds — tweak here. ponytail: constants, move to Settings if PM/BA need to change them often.
  GO_PASS_RATE: 95,
  COND_PASS_RATE: 90,
  COND_MAX_HIGH_OPEN: 2,
  SLA_DAYS: { Critical: 1, High: 3, Medium: 7, Low: 14 },
  SPEED_FAST_PCT: 80,
  SPEED_OK_PCT: 50,
  DONE_STATUSES: ['Closed', 'Rejected'],       // Resolved is not done: QA hasn't verified it yet
  REOPEN_STATUSES: ['Reopened', 'Retest'],     // same as BugReportModule.reopenCount

  isOpen(bug){ return !this.DONE_STATUSES.includes(bug.status); },

  /* Verdict is judged per module; the app verdict is the worst module
     (one NO GO module = app NO GO). Totals are kept for the summary text. */
  goLive(tcs, bugs){
    const key = x => x.module || '(Tanpa Module)';
    const names = [...new Set([...tcs, ...bugs].map(key))].sort();
    const modules = names.map(m => ({ module: m, ...this.evaluate(tcs.filter(t => key(t) === m), bugs.filter(b => key(b) === m)) }));
    const rank = { NO_GO: 0, CONDITIONAL: 1, GO: 2 };
    const verdict = modules.length ? modules.reduce((w, m) => rank[m.verdict] < rank[w] ? m.verdict : w, 'GO') : 'NO_GO';
    return { ...this.evaluate(tcs, bugs), verdict, modules };
  },

  evaluate(tcs, bugs){
    const total = tcs.length;
    const passed = tcs.filter(t => t.status === 'Passed').length;
    const notRun = tcs.filter(t => t.status === 'Open').length;
    const blocked = tcs.filter(t => t.status === 'Blocked').length;
    const passRate = total ? Math.round(passed / total * 1000) / 10 : 0;
    const openBugs = bugs.filter(b => this.isOpen(b));
    const openCritical = openBugs.filter(b => b.severity === 'Critical');
    const openHigh = openBugs.filter(b => b.severity === 'High');

    const criteria = [
      { label: `Pass rate minimal ${this.GO_PASS_RATE}%`, ok: passRate >= this.GO_PASS_RATE, actual: `${passRate}% (${passed}/${total})` },
      { label: 'Semua test case sudah dieksekusi', ok: total > 0 && notRun === 0, actual: `${notRun} belum dijalankan` },
      { label: 'Tidak ada test case Blocked', ok: blocked === 0, actual: `${blocked} blocked` },
      { label: 'Tidak ada bug Critical terbuka', ok: openCritical.length === 0, actual: `${openCritical.length} terbuka` },
      { label: 'Tidak ada bug High terbuka', ok: openHigh.length === 0, actual: `${openHigh.length} terbuka` }
    ];

    let verdict = 'NO_GO';
    if (total && criteria.every(c => c.ok)) verdict = 'GO';
    else if (total && passRate >= this.COND_PASS_RATE && !openCritical.length && openHigh.length <= this.COND_MAX_HIGH_OPEN) verdict = 'CONDITIONAL';

    return { verdict, criteria, total, passed, notRun, blocked, passRate, openBugs, openCritical, openHigh };
  },

  reopenStats(bugs){
    const rows = bugs.map(b => {
      const reopens = (b.activity || []).filter(a => this.REOPEN_STATUSES.includes(a.to));
      const last = reopens[reopens.length - 1];
      return { bug: b, count: reopens.length, lastNote: last ? (last.note || '') : '' };
    }).filter(r => r.count > 0).sort((a, b) => b.count - a.count);

    const moduleMap = {};
    rows.forEach(r => {
      const m = r.bug.module || '(Tanpa Module)';
      moduleMap[m] = moduleMap[m] || { module: m, bugs: 0, reopens: 0 };
      moduleMap[m].bugs++;
      moduleMap[m].reopens += r.count;
    });
    const byModule = Object.values(moduleMap).sort((a, b) => b.reopens - a.reopens);
    const totalReopens = rows.reduce((sum, r) => sum + r.count, 0);
    return { rows, byModule, totalReopens };
  },

  /* Fix time = reportDate -> last "-> Closed" entry in the status log. Bugs closed
     without a logged transition (imported/old data) can't be measured. */
  speedStats(bugs, now = Date.now()){
    const slaHours = sev => (this.SLA_DAYS[sev] || this.SLA_DAYS.Medium) * 24;
    const bySeverity = {};
    Object.keys(this.SLA_DAYS).forEach(s => { bySeverity[s] = { count: 0, onTime: 0, totalHours: 0 }; });
    let measured = 0, onTime = 0, unmeasured = 0;
    const overdueOpen = [];

    bugs.forEach(b => {
      const sev = this.SLA_DAYS[b.severity] ? b.severity : 'Medium';
      if (b.status === 'Closed'){
        const closed = (b.activity || []).filter(a => a.to === 'Closed');
        const hours = closed.length && b.reportDate ? (new Date(closed[closed.length - 1].at) - new Date(b.reportDate)) / 36e5 : NaN;
        if (!(hours >= 0)){ unmeasured++; return; }
        measured++;
        bySeverity[sev].count++;
        bySeverity[sev].totalHours += hours;
        if (hours <= slaHours(sev)){ onTime++; bySeverity[sev].onTime++; }
      } else if (this.isOpen(b) && b.reportDate){
        const age = (now - new Date(b.reportDate)) / 36e5;
        if (age > slaHours(sev)) overdueOpen.push({ bug: b, ageHours: age, slaHours: slaHours(sev) });
      }
    });

    Object.values(bySeverity).forEach(s => { s.avgHours = s.count ? s.totalHours / s.count : 0; });
    overdueOpen.sort((a, b) => (b.ageHours - b.slaHours) - (a.ageHours - a.slaHours));
    const onTimePct = measured ? Math.round(onTime / measured * 100) : null;
    const verdict = onTimePct === null ? 'NA'
      : onTimePct >= this.SPEED_FAST_PCT ? 'FAST'
      : onTimePct >= this.SPEED_OK_PCT ? 'WATCH' : 'SLOW';
    return { measured, onTime, unmeasured, onTimePct, bySeverity, overdueOpen, verdict };
  },

  /* Plain-language lines for PM/BA — no QA jargon ("pass rate", "severity"). */
  businessSummary(g, r, s){
    const verdictText = {
      GO: 'Aplikasi SIAP untuk go-live — semua module memenuhi kriteria.',
      CONDITIONAL: 'Aplikasi SIAP go-live DENGAN SYARAT — beberapa masalah penting di module tertentu harus disepakati penanganannya dulu.',
      NO_GO: 'Aplikasi BELUM SIAP untuk go-live — ada module yang belum memenuhi kriteria.'
    }[g.verdict];
    const points = [];
    const reasons = m => {
      if (!m.total) return 'belum ada skenario pengujian';
      const out = [];
      if (m.passRate < this.GO_PASS_RATE) out.push(`baru ${m.passRate}% skenario berhasil`);
      if (m.notRun) out.push(`${m.notRun} skenario belum diuji`);
      if (m.blocked) out.push(`${m.blocked} skenario terhambat`);
      if (m.openCritical.length) out.push(`${m.openCritical.length} masalah kritis`);
      if (m.openHigh.length) out.push(`${m.openHigh.length} masalah berat`);
      return out.join(', ');
    };
    const byVerdict = v => (g.modules || []).filter(m => m.verdict === v);
    if (byVerdict('GO').length) points.push(`Module siap go-live: ${byVerdict('GO').map(m => m.module).join(', ')}.`);
    if (byVerdict('CONDITIONAL').length) points.push(`Module siap dengan syarat: ${byVerdict('CONDITIONAL').map(m => `${m.module} (${reasons(m)})`).join('; ')}.`);
    if (byVerdict('NO_GO').length) points.push(`Module belum siap: ${byVerdict('NO_GO').map(m => `${m.module} (${reasons(m)})`).join('; ')}.`);
    if (!g.total){
      points.push('Belum ada skenario pengujian yang tercatat, sehingga kualitas aplikasi belum bisa dinilai.');
    } else {
      points.push(`Dari ${g.total} skenario pengujian, ${g.passed} (${g.passRate}%) sudah berjalan sesuai harapan.`);
      if (g.notRun) points.push(`${g.notRun} skenario belum diuji — ada bagian aplikasi yang kualitasnya belum terjamin.`);
      if (g.blocked) points.push(`${g.blocked} skenario tidak bisa diuji karena terhambat (misalnya menunggu data, akses, atau environment).`);
    }
    const titles = list => list.slice(0, 3).map(b => `"${b.title}"`).join(', ') + (list.length > 3 ? `, dan ${list.length - 3} lainnya` : '');
    if (g.openCritical.length) points.push(`Masih ada ${g.openCritical.length} masalah KRITIS yang bisa menghentikan proses bisnis utama: ${titles(g.openCritical)}.`);
    if (g.openHigh.length) points.push(`Masih ada ${g.openHigh.length} masalah BERAT yang mengganggu pengguna: ${titles(g.openHigh)}.`);
    if (!g.openCritical.length && !g.openHigh.length && g.total) points.push('Tidak ada masalah kritis atau berat yang masih terbuka.');

    if (r.rows.length){
      const worst = r.byModule[0];
      points.push(`${r.rows.length} masalah muncul kembali setelah dinyatakan sudah diperbaiki (total ${r.totalReopens} kali). Area paling sering bermasalah: ${worst.module}. Ini tanda perbaikan belum tuntas.`);
    }

    if (s.verdict !== 'NA'){
      const speedWord = { FAST: 'cepat', WATCH: 'cukup, namun perlu perhatian', SLOW: 'lambat' }[s.verdict];
      points.push(`Kecepatan perbaikan ${speedWord}: ${s.onTimePct}% masalah diselesaikan sesuai target waktu.`);
    }
    if (s.overdueOpen.length) points.push(`${s.overdueOpen.length} masalah yang masih terbuka sudah melewati target waktu penyelesaian.`);

    const nextSteps = [];
    if (g.openCritical.length) nextSteps.push('Selesaikan dan uji ulang semua masalah kritis sebelum menjadwalkan go-live.');
    if (g.openHigh.length) nextSteps.push(g.verdict === 'CONDITIONAL'
      ? 'Putuskan bersama tim developer & QA: masalah berat yang tersisa diperbaiki sebelum go-live, atau diterima dengan solusi sementara (workaround) dan jadwal perbaikan.'
      : 'Prioritaskan perbaikan masalah berat yang masih terbuka.');
    if (g.notRun || g.blocked) nextSteps.push('Tuntaskan pengujian skenario yang belum diuji / terhambat agar seluruh fitur terverifikasi.');
    if (r.rows.some(x => x.count >= 3)) nextSteps.push('Masalah yang berulang 3 kali atau lebih perlu dibahas bersama tim developer dan BA — kemungkinan kebutuhan (requirement) belum jelas.');
    if (s.verdict === 'SLOW' || s.overdueOpen.length) nextSteps.push('Evaluasi kapasitas dan prioritas tim developer agar perbaikan sesuai target waktu.');
    if (!nextSteps.length) nextSteps.push('Lanjutkan persiapan go-live (sosialisasi pengguna, rencana rollback, dan monitoring setelah rilis).');

    return { verdictText, points, nextSteps };
  }
};

const ReportModule = {
  filters: { fileId: '', module: '' },

  filtered(list){
    return list.filter(x =>
      (!this.filters.fileId || x.fileId === this.filters.fileId) &&
      (!this.filters.module || x.module === this.filters.module));
  },

  renderFilterOptions(){
    const fileEl = document.getElementById('rptFilterFile');
    fileEl.innerHTML = `<option value="">Semua File</option>` +
      Auth.visibleFiles(App.state.files).map(f => `<option value="${f.id}" ${f.id === this.filters.fileId ? 'selected' : ''}>${escapeHtml(f.name)}</option>`).join('');
    const modEl = document.getElementById('rptFilterModule');
    const modules = [...new Set([...TestCaseModule.all(), ...BugReportModule.all()].map(x => x.module).filter(Boolean))].sort();
    modEl.innerHTML = `<option value="">Semua Module</option>` +
      modules.map(m => `<option value="${escapeHtml(m)}" ${m === this.filters.module ? 'selected' : ''}>${escapeHtml(m)}</option>`).join('');
  },

  render(){
    this.renderFilterOptions();
    const tcs = this.filtered(TestCaseModule.all());
    const bugs = this.filtered(BugReportModule.all());
    const g = ReportCalc.goLive(tcs, bugs);
    const r = ReportCalc.reopenStats(bugs);
    const s = ReportCalc.speedStats(bugs);
    const biz = ReportCalc.businessSummary(g, r, s);
    this._last = { g, r, s, biz };

    const verdictMeta = {
      GO: ['go', '🟢 GO', 'Siap go-live'],
      CONDITIONAL: ['cond', '🟡 CONDITIONAL GO', 'Siap go-live dengan syarat'],
      NO_GO: ['nogo', '🔴 NO GO', 'Belum siap go-live']
    }[g.verdict];
    const speedMeta = {
      FAST: ['go', 'Cepat'], WATCH: ['cond', 'Perlu perhatian'], SLOW: ['nogo', 'Lambat'], NA: ['na', 'Belum ada data']
    }[s.verdict];
    const verdictPill = { GO: ['go', 'GO'], CONDITIONAL: ['cond', 'CONDITIONAL'], NO_GO: ['nogo', 'NO GO'] };
    const bugLink = b => `<span class="mono">${escapeHtml(bugCode(b))}</span>`;
    const empty = (cols, text) => `<tr><td colspan="${cols}" class="text-faint">${text}</td></tr>`;

    document.getElementById('rptBody').innerHTML = `
      <div class="sum-section rpt-verdict rpt-${verdictMeta[0]}">
        <div class="rpt-verdict-badge">${verdictMeta[1]}</div>
        <div>
          <div class="rpt-verdict-title">${verdictMeta[2]}</div>
          <div class="text-dim" style="font-size:13px;">Berdasarkan ${g.total} test case dan ${bugs.length} bug pada filter ini.</div>
        </div>
      </div>

      <div class="sum-section">
        <div class="sum-section-head"><span class="icon">💼</span><h2>Ringkasan untuk PM &amp; BA</h2>
          <div class="spacer"></div><button class="btn sm" id="rptCopyBtn">📋 Salin Ringkasan</button></div>
        <p class="rpt-lead"><b>${escapeHtml(biz.verdictText)}</b></p>
        <ul class="rpt-list">${biz.points.map(p => `<li>${escapeHtml(p)}</li>`).join('')}</ul>
        <div class="rpt-subhead">Langkah selanjutnya</div>
        <ol class="rpt-list">${biz.nextSteps.map(p => `<li>${escapeHtml(p)}</li>`).join('')}</ol>
      </div>

      <div class="sum-section">
        <div class="sum-section-head"><span class="icon">🚦</span><h2>Kesiapan Go-Live per Module</h2></div>
        <p class="sum-hint">Tiap module dinilai sendiri. GO bila pass rate ≥ ${ReportCalc.GO_PASS_RATE}%, semua test case sudah dijalankan, tidak ada yang Blocked, dan tidak ada bug Critical/High terbuka. CONDITIONAL GO bila pass rate ≥ ${ReportCalc.COND_PASS_RATE}%, tanpa bug Critical terbuka, dan bug High terbuka maks. ${ReportCalc.COND_MAX_HIGH_OPEN}. Vonis aplikasi = vonis module terburuk. Bug dianggap selesai bila berstatus ${ReportCalc.DONE_STATUSES.join(' / ')}.</p>
        <div class="table-wrap"><table class="data-table">
          <thead><tr><th>Module</th><th>Test Case</th><th>Pass Rate</th><th>Belum Jalan</th><th>Blocked</th><th>Critical Terbuka</th><th>High Terbuka</th><th>Vonis</th></tr></thead>
          <tbody>${g.modules.length ? [...g.modules, { ...g, module: 'TOTAL APLIKASI', isTotal: true }].map(m => `<tr${m.isTotal ? ' class="rpt-total"' : ''}>
            <td>${escapeHtml(m.module)}</td><td>${m.total}</td><td>${m.total ? `${m.passRate}%` : '-'}</td><td>${m.notRun}</td><td>${m.blocked}</td>
            <td>${m.openCritical.length}</td><td>${m.openHigh.length}</td>
            <td><span class="rpt-pill rpt-${verdictPill[m.verdict][0]}">${verdictPill[m.verdict][1]}</span></td></tr>`).join('') : empty(8, 'Belum ada data test case / bug.')}</tbody>
        </table></div>
        ${g.openCritical.length || g.openHigh.length ? `
          <div class="rpt-subhead">Bug Critical/High yang masih terbuka</div>
          <div class="table-wrap"><table class="data-table">
            <thead><tr><th>ID</th><th>Judul</th><th>Module</th><th>Severity</th><th>Status</th></tr></thead>
            <tbody>${[...g.openCritical, ...g.openHigh].map(b => `<tr class="row-clickable" data-bug-id="${escapeHtml(b.id)}"><td>${bugLink(b)}</td><td class="truncate" title="${escapeHtml(b.title)}">${escapeHtml(b.title)}</td><td>${escapeHtml(b.module || '-')}</td><td>${escapeHtml(b.severity)}</td><td>${escapeHtml(b.status)}</td></tr>`).join('')}</tbody>
          </table></div>` : ''}
      </div>

      <div class="sum-section">
        <div class="sum-section-head"><span class="icon">🔁</span><h2>Bug Sering Reopen / Retest</h2>
          <div class="spacer"></div><button class="btn sm" id="rptExportReopenBtn" ${r.rows.length ? '' : 'disabled'}>⬇ Export Excel</button></div>
        <p class="sum-hint">${r.rows.length} bug pernah dibuka ulang, total ${r.totalReopens} kali. Dihitung dari riwayat perpindahan status ke ${ReportCalc.REOPEN_STATUSES.join(' / ')}.</p>
        <div class="table-wrap"><table class="data-table">
          <thead><tr><th>ID</th><th>Judul</th><th>Module</th><th>Severity</th><th>Status</th><th>Jumlah Reopen</th><th>Keterangan Terakhir</th></tr></thead>
          <tbody>${r.rows.length ? r.rows.map(x => `<tr class="row-clickable" data-bug-id="${escapeHtml(x.bug.id)}"><td>${bugLink(x.bug)}</td><td class="truncate" title="${escapeHtml(x.bug.title)}">${escapeHtml(x.bug.title)}</td><td>${escapeHtml(x.bug.module || '-')}</td><td>${escapeHtml(x.bug.severity || '-')}</td><td>${escapeHtml(x.bug.status)}</td><td><b>${x.count}x</b></td><td class="truncate" title="${escapeHtml(x.lastNote)}">${escapeHtml(x.lastNote || '-')}</td></tr>`).join('') : empty(7, 'Belum ada bug yang di-reopen.')}</tbody>
        </table></div>
        ${r.byModule.length ? `
          <div class="rpt-subhead">Rekap per Module</div>
          <div class="table-wrap"><table class="data-table">
            <thead><tr><th>Module</th><th>Bug Reopen</th><th>Total Reopen</th></tr></thead>
            <tbody>${r.byModule.map(m => `<tr><td>${escapeHtml(m.module)}</td><td>${m.bugs}</td><td>${m.reopens}x</td></tr>`).join('')}</tbody>
          </table></div>` : ''}
      </div>

      <div class="sum-section">
        <div class="sum-section-head"><span class="icon">⏱️</span><h2>Kecepatan Penanganan Bug</h2>
          <span class="rpt-pill rpt-${speedMeta[0]}">${speedMeta[1]}</span></div>
        <p class="sum-hint">Waktu dari bug dilaporkan sampai Closed, dibandingkan target (SLA): ${Object.entries(ReportCalc.SLA_DAYS).map(([k, v]) => `${k} ${v} hari`).join(', ')}.
          ${s.measured ? `${s.onTime} dari ${s.measured} bug (${s.onTimePct}%) selesai tepat waktu.` : ''}
          ${s.unmeasured ? `${s.unmeasured} bug Closed tidak bisa diukur karena tidak punya riwayat status.` : ''}</p>
        <div class="table-wrap"><table class="data-table">
          <thead><tr><th>Severity</th><th>Target</th><th>Bug Selesai</th><th>Rata-rata Durasi</th><th>Tepat Waktu</th></tr></thead>
          <tbody>${Object.entries(s.bySeverity).map(([sev, v]) => `<tr><td>${sev}</td><td>${ReportCalc.SLA_DAYS[sev]} hari</td><td>${v.count}</td><td>${formatDuration(v.avgHours)}</td><td>${v.count ? `${v.onTime}/${v.count} (${Math.round(v.onTime / v.count * 100)}%)` : '-'}</td></tr>`).join('')}</tbody>
        </table></div>
        <div class="rpt-subhead">Bug terbuka yang melewati target</div>
        <div class="table-wrap"><table class="data-table">
          <thead><tr><th>ID</th><th>Judul</th><th>Severity</th><th>Status</th><th>Umur</th><th>Target</th></tr></thead>
          <tbody>${s.overdueOpen.length ? s.overdueOpen.map(x => `<tr class="row-clickable" data-bug-id="${escapeHtml(x.bug.id)}"><td>${bugLink(x.bug)}</td><td class="truncate" title="${escapeHtml(x.bug.title)}">${escapeHtml(x.bug.title)}</td><td>${escapeHtml(x.bug.severity || '-')}</td><td>${escapeHtml(x.bug.status)}</td><td>${formatDuration(x.ageHours)}</td><td>${formatDuration(x.slaHours)}</td></tr>`).join('') : empty(6, 'Tidak ada bug terbuka yang melewati target. 👍')}</tbody>
        </table></div>
      </div>`;

    document.getElementById('rptCopyBtn').addEventListener('click', () => this.copySummary());
    document.getElementById('rptExportReopenBtn').addEventListener('click', () => this.exportReopenExcel());
    document.getElementById('rptBody').onclick = e => {
      const row = e.target.closest('tr[data-bug-id]');
      if (row) BugReportModule.openDetail(row.dataset.bugId);
    };
  },

  async copySummary(){
    const { biz } = this._last;
    const text = [biz.verdictText, '', ...biz.points.map(p => `• ${p}`), '', 'Langkah selanjutnya:', ...biz.nextSteps.map((p, i) => `${i + 1}. ${p}`)].join('\n');
    try{
      await navigator.clipboard.writeText(text);
      Toast.show('Ringkasan disalin — tinggal paste ke email/chat.', 'success');
    }catch(e){
      Toast.show('Gagal menyalin ke clipboard.', 'error');
    }
  },

  async exportReopenExcel(){
    const { r } = this._last;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Reopen');
    ws.columns = [
      { header: 'Bug ID', key: 'id', width: 14 }, { header: 'Judul', key: 'title', width: 40 },
      { header: 'Module', key: 'module', width: 18 }, { header: 'Severity', key: 'severity', width: 12 },
      { header: 'Status', key: 'status', width: 14 }, { header: 'Jumlah Reopen', key: 'count', width: 14 },
      { header: 'Keterangan Terakhir', key: 'note', width: 40 }
    ];
    r.rows.forEach(x => ws.addRow({ id: bugCode(x.bug), title: x.bug.title, module: x.bug.module, severity: x.bug.severity, status: x.bug.status, count: x.count, note: x.lastNote }));
    ws.getRow(1).font = { bold: true };
    const buf = await wb.xlsx.writeBuffer();
    downloadBlob(buf, 'Report_Bug_Reopen.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  },

  /* PDF for PM/BA — same data as the page, business summary first. Same
     visual language as Summary.exportPDF. */
  exportPDF(){
    const { g, r, s, biz } = this._last;
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF();
    const pageW = doc.internal.pageSize.getWidth();
    const pageH = doc.internal.pageSize.getHeight();
    const ink = [31, 41, 55], dim = [107, 114, 128], line = [222, 226, 232], soft = [246, 247, 249];
    // Built-in PDF fonts are WinAnsi only — swap the symbols the UI text uses.
    const t = str => String(str ?? '').replace(/≥/g, '>=').replace(/≤/g, '<=').replace(/→/g, '->').replace(/[—–]/g, '-').replace(/[^\x00-\xFF]/g, '');
    const ensureSpace = (y, needed) => (y + needed > pageH - 16) ? (doc.addPage(), 18) : y;
    const sectionTitle = (text, y) => {
      y = ensureSpace(y, 20);
      doc.setFont('helvetica', 'bold'); doc.setFontSize(11.5); doc.setTextColor(...ink);
      doc.text(t(text), 14, y);
      doc.setDrawColor(...line); doc.setLineWidth(.4); doc.line(14, y + 2, pageW - 14, y + 2);
      doc.setFont('helvetica', 'normal');
      return y + 8;
    };
    const paragraph = (lines, y, { bullet = null, bold = false } = {}) => {
      doc.setFont('helvetica', bold ? 'bold' : 'normal'); doc.setFontSize(10); doc.setTextColor(...ink);
      lines.forEach((text, i) => {
        const prefix = bullet === 'num' ? `${i + 1}. ` : bullet ? '- ' : '';
        const wrapped = doc.splitTextToSize(t(text), pageW - 28 - (prefix ? 6 : 0));
        y = ensureSpace(y, wrapped.length * 5);
        if (prefix) doc.text(prefix, 14, y);
        doc.text(wrapped, prefix ? 20 : 14, y);
        y += wrapped.length * 5 + 1.5;
      });
      return y;
    };
    const table = (y, head, body, columnStyles = {}) => {
      doc.autoTable({
        startY: y, head: [head.map(t)], body: body.map(row => row.map(t)), theme: 'grid',
        headStyles: { fillColor: soft, textColor: ink, fontStyle: 'bold', lineColor: line, lineWidth: .3 },
        bodyStyles: { textColor: ink, lineColor: line, lineWidth: .3, valign: 'top' },
        styles: { fontSize: 8.5, font: 'helvetica', cellPadding: 2 },
        columnStyles, margin: { left: 14, right: 14 }
      });
      return doc.lastAutoTable.finalY + 10;
    };

    // Header
    doc.setFont('helvetica', 'bold'); doc.setFontSize(16); doc.setTextColor(...ink);
    doc.text('Go-Live Readiness Report', 14, 18);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(...dim);
    doc.text(`Generated: ${new Date().toLocaleString('id-ID')}`, pageW - 14, 18, { align: 'right' });
    doc.setDrawColor(...ink); doc.setLineWidth(.6); doc.line(14, 22, pageW - 14, 22);
    const file = App.state.files.find(f => f.id === this.filters.fileId);
    const filterBits = [file && `File: ${file.name}`, this.filters.module && `Module: ${this.filters.module}`].filter(Boolean);
    doc.text(t(`Filter: ${filterBits.join(' | ') || 'Semua Data'}  -  ${g.total} test case, ${this.filtered(BugReportModule.all()).length} bug`), 14, 28);

    // Verdict banner
    const verdict = {
      GO: ['GO - Siap go-live', [30, 158, 107], [228, 247, 238]],
      CONDITIONAL: ['CONDITIONAL GO - Siap go-live dengan syarat', [217, 138, 43], [252, 241, 225]],
      NO_GO: ['NO GO - Belum siap go-live', [214, 69, 80], [252, 233, 234]]
    }[g.verdict];
    doc.setFillColor(...verdict[2]); doc.rect(14, 33, pageW - 28, 16, 'F');
    doc.setFillColor(...verdict[1]); doc.rect(14, 33, 2.5, 16, 'F');
    doc.setFont('helvetica', 'bold'); doc.setFontSize(14); doc.setTextColor(...verdict[1]);
    doc.text(verdict[0], 21, 43.5);

    let y = sectionTitle('Ringkasan untuk PM & BA', 60);
    y = paragraph([biz.verdictText], y, { bold: true }) + 1;
    y = paragraph(biz.points, y, { bullet: true }) + 3;
    y = ensureSpace(y, 12);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.text('Langkah selanjutnya:', 14, y); y += 6;
    y = paragraph(biz.nextSteps, y, { bullet: 'num' }) + 6;

    y = sectionTitle('Kesiapan Go-Live per Module', y);
    const verdictLabel = { GO: 'GO', CONDITIONAL: 'CONDITIONAL', NO_GO: 'NO GO' };
    y = table(y, ['Module', 'Test Case', 'Pass Rate', 'Belum Jalan', 'Blocked', 'Critical Terbuka', 'High Terbuka', 'Vonis'],
      [...g.modules, { ...g, module: 'TOTAL APLIKASI' }].map(m => [m.module, m.total, m.total ? `${m.passRate}%` : '-', m.notRun, m.blocked,
        m.openCritical.length, m.openHigh.length, verdictLabel[m.verdict]]),
      { 0: { cellWidth: 40 } });
    y = paragraph([`Vonis aplikasi = vonis module terburuk. GO: pass rate >= ${ReportCalc.GO_PASS_RATE}%, semua test case dijalankan, tidak ada Blocked, tidak ada bug Critical/High terbuka. CONDITIONAL: pass rate >= ${ReportCalc.COND_PASS_RATE}%, tanpa Critical terbuka, High terbuka maks. ${ReportCalc.COND_MAX_HIGH_OPEN}.`], y - 5) + 6;
    if (g.openCritical.length || g.openHigh.length){
      y = sectionTitle('Bug Critical / High yang Masih Terbuka', y);
      y = table(y, ['ID', 'Judul', 'Module', 'Severity', 'Status'],
        [...g.openCritical, ...g.openHigh].map(b => [bugCode(b), b.title, b.module || '-', b.severity, b.status]), { 1: { cellWidth: 70 } });
    }

    y = sectionTitle(`Bug Sering Reopen / Retest (${r.rows.length} bug, total ${r.totalReopens}x)`, y);
    if (r.rows.length){
      y = table(y, ['ID', 'Judul', 'Module', 'Severity', 'Status', 'Reopen', 'Keterangan Terakhir'],
        r.rows.map(x => [bugCode(x.bug), x.bug.title, x.bug.module || '-', x.bug.severity || '-', x.bug.status, `${x.count}x`, x.lastNote || '-']),
        { 1: { cellWidth: 45 }, 6: { cellWidth: 45 } });
      y = table(y, ['Module', 'Bug Reopen', 'Total Reopen'], r.byModule.map(m => [m.module, m.bugs, `${m.reopens}x`]));
    } else {
      y = paragraph(['Belum ada bug yang di-reopen.'], y) + 6;
    }

    const speedWord = { FAST: 'Cepat', WATCH: 'Perlu perhatian', SLOW: 'Lambat', NA: 'Belum ada data' }[s.verdict];
    y = sectionTitle(`Kecepatan Penanganan Bug - ${speedWord}${s.measured ? ` (${s.onTimePct}% tepat waktu)` : ''}`, y);
    y = table(y, ['Severity', 'Target', 'Bug Selesai', 'Rata-rata Durasi', 'Tepat Waktu'],
      Object.entries(s.bySeverity).map(([sev, v]) => [sev, `${ReportCalc.SLA_DAYS[sev]} hari`, v.count, formatDuration(v.avgHours),
        v.count ? `${v.onTime}/${v.count} (${Math.round(v.onTime / v.count * 100)}%)` : '-']));
    if (s.unmeasured) y = paragraph([`${s.unmeasured} bug Closed tidak bisa diukur karena tidak punya riwayat status.`], y - 4) + 4;
    if (s.overdueOpen.length){
      y = sectionTitle('Bug Terbuka yang Melewati Target', y);
      table(y, ['ID', 'Judul', 'Severity', 'Status', 'Umur', 'Target'],
        s.overdueOpen.map(x => [bugCode(x.bug), x.bug.title, x.bug.severity || '-', x.bug.status, formatDuration(x.ageHours), formatDuration(x.slaHours)]),
        { 1: { cellWidth: 70 } });
    }

    const pages = doc.getNumberOfPages();
    for (let i = 1; i <= pages; i++){
      doc.setPage(i);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(...dim);
      doc.text(`BugRail - Go-Live Readiness Report  |  Halaman ${i} / ${pages}`, pageW / 2, pageH - 8, { align: 'center' });
    }
    doc.save(`GoLive_Report_${new Date().toISOString().slice(0, 10)}.pdf`);
  },

  bindStaticEvents(){
    document.getElementById('rptExportPdfBtn').addEventListener('click', () => this.exportPDF());
    document.getElementById('rptFilterFile').addEventListener('change', e => { this.filters.fileId = e.target.value; this.render(); });
    document.getElementById('rptFilterModule').addEventListener('change', e => { this.filters.module = e.target.value; this.render(); });
  }
};

if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', () => ReportModule.bindStaticEvents());
