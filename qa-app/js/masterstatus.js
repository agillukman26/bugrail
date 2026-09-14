/* ==========================================================
   masterstatus.js — Settings > Master > Status Bug Report.
   CRUD for the status list BugReportModule reads (name, order,
   color for the badge). Kode Status is auto-generated from Nama
   Status and acts as the row's immutable id.
   ========================================================== */

const MasterStatusModule = {
  list(){
    const settings = App.state.settings;
    if (!settings.bugStatusMaster || !settings.bugStatusMaster.length){
      settings.bugStatusMaster = BugReportModule.DEFAULT_STATUS_MASTER.map(s => ({ ...s }));
    }
    return settings.bugStatusMaster;
  },

  generateCode(name, excludeCode = null){
    const base = name.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'STATUS';
    const list = this.list();
    let code = base, n = 2;
    while (list.some(s => s.code === code && s.code !== excludeCode)){
      code = `${base}_${n++}`;
    }
    return code;
  },

  render(){
    if (!Auth.can('master')){
      document.getElementById('page-masterstatus').innerHTML = `<p class="text-faint" style="padding:24px 0; text-align:center;">Anda tidak punya akses ke halaman ini.</p>`;
      return;
    }
    const list = this.list().slice().sort((a, b) => a.order - b.order);
    document.getElementById('msTableBody').innerHTML = list.length ? list.map((s, i) => `
      <tr>
        <td>${i + 1}</td>
        <td class="mono">${escapeHtml(s.code)}</td>
        <td>${BugReportModule.statusBadge(s.name)}</td>
        <td><span class="dot" style="display:inline-block; width:10px; height:10px; border-radius:50%; background:${s.color}; margin-right:6px;"></span>${escapeHtml(s.color)}</td>
        <td>${s.order}</td>
        <td>${actionMenu(`
          <button data-edit="${escapeHtml(s.code)}">✎ Edit</button>
          <button class="danger" data-del="${escapeHtml(s.code)}">🗑 Hapus</button>
        `)}</td>
      </tr>
    `).join('') : `<tr><td colspan="6" class="text-faint" style="text-align:center;">Belum ada status.</td></tr>`;

    document.querySelectorAll('#msTableBody [data-edit]').forEach(btn => {
      btn.addEventListener('click', () => this.startEdit(btn.dataset.edit));
    });
    document.querySelectorAll('#msTableBody [data-del]').forEach(btn => {
      btn.addEventListener('click', () => this.remove(btn.dataset.del));
    });
  },

  clearForm(){
    document.getElementById('msEditCode').value = '';
    document.getElementById('msCode').value = '';
    document.getElementById('msName').value = '';
    document.getElementById('msColorPicker').value = '#2563EB';
    document.getElementById('msColorHex').value = '#2563EB';
    document.getElementById('msOrder').value = this.list().length + 1;
  },

  openModal(){
    document.getElementById('msModalOverlay').classList.add('active');
  },

  closeModal(){
    document.getElementById('msModalOverlay').classList.remove('active');
  },

  startCreate(){
    this.clearForm();
    this.clearErrors();
    document.getElementById('msModalTitle').textContent = 'Tambah Status Bug Report';
    this.openModal();
    document.getElementById('msName').focus();
  },

  startEdit(code){
    const s = this.list().find(x => x.code === code);
    if (!s) return;
    document.getElementById('msEditCode').value = s.code;
    document.getElementById('msCode').value = s.code;
    document.getElementById('msName').value = s.name;
    document.getElementById('msColorPicker').value = s.color;
    document.getElementById('msColorHex').value = s.color;
    document.getElementById('msOrder').value = s.order;
    this.clearErrors();
    document.getElementById('msModalTitle').textContent = 'Edit Status Bug Report';
    this.openModal();
    document.getElementById('msName').focus();
  },

  clearErrors(){
    document.getElementById('msNameError').classList.remove('show');
    document.getElementById('msColorError').classList.remove('show');
  },

  showError(id, msg){
    const el = document.getElementById(id);
    el.textContent = msg;
    el.classList.add('show');
  },

  save(){
    this.clearErrors();
    const name = document.getElementById('msName').value.trim();
    const color = document.getElementById('msColorHex').value.trim();
    const order = Number(document.getElementById('msOrder').value) || 1;
    let hasError = false;
    if (!name){ this.showError('msNameError', 'Nama Status wajib diisi.'); hasError = true; }
    if (!/^#[0-9A-Fa-f]{6}$/.test(color)){ this.showError('msColorError', 'Warna Label harus format hex, contoh #2563EB.'); hasError = true; }
    if (hasError) return;

    const list = this.list();
    const editCode = document.getElementById('msEditCode').value;

    if (editCode){
      const s = list.find(x => x.code === editCode);
      if (list.some(x => x.code !== editCode && x.name === name)){
        this.showError('msNameError', 'Nama status sudah dipakai.'); hasError = true;
      }
      if (hasError) return;
      if (s.name !== name){
        App.state.bugs.forEach(b => { if (b.status === s.name) b.status = name; });
        App.saveBugs();
      }
      s.name = name; s.color = color; s.order = order;
      Toast.show(`Status "${name}" disimpan.`, 'success');
    } else {
      if (list.some(x => x.name === name)){
        this.showError('msNameError', 'Nama status sudah dipakai.'); hasError = true;
      }
      if (hasError) return;
      list.push({ code: this.generateCode(name), name, color, order });
      Toast.show(`Status "${name}" ditambahkan.`, 'success');
    }
    App.saveSettings();
    this.clearForm();
    this.closeModal();
    this.render();
  },

  async remove(code){
    const s = this.list().find(x => x.code === code);
    if (!s) return;
    if (App.state.bugs.some(b => b.status === s.name)){
      Toast.show(`Status "${s.name}" masih dipakai bug report, tidak bisa dihapus.`, 'error');
      return;
    }
    const ok = await confirmDialog('Hapus Status?', `Status "${s.name}" akan dihapus dari master.`, 'Hapus');
    if (!ok) return;
    App.state.settings.bugStatusMaster = this.list().filter(x => x.code !== code);
    App.saveSettings();
    this.render();
    Toast.show(`Status "${s.name}" dihapus.`, 'info');
  },

  bindStaticEvents(){
    document.getElementById('msName').addEventListener('input', e => {
      if (!document.getElementById('msEditCode').value){
        document.getElementById('msCode').value = this.generateCode(e.target.value || '');
      }
    });
    document.getElementById('msColorPicker').addEventListener('input', e => {
      document.getElementById('msColorHex').value = e.target.value;
    });
    document.getElementById('msColorHex').addEventListener('input', e => {
      if (/^#[0-9A-Fa-f]{6}$/.test(e.target.value)) document.getElementById('msColorPicker').value = e.target.value;
    });
    document.getElementById('msCreateBtn').addEventListener('click', () => this.startCreate());
    document.getElementById('msSaveBtn').addEventListener('click', () => this.save());
    document.querySelectorAll('#msModalOverlay [data-close]').forEach(btn => {
      btn.addEventListener('click', () => this.closeModal());
    });
    this.clearForm();
  }
};

document.addEventListener('DOMContentLoaded', () => MasterStatusModule.bindStaticEvents());
