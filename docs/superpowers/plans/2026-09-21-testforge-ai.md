# TestForge AI Test Case Generator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an AI-powered "Generate (AI)" button to the Test Case module that produces draft test cases from BRS text, a screenshot, or free text, staged for review/edit/delete before being saved into the real test case table.

**Architecture:** Backend (`server/server.js`) gains one proxy endpoint that calls Google's Gemini free-tier API server-side (API key never touches the browser) and returns a JSON array of test case field objects. Frontend gains a new self-contained module (`qa-app/js/testforge.js`) with its own modal (added to `qa-app/index.html`) driving a 3-step flow: field template → source tab (BRS/Screenshot/Free Text) → review staging list. Saving from the review step reuses the existing `IdGen`/`moduleAbbrev`/`App.saveTestcases()` path already used by manual test case creation, so no data-layer changes are needed.

**Tech Stack:** Node/Express backend (existing), vanilla JS frontend modules (existing pattern), Gemini REST API (`gemini-1.5-flash`) called via built-in `fetch` (Node 18+, no new HTTP client dependency), no new npm packages.

**Spec:** `docs/superpowers/specs/2026-09-21-testforge-ai-design.md`

## Global Constraints

- No new npm dependencies (no `multer`, no AI SDK) — screenshots sent as base64 JSON strings; Gemini called with Node's built-in `fetch`.
- API key lives only in `.env` as `GEMINI_API_KEY`, read server-side only.
- Staged/generated rows are NOT written to `App.state.testcases` (and thus not persisted) until the user explicitly clicks "Save All to Test Case".
- Reuse existing ID generation (`IdGen.next(moduleAbbrev(...))`), existing field set (module, roleUser, scenario, testCase, preconditions, steps, testData, expectedResult, typeTest), existing `ActivityLog.record`, existing `Toast.show` for all new UI/backend touchpoints — no parallel implementations of these.
- No automated test harness exists in this repo (spec confirms manual testing only) — every task's verification step is a manual `curl`/browser check, not an automated test run.

---

## File Structure

- **Modify:** `server/server.js` — add `POST /api/testforge/generate` endpoint + Gemini call helper.
- **Modify:** `.env` — add `GEMINI_API_KEY=` line (value supplied by user, not committed with a real key).
- **Create:** `qa-app/js/testforge.js` — `TestForgeModule`: modal state, field template, tab switching, generate call, staging list render, save-to-testcase.
- **Modify:** `qa-app/index.html` — add "✨ Generate (AI)" button next to `tcAddBtn`; add new modal markup `#tfModalOverlay`; add `<script src="js/testforge.js?v=1">` after `testcase.js`.
- **Modify:** `qa-app/css/style.css` — minimal styling for the field-checklist row, tab buttons, and staged-row list (reuse existing `.modal`, `.btn`, `.field` classes where possible).

## Task 1: Backend — Gemini proxy endpoint

**Files:**
- Modify: `server/server.js` (add route after existing `/api/kv` routes, before `app.listen`)
- Modify: `.env` (add `GEMINI_API_KEY=` line)

**Interfaces:**
- Produces: `POST /api/testforge/generate` — request `{ mode: 'brs'|'screenshot'|'text', content: string, images?: string[], fields: string[], module?: string }`, response `{ testcases: [...] }` on success (200), `{ error: string, raw?: string }` on failure (400/502/500).

- [ ] **Step 1: Add the route handler**

In `server/server.js`, add after the `/api/kv/:key` PUT handler (before the 404/error middleware, if any — otherwise right before `app.listen`):

```javascript
const VALID_FIELDS = ['module', 'roleUser', 'scenario', 'testCase', 'preconditions', 'steps', 'testData', 'expectedResult', 'typeTest'];

function buildTestForgePrompt(mode, content, fields, module){
  const fieldList = fields.join(', ');
  const moduleHint = module ? `The module/feature under test is "${module}".` : '';
  const sourceLabel = mode === 'brs' ? 'the following BRS (Business Requirement Specification) text'
    : mode === 'screenshot' ? 'the attached application screenshot(s)'
    : 'the following description';
  return `You are a QA test case generator. Based on ${sourceLabel}, generate a JSON array of test cases.
