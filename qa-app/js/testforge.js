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
