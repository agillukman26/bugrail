/* ==========================================================
   dashboard.js — realtime stat widgets + charts, filterable
   (module/tester/date range) with PDF export, same visual
   language as the Summary page.
   ========================================================== */

const Dashboard = {
  charts: {},
  APPROVAL_COLORS: ['#1E9E6B', '#D64550', '#E0A526'], // Approved, Rejected, Belum di-Approval

  /* 'approved' | 'rejected' | 'pending' (executed w/ evidence, not yet validated) | null (not approvable yet) */
  approvalState(tc){
    if (tc.approval) return tc.approval.result;
    return tc.status && tc.status !== 'Open' && String(tc.evidence || '').trim() ? 'pending' : null;
  },

  approvalStats(tcs){
    const c = { approved:0, rejected:0, pending:0 };
    tcs.forEach(tc => { const st = this.approvalState(tc); if (st in c) c[st]++; });
    c.total = c.approved + c.rejected + c.pending;
    return c;
  },

  computeStats(tcs, bugs){
    const count = (arr, key, val) => arr.filter(x => x[key] === val).length;
    return {
      totalModule: new Set(tcs.map(t=>t.module).filter(Boolean)).size,
      totalTC: tcs.length,
      passed: count(tcs,'status','Passed'),
      failed: count(tcs,'status','Failed'),
      blocked: count(tcs,'status','Blocked'),
      notrun: count(tcs,'status','Open'),
      retest: count(tcs,'status','Retest'),
      totalBug: bugs.length,
      sevDist: BUG_LEVELS.distribution('severity', bugs),
      prioDist: BUG_LEVELS.distribution('priority', bugs)
    };
  },

  render(){
    const tcs = TestCaseModule.all();
    const bugs = BugReportModule.reported();
    const s = this.computeStats(tcs, bugs);
    const resStats = computeBugResolutionStats(bugs);
    const passRate = s.totalTC ? Math.round((s.passed/s.totalTC)*100) : 0;
    const pct = (n) => s.totalTC ? Math.round((n/s.totalTC)*1000)/10 : 0;
    const showApproval = approvalEnabled();
    const a = this.approvalStats(tcs);
    const aPct = (n) => a.total ? Math.round((n/a.total)*1000)/10 : 0;

    document.getElementById('dashBody').innerHTML = `
      <div class="sum-section">
        <div class="sum-section-head"><span class="icon">📋</span><h2 style="color:var(--primary);">DASHBOARD</h2></div>
        <div class="sum-card-grid">
          ${this.sumCard('🗂️','Total Module', s.totalModule, '100% dari keseluruhan', 100, 'var(--primary)')}
          ${this.sumCard('📄','Total Test Case', s.totalTC, '100% dari keseluruhan', 100, 'var(--primary)')}
          ${this.sumCard('📁','Total Open', s.notrun, `${pct(s.notrun)}% dari total test case`, pct(s.notrun), 'var(--status-notrun)')}
          ${this.sumCard('✅','Total Passed', s.passed, `${pct(s.passed)}% dari total test case`, pct(s.passed), 'var(--status-passed)')}
          ${this.sumCard('⏸️','Total Blocked', s.blocked, `${pct(s.blocked)}% dari total test case`, pct(s.blocked), 'var(--status-blocked)')}
          ${this.sumCard('❌','Total Failed', s.failed, `${pct(s.failed)}% dari total test case`, pct(s.failed), 'var(--status-failed)')}
          ${this.sumCard('🔄','Total Retest', s.retest, `${pct(s.retest)}% dari total test case`, pct(s.retest), 'var(--status-retest)')}
        </div>
      </div>

      <div class="sum-section sum-overall">
        <div style="flex:1; min-width:240px;">
          <div class="card-head" style="margin-bottom:10px;"><h3 style="margin:0;">Overall Test Case Progress</h3></div>
          <div class="progress-bar-outer"><span style="width:${passRate}%; background:var(--status-passed);"></span></div>
        </div>
        <div>
          <div class="sum-overall-pct">${passRate}%</div>
          <div class="sum-overall-sub">${s.passed} / ${s.totalTC} Passed</div>
        </div>
      </div>

      ${showApproval ? `<div class="sum-section">
        <div class="sum-section-head"><span class="icon">☑️</span><h2 style="color:var(--status-passed);">APPROVAL SUMMARY</h2></div>
        <p class="sum-hint">Dari ${a.total} test case yang sudah dijalankan dan ber-evidence</p>
        <div class="approval-summary-grid">
          <div class="sum-card-grid">
            ${this.sumCard('✅','Approved', a.approved, `${aPct(a.approved)}% dari test case siap approval`, aPct(a.approved), this.APPROVAL_COLORS[0])}
            ${this.sumCard('❌','Rejected', a.rejected, `${aPct(a.rejected)}% dari test case siap approval`, aPct(a.rejected), this.APPROVAL_COLORS[1])}
            ${this.sumCard('⏳','Belum di-Approval', a.pending, `${aPct(a.pending)}% dari test case siap approval`, aPct(a.pending), this.APPROVAL_COLORS[2])}
          </div>
          ${this.donutCard('Distribusi Approval', a.total, 'Siap Approval',
            ['Approved','Rejected','Belum di-Approval'], [a.approved, a.rejected, a.pending], this.APPROVAL_COLORS, 'dashDonutApproval')}
        </div>
      </div>` : ''}

      <div class="sum-section">
        <div class="sum-section-head"><span class="icon">🐞</span><h2 style="color:var(--status-failed);">BUG REPORT SUMMARY</h2></div>
        <p class="sum-hint">Ringkasan berdasarkan filter yang dipilih</p>
        <div class="bug-summary-grid">
          <div class="sum-card" style="--card-accent:var(--status-failed); --card-accent-bg:var(--status-failed-bg); justify-content:center;">
            <div class="sum-card-top"><span class="sum-card-icon">🐞</span><span class="sum-card-label">Total Bug</span></div>
            <span class="sum-card-value">${s.totalBug}</span>
            <span class="sum-card-sub">100% dari keseluruhan bug</span>
            <div class="sum-mini-bar"><span style="width:100%;"></span></div>
          </div>
          <div class="sum-card" style="--card-accent:var(--status-passed); --card-accent-bg:var(--status-passed-bg); justify-content:center;">
            <div class="sum-card-top"><span class="sum-card-icon">⏱️</span><span class="sum-card-label">Pengerjaan Developer</span></div>
            <span class="sum-card-value">${formatDuration(resStats.avgHours)}</span>
            <span class="sum-card-sub">Open &rarr; Closed, dari ${resStats.resolvedCount} bug terukur</span>
          </div>
          ${this.donutCard('Distribusi Severity', s.totalBug, 'Total Bug',
            s.sevDist.labels, s.sevDist.counts, s.sevDist.colors, 'dashDonutSeverity')}
          ${this.donutCard('Distribusi Priority', s.totalBug, 'Total Bug',
            s.prioDist.labels, s.prioDist.counts, s.prioDist.colors, 'dashDonutPriority')}
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h3>Progress Testing per Module</h3></div>
        <div class="chart-box"><canvas id="dashBarProgress"></canvas></div>
      </div>

      ${showApproval ? `<div class="card" style="margin-top:18px;">
        <div class="card-head"><h3>Approval per Module</h3></div>
        <div class="chart-box"><canvas id="dashBarApproval"></canvas></div>
      </div>` : ''}
    `;

    this.donut('dashDonutSeverity', s.sevDist.counts, s.sevDist.colors);
    this.donut('dashDonutPriority', s.prioDist.counts, s.prioDist.colors);
    this.renderBar(tcs);
    if (showApproval){
      this.donut('dashDonutApproval', [a.approved, a.rejected, a.pending], this.APPROVAL_COLORS);
      this.renderApprovalBar(tcs);
    } else {
      ['dashDonutApproval','approvalBar'].forEach(k => { if (this.charts[k]){ this.charts[k].destroy(); delete this.charts[k]; } });
    }
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

  renderBar(tcs){
    const modules = [...new Set(tcs.map(t => t.module).filter(Boolean))].slice(0, 8);
    const passedData = modules.map(m => tcs.filter(t => t.module === m && t.status === 'Passed').length);
    const failedData = modules.map(m => tcs.filter(t => t.module === m && t.status === 'Failed').length);
    const otherData = modules.map(m => tcs.filter(t => t.module === m && !['Passed','Failed'].includes(t.status)).length);

    const ctx = document.getElementById('dashBarProgress');
    if (this.charts.bar) this.charts.bar.destroy();
    this.charts.bar = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: modules.length ? modules : ['Belum ada data'],
        datasets: [
          { label: 'Passed', data: modules.length ? passedData : [0], backgroundColor: '#1E9E6B', borderRadius: 4 },
          { label: 'Failed', data: modules.length ? failedData : [0], backgroundColor: '#D64550', borderRadius: 4 },
          { label: 'Open', data: modules.length ? otherData : [0], backgroundColor: '#8A93A6', borderRadius: 4 }
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        scales: { x: { stacked: true, grid: { display: false } }, y: { stacked: true, beginAtZero: true, ticks: { precision: 0 } } },
        plugins: { legend: { position: 'bottom', labels: { boxWidth: 10, font: { size: 11 } } } }
      }
    });
  },

  renderApprovalBar(tcs){
    const modules = [...new Set(tcs.map(t => t.module).filter(Boolean))].slice(0, 8);
    const series = ['approved','rejected','pending'].map(st =>
      modules.map(m => tcs.filter(t => t.module === m && this.approvalState(t) === st).length));
    const ctx = document.getElementById('dashBarApproval');
    if (this.charts.approvalBar) this.charts.approvalBar.destroy();
    this.charts.approvalBar = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: modules.length ? modules : ['Belum ada data'],
        datasets: ['Approved','Rejected','Belum di-Approval'].map((label, i) => ({
          label, data: modules.length ? series[i] : [0], backgroundColor: this.APPROVAL_COLORS[i], borderRadius: 4
        }))
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        scales: { x: { stacked: true, grid: { display: false } }, y: { stacked: true, beginAtZero: true, ticks: { precision: 0 } } },
        plugins: { legend: { position: 'bottom', labels: { boxWidth: 10, font: { size: 11 } } } }
      }
    });
  },

};
