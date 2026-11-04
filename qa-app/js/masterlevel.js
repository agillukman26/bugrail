/* ==========================================================
   masterlevel.js — Settings > Master > Severity & Priority.
   One page, two tables (Severity, Priority) sharing one modal.
   Same rules as Status Bug Report (masterstatus.js): Kode is
   auto-generated from Nama and never changes; renaming updates
   bugs that use the old name; a level still used can't be deleted.
   Priority also has SLA (hari + jam, stored as slaHours) -> Due Date of new bugs.
   ========================================================== */

const MasterLevelModule = {
  LABEL: { severity: 'Severity', priority: 'Priority' },
  ui: { kind: 'severity', tab: 'severity' },

  // Tab Severity / Priority: one table visible, the add button follows the tab.
  setTab(kind){
    this.ui.tab = kind;
    document.querySelectorAll('#mlTabs [data-ml-tab]').forEach(el => {
      const on = el.dataset.mlTab === kind;
      el.classList.toggle('active', on);
      el.setAttribute('aria-selected', on);
    });
    document.querySelectorAll('#page-masterlevel [data-ml-panel]').forEach(el => {
      el.style.display = el.dataset.mlPanel === kind ? '' : 'none';
    });
    document.getElementById('mlCreateBtn').textContent = `+ Tambah ${this.LABEL[kind]}`;
  },

  // Editable copy in settings (seeded from BUG_LEVELS.DEFAULTS on first touch).
  list(kind){
    const settings = App.state.settings;
    const key = BUG_LEVELS.KEYS[kind];
    if (!settings[key] || !settings[key].length){
      settings[key] = BUG_LEVELS.DEFAULTS[kind].map(l => ({ ...l }));
    }
    return settings[key];
  },

  generateCode(kind, name, excludeCode = null){
    const base = name.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || kind.toUpperCase();
    const list = this.list(kind);
    let code = base, n = 2;
    while (list.some(l => l.code === code && l.code !== excludeCode)){
      code = `${base}_${n++}`;
    }
    return code;
  },

  render(){
    if (!Auth.can('master')){
      document.getElementById('page-masterlevel').innerHTML = `<p class="text-faint" style="padding:24px 0; text-align:center;">Anda tidak punya akses ke halaman ini.</p>`;
      return;
    }
    ['severity', 'priority'].forEach(kind => this.renderTable(kind));
  },

  renderTable(kind){
    const isPrio = kind === 'priority';
    const cols = isPrio ? 6 : 5;
    const list = BUG_LEVELS.list(kind);
    const body = document.getElementById(isPrio ? 'mlPriorityBody' : 'mlSeverityBody');
    body.innerHTML = list.length ? list.map((l, i) => `
      <tr>
        <td>${i + 1}</td>
        <td class="mono">${escapeHtml(l.code)}</td>
        <td>${BUG_LEVELS.badge(kind, l.name)}</td>
        ${isPrio ? `<td>${BUG_LEVELS.slaLabel(BUG_LEVELS.slaHours(l))}</td>` : ''}
        <td>${l.order}</td>
        <td>${actionMenu(`
          <button data-edit="${escapeHtml(l.code)}">✎ Edit</button>
          <button class="danger" data-del="${escapeHtml(l.code)}">🗑 Hapus</button>
        `)}</td>
      </tr>
    `).join('') : `<tr><td colspan="${cols}" class="text-faint" style="text-align:center;">Belum ada ${this.LABEL[kind]}.</td></tr>`;

    body.querySelectorAll('[data-edit]').forEach(btn => {
      btn.addEventListener('click', () => this.startEdit(kind, btn.dataset.edit));
    });
    body.querySelectorAll('[data-del]').forEach(btn => {
      btn.addEventListener('click', () => this.remove(kind, btn.dataset.del));
    });
  },

  openModal(kind, title){
    this.ui.kind = kind;
    document.getElementById('mlModalTitle').textContent = title;
    document.getElementById('mlCodeLabel').textContent = `Kode ${this.LABEL[kind]}`;
    document.getElementById('mlNameLabel').textContent = `Nama ${this.LABEL[kind]}`;
    document.getElementById('mlSlaField').style.display = kind === 'priority' ? '' : 'none';
    this.clearErrors();
    document.getElementById('mlModalOverlay').classList.add('active');
    document.getElementById('mlName').focus();
  },

  closeModal(){
    document.getElementById('mlModalOverlay').classList.remove('active');
  },

  fillForm(l){
    document.getElementById('mlEditCode').value = l ? l.code : '';
    document.getElementById('mlCode').value = l ? l.code : '';
    document.getElementById('mlName').value = l ? l.name : '';
    const sla = l ? BUG_LEVELS.slaHours(l) : 0;
    document.getElementById('mlSlaDays').value = sla ? Math.floor(sla / 24) : '';
    document.getElementById('mlSlaHours').value = sla ? sla % 24 : '';
    document.getElementById('mlOrder').value = l ? l.order : this.list(this.ui.kind).length + 1;
  },

  startCreate(kind){
    this.ui.kind = kind;
    this.fillForm(null);
    this.openModal(kind, `Tambah ${this.LABEL[kind]}`);
  },

  startEdit(kind, code){
    const l = this.list(kind).find(x => x.code === code);
    if (!l) return;
    this.ui.kind = kind;
    this.fillForm(l);
    this.openModal(kind, `Edit ${this.LABEL[kind]}`);
  },

  clearErrors(){
    ['mlNameError', 'mlSlaError'].forEach(id => document.getElementById(id).classList.remove('show'));
  },

  showError(id, msg){
    const el = document.getElementById(id);
    el.textContent = msg;
    el.classList.add('show');
  },

  save(){
    this.clearErrors();
    const kind = this.ui.kind;
    const label = this.LABEL[kind];
    const name = document.getElementById('mlName').value.trim();
    const order = Number(document.getElementById('mlOrder').value) || 1;
    const slaDays = Number(document.getElementById('mlSlaDays').value || 0);
    const slaJam = Number(document.getElementById('mlSlaHours').value || 0);
    const slaHours = slaDays * 24 + slaJam;
    const list = this.list(kind);
    const editCode = document.getElementById('mlEditCode').value;
    let hasError = false;
    if (!name){ this.showError('mlNameError', `Nama ${label} wajib diisi.`); hasError = true; }
    else if (list.some(x => x.code !== editCode && x.name === name)){ this.showError('mlNameError', `Nama ${label} sudah dipakai.`); hasError = true; }
    if (kind === 'priority' && !(Number.isInteger(slaDays) && slaDays >= 0 && Number.isInteger(slaJam) && slaJam >= 0 && slaJam <= 23 && slaHours > 0)){
      this.showError('mlSlaError', 'SLA wajib diisi: hari bilangan bulat, jam 0–23, total minimal 1 jam.'); hasError = true;
    }
    if (hasError) return;

    const fields = { name, order, ...(kind === 'priority' ? { slaHours } : {}) };
    if (editCode){
      const l = list.find(x => x.code === editCode);
      if (l.name !== name){
        App.state.bugs.forEach(b => { if (b[kind] === l.name) b[kind] = name; });
        App.saveBugs();
      }
      Object.assign(l, fields);
      delete l.slaDays; // superseded by slaHours
      Toast.show(`${label} "${name}" disimpan.`, 'success');
    } else {
      list.push({ code: this.generateCode(kind, name), ...fields });
      Toast.show(`${label} "${name}" ditambahkan.`, 'success');
    }
    App.saveSettings();
    this.closeModal();
    this.render();
  },

  async remove(kind, code){
    const label = this.LABEL[kind];
    const l = this.list(kind).find(x => x.code === code);
    if (!l) return;
    if (App.state.bugs.some(b => b[kind] === l.name)){
      Toast.show(`${label} "${l.name}" masih dipakai bug report, tidak bisa dihapus.`, 'error');
      return;
    }
    if (this.list(kind).length <= 1){
      Toast.show(`Minimal harus ada satu ${label}.`, 'error');
      return;
    }
    const ok = await confirmDialog(`Hapus ${label}?`, `${label} "${l.name}" akan dihapus dari master.`, 'Hapus');
    if (!ok) return;
    App.state.settings[BUG_LEVELS.KEYS[kind]] = this.list(kind).filter(x => x.code !== code);
    App.saveSettings();
    this.render();
    Toast.show(`${label} "${l.name}" dihapus.`, 'info');
  },

  bindStaticEvents(){
    document.getElementById('mlName').addEventListener('input', e => {
      if (!document.getElementById('mlEditCode').value){
        document.getElementById('mlCode').value = this.generateCode(this.ui.kind, e.target.value || '');
      }
    });
    document.querySelectorAll('#mlTabs [data-ml-tab]').forEach(el => {
      el.addEventListener('click', () => this.setTab(el.dataset.mlTab));
      el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' '){ e.preventDefault(); this.setTab(el.dataset.mlTab); } });
    });
    document.getElementById('mlCreateBtn').addEventListener('click', () => this.startCreate(this.ui.tab));
    document.getElementById('mlSaveBtn').addEventListener('click', () => this.save());
    document.querySelectorAll('#mlModalOverlay [data-close]').forEach(btn => {
      btn.addEventListener('click', () => this.closeModal());
    });
  }
};

document.addEventListener('DOMContentLoaded', () => MasterLevelModule.bindStaticEvents());
