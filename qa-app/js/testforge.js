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
      sourceHtml = `<textarea id="tfContentInput" rows="8" placeholder="Paste BRS text di sini...">${this.ui.content}</textarea>`;
    } else if (this.ui.mode === 'text') {
      sourceHtml = `<textarea id="tfContentInput" rows="8" placeholder="Jelaskan fitur/skenario yang mau di-generate...">${this.ui.content}</textarea>`;
    } else {
      const previews = this.ui.images.map((img, i) => `
        <div class="tf-thumb"><img src="${img}"><button type="button" class="tf-thumb-remove" data-remove-img="${i}">✕</button></div>`).join('');
      sourceHtml = `
        <input type="file" id="tfImageInput" accept="image/*" multiple>
        <div class="tf-thumb-row">${previews}</div>
        <textarea id="tfContentInput" rows="3" placeholder="Instruksi tambahan (opsional)...">${this.ui.content}</textarea>`;
    }

    return `
      <div class="tf-tabs">${tabs}</div>
      <div class="tf-source" style="margin-top:12px;">${sourceHtml}</div>
      <div class="modal-footer">
        <button type="button" class="btn" id="tfBackBtn">◂ Kembali</button>
        <button type="button" class="btn primary" id="tfGenerateBtn" ${this.ui.loading ? 'disabled' : ''}>${this.ui.loading ? 'Generating...' : 'Generate'}</button>
      </div>`;
  },

  renderReviewStep(){ return '<p>placeholder — Task 4</p>'; },

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
          const dataUrl = await new Promise(resolve => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.readAsDataURL(file);
          });
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

  bindReviewEvents(){}
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