${moduleHint}
Each object in the array must contain ONLY these fields: ${fieldList}.
Field meanings: module=feature area name, roleUser=user role performing the action, scenario=short scenario title, testCase=detailed test case description, preconditions=state required before testing, steps=numbered test steps as plain text (one step per line), testData=input data to use, expectedResult=expected outcome, typeTest=either "Positive" or "Negative".
Respond with ONLY the JSON array, no markdown fences, no explanation.
${mode !== 'screenshot' ? `Content:\n${content}` : (content ? `Additional instructions: ${content}` : '')}`;
}

app.post('/api/testforge/generate', async (req, res) => {
  try {
    const { mode, content, images, fields, module } = req.body || {};
    if (!['brs', 'screenshot', 'text'].includes(mode)) {
      return res.status(400).json({ error: 'Invalid mode' });
    }
    const cleanFields = Array.isArray(fields) ? fields.filter(f => VALID_FIELDS.includes(f)) : [];
    if (!cleanFields.length) {
      return res.status(400).json({ error: 'No valid fields selected' });
    }
    if (mode !== 'screenshot' && !String(content || '').trim()) {
      return res.status(400).json({ error: 'Content is required for this mode' });
    }
    if (mode === 'screenshot' && (!Array.isArray(images) || !images.length)) {
      return res.status(400).json({ error: 'At least one image is required for screenshot mode' });
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'GEMINI_API_KEY not configured on server' });

    const promptText = buildTestForgePrompt(mode, content, cleanFields, module);
    const parts = [{ text: promptText }];
    if (mode === 'screenshot') {
      images.forEach(dataUrl => {
        const m = String(dataUrl).match(/^data:(image\/[a-zA-Z+]+);base64,(.+)$/);
        if (m) parts.push({ inline_data: { mime_type: m[1], data: m[2] } });
      });
    }

    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts }] })
      }
    );
    if (!geminiRes.ok) {
      const errText = await geminiRes.text();
      console.error('Gemini API error', geminiRes.status, errText);
      return res.status(502).json({ error: 'AI provider error', raw: errText });
    }
    const geminiJson = await geminiRes.json();
    const rawText = geminiJson?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const jsonMatch = rawText.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      return res.status(502).json({ error: 'AI response had no JSON array', raw: rawText });
    }
    let parsed;
    try {
      parsed = JSON.parse(jsonMatch[0]);
    } catch (e) {
      return res.status(502).json({ error: 'AI response JSON parse failed', raw: rawText });
    }
    if (!Array.isArray(parsed)) {
      return res.status(502).json({ error: 'AI response was not an array', raw: rawText });
    }
    const testcases = parsed.map(tc => {
      const out = {};
      cleanFields.forEach(f => { out[f] = typeof tc[f] === 'string' ? tc[f] : ''; });
      return out;
    });
    res.json({ testcases });
  } catch (err) {
    console.error('POST /api/testforge/generate failed', err);
    res.status(500).json({ error: 'Server error' });
  }
});
```

- [ ] **Step 2: Add the env var placeholder**

Edit `.env`, add a new line:

```
GEMINI_API_KEY=
```

