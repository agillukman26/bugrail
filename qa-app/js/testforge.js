/* ==========================================================
   testforge.js — AI test case generator (BRS / screenshot /
   free text -> staged draft rows -> review -> save).
   Staged rows are held only in TestForgeModule.ui.staged until
   the user clicks Save All; nothing is persisted before that.
   ========================================================== */

const TESTFORGE_FIELDS = [
  { key: 'module', label: 'Module' },
  { key: 'roleUser', label: 'Role User' },
  { key: 'scenario', label: 'Scenario' },
  { key: 'testCase', label: 'Test Case' },
  { key: 'preconditions', label: 'Pre-Condition' },
  { key: 'steps', label: 'Test Step' },
  { key: 'testData', label: 'Test Data' },
  { key: 'expectedResult', label: 'Expected Result' },
  { key: 'typeTest', label: 'Type Test' }
];

const TestForgeModule = {
  ui: {
    step: 'template',     // 'template' | 'generate' | 'review'
    mode: 'brs',           // 'brs' | 'screenshot' | 'text'
    fields: new Set(TESTFORGE_FIELDS.map(f => f.key)),
    content: '',
    images: [],            // array of data: URLs
    staged: [],
    loading: false
  },

  open(){
    this.ui = { step: 'template', mode: 'brs', fields: new Set(TESTFORGE_FIELDS.map(f => f.key)), content: '', images: [], staged: [], loading: false };
    document.getElementById('tfModalOverlay').classList.add('active');
    this.render();
  },

  close(){
    document.getElementById('tfModalOverlay').classList.remove('active');
  },

  render(){
    const body = document.getElementById('tfBody');
    if (this.ui.step === 'template') body.innerHTML = this.renderTemplateStep();
    else if (this.ui.step === 'generate') body.innerHTML = this.renderGenerateStep();
    else body.innerHTML = this.renderReviewStep();
    this.bindStepEvents();
  },

  renderTemplateStep(){
    const checks = TESTFORGE_FIELDS.map(f => `
      <label class="field-check">
        <input type="checkbox" data-field="${f.key}" ${this.ui.fields.has(f.key) ? 'checked' : ''}>
        ${f.label}
      </label>`).join('');
    return `
      <p class="text-dim" style="font-size:13px;">Pilih field yang mau di-generate AI:</p>
      <div class="tf-field-grid">${checks}</div>
      <div class="modal-footer">
        <button type="button" class="btn" data-close="tfModalOverlay">Batal</button>
        <button type="button" class="btn primary" id="tfNextBtn">Lanjut ▸</button>
      </div>`;
  },

  renderGenerateStep(){
    const tabs = [
      { key: 'brs', label: 'BRS' },
      { key: 'screenshot', label: 'Screenshot' },
      { key: 'text', label: 'Free Text' }
    ].map(t => `<button type="button" class="btn sm ${this.ui.mode === t.key ? 'primary' : ''}" data-tab="${t.key}">${t.label}</button>`).join('');

    let sourceHtml = '';
    if (this.ui.mode === 'brs') {
      sourceHtml = `<textarea id="tfContentInput" rows="8" placeholder="Paste BRS text di sini...">${escapeHtml(this.ui.content)}</textarea>`;
    } else if (this.ui.mode === 'text') {
      sourceHtml = `<textarea id="tfContentInput" rows="8" placeholder="Jelaskan fitur/skenario yang mau di-generate...">${escapeHtml(this.ui.content)}</textarea>`;
    } else {
      const previews = this.ui.images.map((img, i) => `
        <div class="tf-thumb"><img src="${escapeHtml(img)}"><button type="button" class="tf-thumb-remove" data-remove-img="${i}">✕</button></div>`).join('');
      sourceHtml = `
        <input type="file" id="tfImageInput" accept="image/*" multiple>
        <div class="tf-thumb-row">${previews}</div>
        <textarea id="tfContentInput" rows="3" placeholder="Instruksi tambahan (opsional)...">${escapeHtml(this.ui.content)}</textarea>`;
    }

    return `
      <div class="tf-tabs">${tabs}</div>
      <div class="tf-source" style="margin-top:12px;">${sourceHtml}</div>
      <div class="modal-footer">
        <button type="button" class="btn" id="tfBackBtn">◂ Kembali</button>
        <button type="button" class="btn primary" id="tfGenerateBtn" ${this.ui.loading ? 'disabled' : ''}>${this.ui.loading ? 'Generating...' : 'Generate'}</button>
      </div>`;
  },

  renderReviewStep(){
    if (!this.ui.staged.length) {
      return `
        <p class="text-dim">Tidak ada hasil generate.</p>
        <div class="modal-footer">
          <button type="button" class="btn" id="tfBackToGenBtn">◂ Generate Ulang</button>
        </div>`;
    }
    const fieldKeys = Array.from(this.ui.fields);
    const rows = this.ui.staged.map((tc, i) => `
      <div class="tf-staged-row card" style="margin-bottom:10px; padding:12px;">
        <div class="flex-between">
          <b>#${i + 1}</b>
          <button type="button" class="btn sm danger" data-del-staged="${i}">🗑 Hapus</button>
        </div>
        ${fieldKeys.map(key => `
          <div class="field">
            <label>${TESTFORGE_FIELDS.find(f => f.key === key).label}</label>
            <textarea data-staged-field="${i}:${key}" rows="${key === 'steps' || key === 'testCase' ? 3 : 1}">${escapeHtml(tc[key] || '')}</textarea>
          </div>`).join('')}
      </div>`).join('');
    return `
      <div class="tf-staged-list">${rows}</div>
      <div class="modal-footer">
        <button type="button" class="btn" id="tfBackToGenBtn">◂ Generate Ulang</button>
        <button type="button" class="btn primary" id="tfSaveAllBtn">Simpan Semua ke Test Case</button>
      </div>`;
  },

  bindStepEvents(){
    if (this.ui.step === 'template') {
      document.querySelectorAll('[data-field]').forEach(cb => {
        cb.addEventListener('change', () => {
          if (cb.checked) this.ui.fields.add(cb.dataset.field);
          else this.ui.fields.delete(cb.dataset.field);
        });
      });
      const nextBtn = document.getElementById('tfNextBtn');
      if (nextBtn) nextBtn.addEventListener('click', () => {
        if (!this.ui.fields.size) { Toast.show('Pilih minimal 1 field.', 'error'); return; }
        this.ui.step = 'generate';
        this.render();
      });
    } else if (this.ui.step === 'generate') {
      document.querySelectorAll('[data-tab]').forEach(btn => {
        btn.addEventListener('click', () => { this.ui.mode = btn.dataset.tab; this.render(); });
      });
      const backBtn = document.getElementById('tfBackBtn');
      if (backBtn) backBtn.addEventListener('click', () => { this.ui.step = 'template'; this.render(); });
      const contentInput = document.getElementById('tfContentInput');
      if (contentInput) contentInput.addEventListener('input', () => { this.ui.content = contentInput.value; });
      const imageInput = document.getElementById('tfImageInput');
      if (imageInput) imageInput.addEventListener('change', async () => {
        const files = Array.from(imageInput.files || []);
        for (const file of files) {
          if (this.ui.images.length >= 5) { Toast.show('Maksimal 5 screenshot per generate.', 'error'); break; }
          const dataUrl = await new Promise(resolve => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.readAsDataURL(file);
          });
          if (dataUrl.length > 4 * 1024 * 1024) { Toast.show('Ukuran screenshot terlalu besar (maks ~4MB).', 'error'); continue; }
          this.ui.images.push(dataUrl);
        }
        this.render();
      });
      document.querySelectorAll('[data-remove-img]').forEach(btn => {
        btn.addEventListener('click', () => {
          this.ui.images.splice(Number(btn.dataset.removeImg), 1);
          this.render();
        });
      });
      const genBtn = document.getElementById('tfGenerateBtn');
      if (genBtn) genBtn.addEventListener('click', () => this.generate());
    } else {
      this.bindReviewEvents();
    }
  },

  async generate(){
    if (this.ui.mode !== 'screenshot' && !this.ui.content.trim()) {
      Toast.show('Isi konten dulu.', 'error'); return;
    }
    if (this.ui.mode === 'screenshot' && !this.ui.images.length) {
      Toast.show('Upload minimal 1 screenshot.', 'error'); return;
    }
    this.ui.loading = true;
    this.render();
    try {
      const res = await fetch(`${API_BASE}/testforge/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: this.ui.mode,
          content: this.ui.content,
          images: this.ui.mode === 'screenshot' ? this.ui.images : undefined,
          fields: Array.from(this.ui.fields)
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Generate gagal');
      this.ui.staged = data.testcases || [];
      this.ui.loading = false;
      this.ui.step = 'review';
      this.render();
    } catch (e) {
      this.ui.loading = false;
      Toast.show(`AI response invalid, coba lagi. (${e.message})`, 'error');
      this.render();
    }
  },

  bindReviewEvents(){
    document.querySelectorAll('[data-del-staged]').forEach(btn => {
      btn.addEventListener('click', () => {
        this.ui.staged.splice(Number(btn.dataset.delStaged), 1);
        this.render();
      });
    });
    document.querySelectorAll('[data-staged-field]').forEach(el => {
      el.addEventListener('input', () => {
        const [idx, key] = el.dataset.stagedField.split(':');
        this.ui.staged[Number(idx)][key] = el.value;
      });
    });
    const backBtn = document.getElementById('tfBackToGenBtn');
    if (backBtn) backBtn.addEventListener('click', () => { this.ui.step = 'generate'; this.render(); });
    const saveBtn = document.getElementById('tfSaveAllBtn');
    if (saveBtn) saveBtn.addEventListener('click', () => this.saveAll());
  },

  saveAll(){
    if (!Auth.can('testcase_create')) { Toast.show('Tidak punya izin menambah Test Case.', 'error'); return; }
    const fileId = TestCaseModule.ui.activeFileId;
    this.ui.staged.forEach(tc => {
      const module = tc.module || '';
      const newId = IdGen.next(moduleAbbrev(module));
      App.state.testcases.push({
        id: newId,
        module,
        roleUser: tc.roleUser || '',
        scenario: tc.scenario || '',
        testCase: tc.testCase || '',
        preconditions: tc.preconditions || '',
        // AI-sourced text is untrusted; neutralize < > so textToStepsHtml's
        // "already HTML" passthrough (utils.js) never treats it as real HTML.
        steps: textToStepsHtml(String(tc.steps || '').replace(/</g, '&lt;').replace(/>/g, '&gt;')),
        testData: tc.testData || '',
        expectedResult: tc.expectedResult || '',
        actualResult: '',
        typeTest: tc.typeTest || 'Positive',
        status: 'Open',
        executionDate: '',
        customFields: {},
        fileId,
        createdAt: nowISO()
      });
    });
    App.saveTestcases();
    ActivityLog.record('tc_ai_generate', `${this.ui.staged.length} Test Case digenerate via AI (TestForge)`);
    Toast.show(`${this.ui.staged.length} Test Case berhasil disimpan.`, 'success');
    this.close();
    TestCaseModule.render();
  }
};

document.addEventListener('DOMContentLoaded', () => {
  const btn = document.getElementById('tcAiGenerateBtn');
  if (btn) btn.addEventListener('click', () => TestForgeModule.open());
  // Delegated so it also catches [data-close] buttons rendered later
  // inside #tfBody (the Batal button in the template step).
  document.getElementById('tfModalOverlay').addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) TestForgeModule.close();
  });
});
