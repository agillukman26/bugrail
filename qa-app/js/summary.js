/* ==========================================================
   summary.js — filterable testing/bug rollup + PDF export
   ========================================================== */

const Summary = {
  charts: {},
  filters: { fileId:'', module:'', tester:'', dateFrom:'', dateTo:'' },

  filteredTC(){
    return App.state.testcases.filter(t => {
      if (this.filters.fileId && t.fileId !== this.filters.fileId) return false;
      if (this.filters.module && t.module !== this.filters.module) return false;
      if (this.filters.dateFrom && t.executionDate && t.executionDate < this.filters.dateFrom) return false;
      if (this.filters.dateTo && t.executionDate && t.executionDate > this.filters.dateTo) return false;
      return true;
    });
  },
  filteredBugs(){
    return App.state.bugs.filter(b => {
      if (this.filters.fileId && b.fileId !== this.filters.fileId) return false;
      if (this.filters.module && b.module !== this.filters.module) return false;
      if (this.filters.tester && b.tester !== this.filters.tester) return false;
      const reportDay = b.reportDate ? b.reportDate.slice(0,10) : '';
      if (this.filters.dateFrom && reportDay && reportDay < this.filters.dateFrom) return false;
      if (this.filters.dateTo && reportDay && reportDay > this.filters.dateTo) return false;
      return true;
    });
  },

  /* Bug count per file, ignoring the file filter itself — lets you spot
     which file has the most bug reports regardless of which one is picked. */
  bugCountsByFile(){
    const base = App.state.bugs.filter(b => {
      if (this.filters.module && b.module !== this.filters.module) return false;
      if (this.filters.tester && b.tester !== this.filters.tester) return false;
      const reportDay = b.reportDate ? b.reportDate.slice(0,10) : '';
      if (this.filters.dateFrom && reportDay && reportDay < this.filters.dateFrom) return false;
      if (this.filters.dateTo && reportDay && reportDay > this.filters.dateTo) return false;
      return true;
    });
    const counts = {};
    base.forEach(b => { const id = b.fileId || ''; counts[id] = (counts[id] || 0) + 1; });
    return Object.entries(counts)
      .map(([fileId, count]) => ({
        name: (App.state.files.find(f => f.id === fileId) || { name: 'Tanpa File' }).name,
        count
      }))
      .sort((a, b) => b.count - a.count);
  },

  bugPerFileCard(){
    const rows = this.bugCountsByFile();
    if (!rows.length) return '';
    const max = rows[0].count || 1;
    const bars = rows.map(r => `
      <div class="sum-legend-row">
        <span class="dot" style="background:var(--status-failed);"></span>
        <div>
          <div style="font-size:13px; font-weight:600;">${escapeHtml(r.name)}</div>
          <div class="sum-legend-bar"><span style="width:${Math.round(r.count/max*100)}%; background:var(--status-failed);"></span></div>
        </div>
        <span class="sum-legend-val">${r.count}</span>
      </div>
    `).join('');
    return `<div class="sum-card" style="--card-accent:var(--status-failed); --card-accent-bg:var(--status-failed-bg);">
      <div class="card-head" style="margin-bottom:10px;"><h3 style="margin:0; font-size:14px;">Bug per File</h3></div>
      <div class="sum-legend">${bars}</div>
    </div>`;
  },

  renderFilterOptions(){
    const build = (id, arr, field) => {
      const el = document.getElementById(id);
      const current = this.filters[field];
      const values = [...new Set(arr.map(x => x[field]).filter(Boolean))].sort();
      el.innerHTML = `<option value="">${el.dataset.label}</option>` +
        values.map(v => `<option value="${escapeHtml(v)}" ${v===current?'selected':''}>${escapeHtml(v)}</option>`).join('');
    };
    build('sumFilterModule', App.state.testcases, 'module');
    build('sumFilterTester', App.state.bugs, 'tester');

    const fileEl = document.getElementById('sumFilterFile');
    const curFile = this.filters.fileId;
    fileEl.innerHTML = `<option value="">${fileEl.dataset.label}</option>` +
      App.state.files.map(f => `<option value="${f.id}" ${f.id===curFile?'selected':''}>${escapeHtml(f.name)}</option>`).join('');
  },

  render(){
    this.renderFilterOptions();
    const tcs = this.filteredTC();
    const bugs = this.filteredBugs();
    const total = tcs.length;
    const totalModules = new Set(tcs.map(t => t.module).filter(Boolean)).size;
    const passed = tcs.filter(t => t.status === 'Passed').length;
    const failed = tcs.filter(t => t.status === 'Failed').length;
    const blocked = tcs.filter(t => t.status === 'Blocked').length;
    const notrun = tcs.filter(t => t.status === 'Open').length;
    const retest = tcs.filter(t => t.status === 'Retest').length;
    const passRate = total ? Math.round((passed/total)*100) : 0;
    const failRate = total ? Math.round((failed/total)*100) : 0;
    const pct = (n) => total ? Math.round((n/total)*1000)/10 : 0;
    const resStats = computeBugResolutionStats(bugs);

    document.getElementById('sumBody').innerHTML = `
      <div class="sum-section">
        <div class="sum-section-head"><span class="icon">📋</span><h2 style="color:var(--primary);">TEST CASE SUMMARY</h2></div>
        <p class="sum-hint">Ringkasan berdasarkan filter yang dipilih</p>
        <div class="sum-card-grid">
          ${this.sumCard('🗂️','Total Module', totalModules, '100% dari keseluruhan', 100, 'var(--primary)')}
          ${this.sumCard('📄','Total Test Case', total, '100% dari keseluruhan', 100, 'var(--primary)')}
          ${this.sumCard('📁','Total Open', notrun, `${pct(notrun)}% dari total test case`, pct(notrun), 'var(--status-notrun)')}
          ${this.sumCard('✅','Total Passed', passed, `${pct(passed)}% dari total test case`, pct(passed), 'var(--status-passed)')}
          ${this.sumCard('⏸️','Total Blocked', blocked, `${pct(blocked)}% dari total test case`, pct(blocked), 'var(--status-blocked)')}
          ${this.sumCard('❌','Total Failed', failed, `${pct(failed)}% dari total test case`, pct(failed), 'var(--status-failed)')}
          ${this.sumCard('🔄','Total Retest', retest, `${pct(retest)}% dari total test case`, pct(retest), 'var(--status-retest)')}
        </div>
      </div>

      <div class="sum-section sum-overall">
        <div style="flex:1; min-width:240px;">
          <div class="card-head" style="margin-bottom:10px;"><h3 style="margin:0;">Overall Test Case Progress</h3></div>
          <div class="progress-bar-outer"><span style="width:${passRate}%; background:var(--status-passed);"></span></div>
        </div>
        <div>
          <div class="sum-overall-pct">${passRate}%</div>
          <div class="sum-overall-sub">${passed} / ${total} Passed</div>
        </div>
      </div>

      <div class="sum-section">
        <div class="sum-section-head"><span class="icon">🐞</span><h2 style="color:var(--status-failed);">BUG REPORT SUMMARY</h2></div>
        <p class="sum-hint">Ringkasan berdasarkan filter yang dipilih</p>
        <div class="bug-summary-grid">
          <div class="sum-card" style="--card-accent:var(--status-failed); --card-accent-bg:var(--status-failed-bg); justify-content:center;">
            <div class="sum-card-top"><span class="sum-card-icon">🐞</span><span class="sum-card-label">Total Bug</span></div>
            <span class="sum-card-value">${bugs.length}</span>
            <span class="sum-card-sub">100% dari keseluruhan bug</span>
            <div class="sum-mini-bar"><span style="width:100%;"></span></div>
          </div>
          <div class="sum-card" style="--card-accent:var(--status-passed); --card-accent-bg:var(--status-passed-bg); justify-content:center;">
            <div class="sum-card-top"><span class="sum-card-icon">⏱️</span><span class="sum-card-label">Pengerjaan Developer</span></div>
            <span class="sum-card-value">${formatDuration(resStats.avgHours)}</span>
            <span class="sum-card-sub">Open &rarr; Closed, dari ${resStats.resolvedCount} bug terukur</span>
          </div>
          ${this.donutCard('Distribusi Severity', bugs.length, 'Total Bug',
            ['Critical','High','Medium','Low'],
            ['Critical','High','Medium','Low'].map(s => bugs.filter(b=>b.severity===s).length),
            ['var(--sev-critical)','var(--sev-high)','var(--sev-medium)','var(--sev-low)'], 'sumDonutSeverity')}
          ${this.donutCard('Distribusi Priority', bugs.length, 'Total Bug',
            ['Highest','High','Medium','Low'],
            ['Highest','High','Medium','Low'].map(p => bugs.filter(b=>b.priority===p).length),
            ['var(--sev-critical)','var(--sev-high)','var(--sev-medium)','var(--sev-low)'], 'sumDonutPriority')}
          ${this.bugPerFileCard()}
        </div>
      </div>
    `;

    const sevCounts = ['Critical','High','Medium','Low'].map(s => bugs.filter(b=>b.severity===s).length);
    this.donut('sumDonutSeverity', sevCounts, ['#B0203A','#D64550','#D98A2B','#4E88C7']);
    const prioCounts = ['Highest','High','Medium','Low'].map(p => bugs.filter(b=>b.priority===p).length);
    this.donut('sumDonutPriority', prioCounts, ['#B0203A','#D64550','#D98A2B','#4E88C7']);

    this._lastData = { total, passed, failed, blocked, notrun, retest, passRate, failRate, bugs, tcs: { totalModules } };
    this._lastTC = tcs;
  },

  sumCard(icon, label, value, sub, pct, color){
    return `<div class="sum-card" style="--card-accent:${color}; --card-accent-bg:color-mix(in srgb, ${color} 16%, transparent);">
      <div class="sum-card-top"><span class="sum-card-icon">${icon}</span><span class="sum-card-label">${label}</span></div>
      <span class="sum-card-value">${value}</span>
      <span class="sum-card-sub">${sub}</span>
      <div class="sum-mini-bar"><span style="width:${Math.min(pct,100)}%;"></span></div>
    </div>`;
  },

  donutCard(title, total, centerLabel, labels, counts, colors, canvasId){
    const sum = counts.reduce((a,b)=>a+b,0) || 1;
    const rows = labels.map((l,i) => `
      <div class="sum-legend-row">
        <span class="dot" style="background:${colors[i]};"></span>
        <div>
          <div style="font-size:13px; font-weight:600;">${l}</div>
          <div class="sum-legend-bar"><span style="width:${Math.round(counts[i]/sum*100)}%; background:${colors[i]};"></span></div>
        </div>
        <span class="sum-legend-val">${counts[i]} (${Math.round(counts[i]/sum*1000)/10}%)</span>
      </div>
    `).join('');
    return `<div class="sum-card sum-donut-card" style="--card-accent:var(--primary); --card-accent-bg:var(--primary-soft);">
      <div class="sum-donut-wrap">
        <canvas id="${canvasId}"></canvas>
        <div class="sum-donut-center"><b>${total}</b><span>${centerLabel}</span></div>
      </div>
      <div>
        <div class="card-head" style="margin-bottom:10px;"><h3 style="margin:0; font-size:14px;">${title}</h3></div>
        <div class="sum-legend">${rows}</div>
      </div>
    </div>`;
  },

  donut(id, data, colors){
    const ctx = document.getElementById(id);
    if (!ctx) return;
    if (this.charts[id]) this.charts[id].destroy();
    const empty = data.every(v => v===0);
    this.charts[id] = new Chart(ctx, {
      type:'doughnut',
      data:{ datasets:[{ data: empty?[1]:data, backgroundColor: empty?['#E3E7ED']:colors, borderWidth:0 }] },
      options:{ maintainAspectRatio:false, cutout:'68%', plugins:{ legend:{display:false}, tooltip:{enabled:!empty} } }
    });
  },

/* Insight + recommendation lines derived from the current filtered summary —
     same numbers shown on screen, turned into plain-language conclusions
     (what's happening) and actionable recommendations (what to do) for the PDF. */
  buildAnalysis(d){
    const bugs = d.bugs || [];
    const tcs = this._lastTC || [];
    const findings = [];
    const recommendations = [];

    if (!d.total){
      findings.push('Belum ada test case pada rentang filter ini.');
    } else if (d.passRate >= 80){
      findings.push(`Progress testing baik: pass rate ${d.passRate}% (${d.passed}/${d.total} test case Passed).`);
    } else if (d.passRate >= 50){
      findings.push(`Progress testing masih moderat: pass rate ${d.passRate}% (${d.passed}/${d.total} test case Passed).`);
      recommendations.push('Percepat eksekusi test case yang masih Open agar coverage lebih representatif sebelum rilis.');
    } else if (d.total) {
      findings.push(`Pass rate rendah: ${d.passRate}% (${d.passed}/${d.total} test case Passed).`);
      recommendations.push('Pass rate di bawah 50% berisiko tinggi untuk rilis — pertimbangkan menunda rilis sampai isu utama diperbaiki.');
    }

    if (d.failed){
      findings.push(`Terdapat ${d.failed} test case Failed (${d.failRate}%) yang berpotensi menghasilkan bug baru.`);
      if (!bugs.length) recommendations.push(`${d.failed} test case Failed belum punya bug report terkait — pastikan semua kegagalan sudah dicatat sebagai bug.`);
    }
    if (d.blocked){
      findings.push(`${d.blocked} test case masih Blocked, kemungkinan menunggu dependency/environment.`);
      recommendations.push('Tindak lanjuti test case Blocked dengan tim terkait (environment/data/akses) agar tidak menghambat eksekusi.');
    }
    if (d.notrun) findings.push(`${d.notrun} test case belum dieksekusi (Open).`);
    if (d.retest) findings.push(`${d.retest} test case berstatus Retest, menunggu verifikasi ulang setelah perbaikan.`);

    const moduleStats = {};
    tcs.forEach(t => {
      if (!t.module) return;
      moduleStats[t.module] = moduleStats[t.module] || { total:0, failed:0 };
      moduleStats[t.module].total++;
      if (t.status === 'Failed') moduleStats[t.module].failed++;
    });
    const riskyModules = Object.entries(moduleStats)
      .filter(([,s]) => s.failed > 0)
      .sort((a,b) => (b[1].failed/b[1].total) - (a[1].failed/a[1].total))
      .slice(0, 3);
    if (riskyModules.length){
      findings.push(`Modul dengan tingkat kegagalan tertinggi: ${riskyModules.map(([m,s]) => `"${m}" (${s.failed}/${s.total})`).join(', ')}.`);
      recommendations.push(`Fokuskan regresi dan review kode pada modul "${riskyModules[0][0]}" karena proporsi kegagalannya paling tinggi.`);
    }

    if (!bugs.length){
      findings.push('Tidak ada bug tercatat pada rentang filter ini.');
    } else {
      const critical = bugs.filter(b=>b.severity==='Critical').length;
      const high = bugs.filter(b=>b.severity==='High').length;
      const openBugs = bugs.filter(b=>['Open','Assigned','Reopened'].includes(b.status)).length;
      const reopened = bugs.filter(b=>b.status==='Reopened').length;
      const closedBugs = bugs.filter(b=>b.status==='Closed').length;
      findings.push(`${openBugs} bug masih terbuka (Open/Assigned/Reopened), ${closedBugs} bug sudah Closed dari total ${bugs.length} bug.`);

      if (critical){
        findings.push(`${critical} bug berseverity Critical tercatat pada rentang ini.`);
        recommendations.push(`Prioritaskan ${critical} bug Critical untuk diperbaiki sebelum rilis berikutnya — potensi dampak tinggi ke pengguna.`);
      }
      if (high) findings.push(`${high} bug berseverity High menunggu perbaikan.`);
      if (reopened){
        findings.push(`${reopened} bug berstatus Reopened, menandakan perbaikan sebelumnya belum tuntas.`);
        recommendations.push('Telusuri root cause pada bug yang di-reopen agar fix berikutnya tidak berulang gagal.');
      }

      const retestRounds = bugs.map(b => ({ id: b.id, title: b.title, count: BugReportModule.reopenCount(b) }))
        .filter(r => r.count > 0)
        .sort((a,b) => b.count - a.count);
      if (retestRounds.length){
        const totalRounds = retestRounds.reduce((sum,r) => sum + r.count, 0);
        const once = retestRounds.filter(r => r.count === 1).length;
        const twice = retestRounds.filter(r => r.count === 2).length;
        const chronic = retestRounds.filter(r => r.count >= 3);
        findings.push(`${retestRounds.length} bug pernah retest (reopen) setidaknya 1x, total ${totalRounds} kali retest.`);
        findings.push(`Distribusi retest: ${once} bug retest 1x, ${twice} bug retest 2x, ${chronic.length} bug retest 3x atau lebih.`);
        if (chronic.length){
          findings.push(`Bug retest kronis (>=3x): ${chronic.map(r => `${r.id} - "${r.title}" (${r.count}x)`).join(', ')}.`);
          recommendations.push(`${chronic.length} bug sudah retest 3x atau lebih — indikasi fix asal-asalan atau requirement kurang jelas, perlu review mendalam dan keterlibatan dev senior sebelum fix berikutnya.`);
        } else {
          const worst = retestRounds[0];
          if (worst.count > 1){
            findings.push(`Bug paling sering retest: ${worst.id} - "${worst.title}" (${worst.count}x reopen).`);
            recommendations.push(`Bug ${worst.id} sudah retest ${worst.count}x — review lebih dalam sebelum fix berikutnya, kemungkinan ada kasus yang belum tercover.`);
          }
        }
      }

      const res = computeBugResolutionStats(bugs);
      if (res.resolvedCount){
        findings.push(`Rata-rata waktu resolusi bug (Open -> Closed): ${formatDuration(res.avgHours)}, dihitung dari ${res.resolvedCount} bug.`);
        if (res.avgHours > 72) recommendations.push('Rata-rata waktu resolusi lebih dari 3 hari — evaluasi kembali prioritas assignment dan kapasitas tim development.');
      }

      const testerStats = {};
      bugs.forEach(b => { if (b.tester) testerStats[b.tester] = (testerStats[b.tester]||0) + 1; });
      const topTester = Object.entries(testerStats).sort((a,b) => b[1]-a[1])[0];
      if (topTester && Object.keys(testerStats).length > 1) findings.push(`Tester dengan bug terbanyak dilaporkan: ${topTester[0]} (${topTester[1]} bug).`);

      const oldOpen = bugs.filter(b => ['Open','Assigned','Reopened'].includes(b.status) && b.reportDate &&
        (Date.now() - new Date(b.reportDate).getTime()) / 36e5 > 168);
      if (oldOpen.length) recommendations.push(`${oldOpen.length} bug open sudah lebih dari 7 hari tanpa penyelesaian — perlu eskalasi.`);
    }

    if (!recommendations.length) recommendations.push('Tidak ada catatan risiko signifikan pada rentang filter ini — pertahankan ritme testing saat ini.');

    return { findings, recommendations };
  },

  exportPDF(){
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF();
    doc.setFont('helvetica', 'normal');
    const d = this._lastData || {};
    const pageW = doc.internal.pageSize.getWidth();
    const pageH = doc.internal.pageSize.getHeight();
    const ink = [31, 41, 55];       // dark slate — headings
    const dim = [107, 114, 128];    // muted gray — sub text
    const line = [222, 226, 232];   // hairline gray — table borders
    const soft = [246, 247, 249];   // pale gray — header fill / zebra

    const sectionTitle = (text, y) => {
      doc.setFont('helvetica', 'bold'); doc.setFontSize(11.5); doc.setTextColor(...ink);
      doc.text(text, 14, y);
      doc.setDrawColor(...line); doc.setLineWidth(.4);
      doc.line(14, y + 2, pageW - 14, y + 2);
      doc.setFont('helvetica', 'normal');
      return y + 8;
    };
    const ensureSpace = (y, needed) => {
      if (y + needed > pageH - 14){ doc.addPage(); return 16; }
      return y;
    };

    doc.setTextColor(...ink); doc.setFont('helvetica', 'bold'); doc.setFontSize(16);
    doc.text('QA Testing Summary Report', 14, 18);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(...dim);
    doc.text(`Generated: ${new Date().toLocaleString('id-ID')}`, pageW - 14, 18, { align: 'right' });
    doc.setDrawColor(...ink); doc.setLineWidth(.6);
    doc.line(14, 22, pageW - 14, 22);

    const filterBits = [];
    if (this.filters.fileId){
      const f = App.state.files.find(x => x.id === this.filters.fileId);
      if (f) filterBits.push(`File: ${f.name}`);
    }
    if (this.filters.module) filterBits.push(`Module: ${this.filters.module}`);
    if (this.filters.tester) filterBits.push(`Tester: ${this.filters.tester}`);
    if (this.filters.dateFrom) filterBits.push(`Dari: ${this.filters.dateFrom}`);
    if (this.filters.dateTo) filterBits.push(`Sampai: ${this.filters.dateTo}`);
    doc.setFontSize(9); doc.setTextColor(...dim);
    doc.text(filterBits.length ? `Filter: ${filterBits.join(' | ')}` : 'Filter: Semua Data', 14, 29);

    const tableTheme = {
      theme: 'grid',
      headStyles: { fillColor: soft, textColor: ink, halign: 'center', fontStyle: 'bold', lineColor: line, lineWidth: .3 },
      bodyStyles: { halign: 'center', textColor: ink, lineColor: line, lineWidth: .3 },
      alternateRowStyles: { fillColor: [252, 252, 253] },
      styles: { fontSize: 9, font: 'helvetica' },
      margin: { left: 14, right: 14 }
    };

    let y = sectionTitle('Test Case Summary', 38);
    doc.autoTable({
      startY: y,
      head: [['Total Module','Total TC','Open','Passed','Blocked','Failed','Retest','Pass Rate']],
      body: [[
        d.tcs?.totalModules ?? '', d.total || 0, d.notrun || 0, d.passed || 0,
        d.blocked || 0, d.failed || 0, d.retest || 0, `${d.passRate || 0}%`
      ]],
      ...tableTheme
    });
    y = doc.lastAutoTable.finalY + 12;

    y = sectionTitle('Bug Report Summary', y);
    const bugs = d.bugs || [];
    doc.autoTable({
      startY: y,
      head: [['Total Bug','Critical','High','Medium','Low','Open','Closed']],
      body: [[
        bugs.length,
        bugs.filter(b=>b.severity==='Critical').length,
        bugs.filter(b=>b.severity==='High').length,
        bugs.filter(b=>b.severity==='Medium').length,
        bugs.filter(b=>b.severity==='Low').length,
        bugs.filter(b=>['Open','Assigned','Reopened'].includes(b.status)).length,
        bugs.filter(b=>b.status==='Closed').length
      ]],
      ...tableTheme
    });
    y = doc.lastAutoTable.finalY + 10;

    y = ensureSpace(y, 55);
    [['sumDonutSeverity','Distribusi Severity'], ['sumDonutPriority','Distribusi Priority']].forEach(([id, label], i) => {
      const canvas = document.getElementById(id);
      if (!canvas) return;
      const x = 14 + i * 95;
      doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.setTextColor(...ink);
      doc.text(label, x, y);
      doc.setFont('helvetica', 'normal');
      doc.addImage(canvas.toDataURL('image/png'), 'PNG', x, y + 3, 40, 40);
    });
    y += 50;

    const { findings, recommendations } = this.buildAnalysis(d);

    y = ensureSpace(y, 16);
    y = sectionTitle('Analisa', y);
    doc.setFontSize(9.5); doc.setTextColor(...ink);
    findings.forEach(note => {
      const wrapped = doc.splitTextToSize(`•  ${note}`, pageW - 28);
      y = ensureSpace(y, wrapped.length * 5);
      doc.text(wrapped, 14, y);
      y += wrapped.length * 5 + 2;
    });
    y += 4;

    y = ensureSpace(y, 16);
    y = sectionTitle('Rekomendasi', y);
    doc.setFontSize(9.5); doc.setTextColor(...ink);
    recommendations.forEach(note => {
      const wrapped = doc.splitTextToSize(`•  ${note}`, pageW - 28);
      y = ensureSpace(y, wrapped.length * 5);
      doc.text(wrapped, 14, y);
      y += wrapped.length * 5 + 2;
    });

    doc.save(`QA_Summary_${todayISO()}.pdf`);
    Toast.show('Export PDF Summary berhasil.', 'success');
  },

  /* Same numbers as the PDF (test case + bug totals, per-bug retest count,
     findings/recommendations) but as a workbook so the raw analytic data
     can be reused elsewhere (pivot, share with stakeholders, etc). */
  exportExcel(){
    const d = this._lastData || {};
    const bugs = d.bugs || [];
    const { findings, recommendations } = this.buildAnalysis(d);

    const tcSheet = XLSX.utils.json_to_sheet([{
      'Total Module': d.tcs?.totalModules ?? 0, 'Total Test Case': d.total || 0,
      Open: d.notrun || 0, Passed: d.passed || 0, Blocked: d.blocked || 0,
      Failed: d.failed || 0, Retest: d.retest || 0, 'Pass Rate (%)': d.passRate || 0
    }]);

    const resStats = computeBugResolutionStats(bugs);
    const bugSheet = XLSX.utils.json_to_sheet([{
      'Total Bug': bugs.length,
      Critical: bugs.filter(b=>b.severity==='Critical').length,
      High: bugs.filter(b=>b.severity==='High').length,
      Medium: bugs.filter(b=>b.severity==='Medium').length,
      Low: bugs.filter(b=>b.severity==='Low').length,
      Open: bugs.filter(b=>['Open','Assigned','Reopened'].includes(b.status)).length,
      Closed: bugs.filter(b=>b.status==='Closed').length,
      'Avg Resolusi (jam)': resStats.avgHours || 0,
      'Bug Terukur Resolusi': resStats.resolvedCount || 0
    }]);

    const retestSheet = XLSX.utils.json_to_sheet(
      bugs.map(b => ({
        'Bug ID': b.id, 'Bug Title': b.title, Module: b.module, Severity: b.severity,
        Status: b.status, 'Jumlah Retest': BugReportModule.reopenCount(b)
      })).sort((a,b) => b['Jumlah Retest'] - a['Jumlah Retest'])
    );

    const analysisSheet = XLSX.utils.json_to_sheet([
      ...findings.map(text => ({ Tipe: 'Analisa', Catatan: text })),
      ...recommendations.map(text => ({ Tipe: 'Rekomendasi', Catatan: text }))
    ]);

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, tcSheet, 'Test Case Summary');
    XLSX.utils.book_append_sheet(wb, bugSheet, 'Bug Summary');
    XLSX.utils.book_append_sheet(wb, retestSheet, 'Retest per Bug');
    XLSX.utils.book_append_sheet(wb, analysisSheet, 'Analisa & Rekomendasi');
    XLSX.writeFile(wb, `QA_Summary_Data_${todayISO()}.xlsx`);
    Toast.show('Export Data Summary berhasil.', 'success');
  },

  bindStaticEvents(){
    ['sumFilterFile','sumFilterModule','sumFilterTester'].forEach(id => {
      document.getElementById(id).addEventListener('change', e => {
        const map = { sumFilterFile:'fileId', sumFilterModule:'module', sumFilterTester:'tester' };
        this.filters[map[id]] = e.target.value; this.render();
      });
    });
    document.getElementById('sumDateFrom').addEventListener('change', e => { this.filters.dateFrom = e.target.value; this.render(); });
    document.getElementById('sumDateTo').addEventListener('change', e => { this.filters.dateTo = e.target.value; this.render(); });
    ['sumDateFrom','sumDateTo'].forEach(id => {
      const el = document.getElementById(id);
      el.addEventListener('click', () => { if (el.showPicker) el.showPicker(); });
    });
    document.getElementById('sumExportPdfBtn').addEventListener('click', () => this.exportPDF());
    document.getElementById('sumExportExcelBtn').addEventListener('click', () => this.exportExcel());
  }
};

document.addEventListener('DOMContentLoaded', () => Summary.bindStaticEvents());