(User fills in their own free Gemini API key from https://aistudio.google.com/apikey — leave blank in the repo, it is gitignored per existing `.env` handling.)

- [ ] **Step 3: Verify manually — missing field validation**

Run: `node server/server.js` in one terminal (or restart if already running), then in another terminal:

```bash
curl -s -X POST http://localhost:3001/api/testforge/generate -H "Content-Type: application/json" -d "{\"mode\":\"text\",\"content\":\"\",\"fields\":[\"scenario\"]}"
```

Expected: `{"error":"Content is required for this mode"}`

- [ ] **Step 4: Verify manually — successful generation (requires a real GEMINI_API_KEY in .env)**

```bash
curl -s -X POST http://localhost:3001/api/testforge/generate -H "Content-Type: application/json" -d "{\"mode\":\"text\",\"content\":\"Login page with email and password fields, a Login button, and Forgot Password link.\",\"fields\":[\"module\",\"scenario\",\"testCase\",\"steps\",\"expectedResult\",\"typeTest\"]}"
```

Expected: 200 response with `{"testcases":[{...}, ...]}`, each object containing only the 6 requested keys.

- [ ] **Step 5: Commit**

```bash
git add server/server.js .env
git commit -m "feat: add TestForge Gemini proxy endpoint

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 2: Frontend — TestForge module skeleton + modal markup

**Files:**
- Create: `qa-app/js/testforge.js`
- Modify: `qa-app/index.html` (add button, modal markup, script tag)

**Interfaces:**
- Consumes: `App.state.testcases` (read), `App.saveTestcases()`, `IdGen.next(prefix)`, `moduleAbbrev(module)`, `Auth.currentWorkspaceId()` — via `TestCaseModule.ui.activeFileId` for `fileId`, `ActivityLog.record(action, label)`, `Toast.show(msg, type)`, `nowISO()`, `textToStepsHtml(text)`, `stepsHtmlToText(html)`, `API_BASE` (global, from `utils.js`).
- Produces: `TestForgeModule` global object with `open()`, `close()`, `render()` methods used by Task 3/4 steps.

- [ ] **Step 1: Add the button and modal markup to index.html**

In `qa-app/index.html`, find the line with `id="tcAddBtn"` (around line 189) and add the new button right before it:

```html
<button class="btn sm" type="button" id="tcAiGenerateBtn">✨ Generate (AI)</button>
```

Then, right after the closing `</div>` of `#tcModalOverlay` (after line 631 area, before the Import modal comment), add the new modal:

```html
<!-- ============ MODAL: TestForge AI Generate ============ -->
<div class="modal-overlay" id="tfModalOverlay">
  <div class="modal lg">
    <div class="modal-header">
      <h2 id="tfModalTitle">Generate Test Case (AI)</h2>
      <button class="close-x" data-close="tfModalOverlay">✕</button>
    </div>
    <div id="tfBody"></div>
  </div>
</div>
```

`#tfBody` is re-rendered entirely by `TestForgeModule.render()` for each step (template/tabs/review), keeping the static HTML minimal.

- [ ] **Step 2: Add the script tag**

In `qa-app/index.html`, after the line `<script src="js/testcase.js?v=29"></script>`, add:

```html
<script src="js/testforge.js?v=1"></script>
```

- [ ] **Step 3: Create testforge.js with module skeleton**

Create `qa-app/js/testforge.js`:

```javascript
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

  renderTemplateStep(){ return '<p>placeholder — Task 3</p>'; },
  renderGenerateStep(){ return '<p>placeholder — Task 3</p>'; },
  renderReviewStep(){ return '<p>placeholder — Task 4</p>'; },
  bindStepEvents(){}
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
```

- [ ] **Step 4: Verify manually — modal opens**

Open the app in a browser (or `run` skill if available), go to Test Case page inside a file, click "✨ Generate (AI)".

Expected: modal opens showing "placeholder — Task 3" text, close button (✕) closes it.

- [ ] **Step 5: Commit**

```bash
git add qa-app/index.html qa-app/js/testforge.js
git commit -m "feat: add TestForge modal skeleton and open/close wiring

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 3: Frontend — Template step + source tabs + generate call

**Files:**
- Modify: `qa-app/js/testforge.js`

**Interfaces:**
- Consumes: `TESTFORGE_FIELDS`, `API_BASE` (global from utils.js), `Toast.show`.
- Produces: after successful generate, `TestForgeModule.ui.staged` populated with objects shaped `{ ...only selected fields as strings... }`, and `TestForgeModule.ui.step` set to `'review'` (consumed by Task 4).

- [ ] **Step 1: Implement renderTemplateStep and its bindings**

Replace `renderTemplateStep(){ return '<p>placeholder — Task 3</p>'; }` in `qa-app/js/testforge.js` with:

```javascript
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
```

- [ ] **Step 2: Implement renderGenerateStep and its bindings**

Replace `renderGenerateStep(){ return '<p>placeholder — Task 3</p>'; }` with:

```javascript
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
```

- [ ] **Step 3: Implement bindStepEvents to wire both steps + the generate API call**

Replace `bindStepEvents(){}` with:

```javascript
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

  bindReviewEvents(){},
```

(`bindReviewEvents` and `renderReviewStep` real bodies come in Task 4 — this task only needs the stub so `bindStepEvents` doesn't throw.)

- [ ] **Step 4: Add minimal CSS for the new elements**

In `qa-app/css/style.css`, append:

```css
.tf-field-grid{ display:grid; grid-template-columns:repeat(auto-fill,minmax(160px,1fr)); gap:8px; margin-top:10px; }
.field-check{ display:flex; align-items:center; gap:6px; font-size:13px; }
.tf-tabs{ display:flex; gap:8px; }
.tf-thumb-row{ display:flex; gap:8px; flex-wrap:wrap; margin:8px 0; }
.tf-thumb{ position:relative; width:80px; height:80px; }
.tf-thumb img{ width:100%; height:100%; object-fit:cover; border-radius:6px; }
.tf-thumb-remove{ position:absolute; top:-6px; right:-6px; background:#e03131; color:#fff; border:none; border-radius:50%; width:18px; height:18px; cursor:pointer; font-size:11px; line-height:1; }
```

- [ ] **Step 5: Verify manually — template and generate steps**

In browser: click "✨ Generate (AI)" → uncheck a field, click "Lanjut" → switch between BRS/Screenshot/Free Text tabs → type BRS text → click Generate (needs backend running with valid `GEMINI_API_KEY`).

Expected: loading state shows, then either the review step renders (placeholder still, from Task 2) with staged rows in memory, or an error toast appears if the key isn't configured — both are correct behavior at this point.

- [ ] **Step 6: Commit**

```bash
git add qa-app/js/testforge.js qa-app/css/style.css
git commit -m "feat: add TestForge field template, source tabs, and generate call

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 4: Frontend — Review step (edit/delete staged rows) + Save to Test Case

**Files:**
- Modify: `qa-app/js/testforge.js`

**Interfaces:**
- Consumes: `TestCaseModule.ui.activeFileId`, `IdGen.next(prefix)`, `moduleAbbrev(module)`, `App.state.testcases`, `App.saveTestcases()`, `ActivityLog.record(action, label)`, `TestCaseModule.render()` (to refresh the table after save), `textToStepsHtml(text)` (steps stored as plain text from AI, converted to the rich-editor HTML format used elsewhere).
- Produces: nothing consumed by later tasks — this is the terminal step.

- [ ] **Step 1: Implement renderReviewStep**

Replace `renderReviewStep(){ return '<p>placeholder — Task 4</p>'; }` in `qa-app/js/testforge.js` with:

```javascript
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
            <textarea data-staged-field="${i}:${key}" rows="${key === 'steps' || key === 'testCase' ? 3 : 1}">${tc[key] || ''}</textarea>
          </div>`).join('')}
      </div>`).join('');
    return `
      <div class="tf-staged-list">${rows}</div>
      <div class="modal-footer">
        <button type="button" class="btn" id="tfBackToGenBtn">◂ Generate Ulang</button>
        <button type="button" class="btn primary" id="tfSaveAllBtn">Simpan Semua ke Test Case</button>
      </div>`;
  },
```

