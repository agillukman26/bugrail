/* ==========================================================
   settings.js — data management & app preferences
   ========================================================== */

const SettingsModule = {
  render(){
    if (!Auth.can('settings')){
      document.getElementById('page-settings').innerHTML = `<p class="text-faint" style="padding:24px 0; text-align:center;">Anda tidak punya akses ke halaman ini.</p>`;
      return;
    }
    const bytes = new Blob([
      JSON.stringify(App.state.testcases),
      JSON.stringify(App.state.bugs)
    ]).size;
    const kb = (bytes / 1024).toFixed(1);
    document.getElementById('settStorageUsage').textContent = `${kb} KB data (disimpan di MySQL server)`;
    document.getElementById('settTcCount').textContent = App.state.testcases.length;
    document.getElementById('settBugCount').textContent = App.state.bugs.length;
    document.getElementById('settGeminiKeyInput').value = App.state.settings.geminiApiKey || '';
    this.renderCustomFields();
  },

  saveGeminiKey(){
    const input = document.getElementById('settGeminiKeyInput');
    App.state.settings.geminiApiKey = input.value.trim();
    App.saveSettings();
    Toast.show('API Key TestForge disimpan.', 'success');
  },

  renderCustomFields(){
    const defs = App.state.settings.customFieldDefs || [];
    document.getElementById('settCustomFieldList').innerHTML = defs.length ? defs.map(d => `
      <div class="flex-between" style="padding:4px 0;">
        <span>${escapeHtml(d.label)}</span>
        <button class="btn sm ghost" data-rm-field="${escapeHtml(d.label)}">🗑</button>
      </div>
    `).join('') : `<p class="text-faint" style="font-size:12.5px;">Belum ada custom field.</p>`;
    document.querySelectorAll('#settCustomFieldList [data-rm-field]').forEach(btn => {
      btn.onclick = () => this.removeCustomField(btn.dataset.rmField);
    });
  },
  addCustomField(){
    const input = document.getElementById('settCustomFieldInput');
    const label = input.value.trim();
    if (!label) return;
    const defs = App.state.settings.customFieldDefs || (App.state.settings.customFieldDefs = []);
    if (defs.some(d => d.label === label)){
      Toast.show('Field dengan nama itu sudah ada.', 'error'); return;
    }
    defs.push({ label });
    App.saveSettings();
    input.value = '';
    this.renderCustomFields();
    Toast.show(`Field "${label}" ditambahkan.`, 'success');
  },
  removeCustomField(label){
    App.state.settings.customFieldDefs = (App.state.settings.customFieldDefs || []).filter(d => d.label !== label);
    App.saveSettings();
    this.renderCustomFields();
  },

  async clearAll(){
    const ok = await confirmDialog('Hapus Semua Data?', 'Seluruh Test Case dan Bug Report akan dihapus permanen dari Local Storage.', 'Hapus Semua');
    if (!ok) return;
    App.state.testcases = [];
    App.state.bugs = [];
    Storage.set(STORAGE_KEYS.COUNTERS, {});
    App.saveTestcases(); App.saveBugs();
    this.render();
    Toast.show('Semua data telah dihapus.', 'info');
  },

  bindStaticEvents(){
    document.getElementById('settClearBtn').addEventListener('click', () => this.clearAll());
    document.getElementById('settThemeSelect').addEventListener('change', e => {
      App.state.settings.theme = e.target.value;
      App.saveSettings(); App.applyTheme();
    });
    document.getElementById('settCustomFieldAddBtn').addEventListener('click', () => this.addCustomField());
    document.getElementById('settGeminiKeySaveBtn').addEventListener('click', () => this.saveGeminiKey());
  }
};

document.addEventListener('DOMContentLoaded', () => {
  SettingsModule.bindStaticEvents();
  const origGoTo = App.goTo.bind(App);
  App.goTo = (page) => { origGoTo(page); if (page === 'settings') SettingsModule.render(); };
});