- [ ] **Step 2: Implement bindReviewEvents**

Replace `bindReviewEvents(){}` with:

```javascript
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
        steps: textToStepsHtml(tc.steps || ''),
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
```

- [ ] **Step 3: Verify manually — full flow**

With backend running and `GEMINI_API_KEY` set: open Test Case file → click "✨ Generate (AI)" → keep all fields checked → Free Text tab → type "Checkout page with cart total, promo code field, and Pay Now button" → Generate → wait for review step → edit one row's Scenario text → delete one row → click "Simpan Semua ke Test Case".

Expected: modal closes, toast "N Test Case berhasil disimpan.", new rows appear in the Test Case table with auto-generated IDs matching module abbreviation, status "Open". Open Activity Log page, confirm a `tc_ai_generate` entry exists.

- [ ] **Step 4: Verify manually — cancel discards nothing persisted**

Repeat generate flow, reach review step, then click the modal's ✕ close button instead of Save.

Expected: modal closes, Test Case table unchanged, no new rows, no activity log entry. Reopening "✨ Generate (AI)" starts fresh at the template step (confirms `open()` resets `ui`).

- [ ] **Step 5: Commit**

```bash
git add qa-app/js/testforge.js
git commit -m "feat: add TestForge review step with edit/delete and save-to-testcase

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```
