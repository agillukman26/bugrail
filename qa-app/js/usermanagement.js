/* ==========================================================
   usermanagement.js — admin-only page for managing login
   accounts (App.state.settings.users).
   ========================================================== */

const UserManagementModule = {
  editingEmail: null,

  render(){
    if (!Auth.can('usermanagement')){
      document.getElementById('page-usermanagement').innerHTML = `<p class="text-faint" style="padding:24px 0; text-align:center;">Anda tidak punya akses ke halaman ini.</p>`;
      return;
    }
    this.renderUsers();
  },

  countAdmins(users){ return users.filter(u => u.role === 'admin').length; },
  roleLabel(value){ return (Auth.ROLES.find(r => r.value === value) || {}).label || value; },
  workspaceLabel(id){ return id ? ((Auth.findWorkspace(id) || {}).name || '-') : '(Semua / Shared)'; },

  renderUsers(){
    const users = App.state.settings.users || [];
    const body = document.getElementById('settUsersTableBody');
    if (!body) return;
    body.innerHTML = users.length ? users.map(u => `
      <tr>
        <td>${escapeHtml(u.email)}</td>
        <td>${escapeHtml(this.roleLabel(u.role))}</td>
        <td>${escapeHtml(this.workspaceLabel(u.workspaceId))}</td>
        <td>${actionMenu(`
          <button data-edit-user="${escapeHtml(u.email)}">✎ Edit</button>
          <button class="danger" data-del-user="${escapeHtml(u.email)}">🗑 Hapus</button>
        `)}</td>
      </tr>
    `).join('') : `<tr><td colspan="4" class="text-faint" style="font-size:12.5px;">Belum ada user.</td></tr>`;
    body.querySelectorAll('[data-edit-user]').forEach(btn => {
      btn.onclick = () => this.startEditUser(btn.dataset.editUser);
    });
    body.querySelectorAll('[data-del-user]').forEach(btn => {
      btn.onclick = () => this.deleteUser(btn.dataset.delUser);
    });
  },

  openUserModal(){
    document.getElementById('userFormModalOverlay').classList.add('active');
  },
  closeUserModal(){
    document.getElementById('userFormModalOverlay').classList.remove('active');
  },

  startCreateUser(){
    this.resetUserForm();
    this.refreshWorkspaceSelect();
    this.openUserModal();
  },

  startEditUser(email){
    const user = Auth.findByEmail(App.state.settings.users || [], email);
    if (!user) return;
    this.editingEmail = user.email;
    document.getElementById('userFormTitle').textContent = 'Edit User';
    const emailInput = document.getElementById('settUserEmail');
    emailInput.value = user.email;
    emailInput.disabled = true;
    const pwInput = document.getElementById('settUserPassword');
    pwInput.value = '';
    pwInput.placeholder = 'Kosongkan jika tidak diubah';
    document.getElementById('settUserRole').value = user.role;
    this.refreshWorkspaceSelect();
    document.getElementById('settUserWorkspace').value = user.workspaceId || '';
    document.getElementById('settUserSaveBtn').textContent = 'Simpan Perubahan';
    this.openUserModal();
  },

  resetUserForm(){
    this.editingEmail = null;
    document.getElementById('userFormTitle').textContent = 'Tambah User';
    const emailInput = document.getElementById('settUserEmail');
    emailInput.value = '';
    emailInput.disabled = false;
    const pwInput = document.getElementById('settUserPassword');
    pwInput.value = '';
    pwInput.placeholder = 'Min 4 karakter';
    document.getElementById('settUserRole').value = 'user';
    document.getElementById('settUserWorkspace').value = '';
    document.getElementById('settUserSaveBtn').textContent = 'Simpan';
  },

  saveUser(){
    const users = App.state.settings.users || (App.state.settings.users = []);
    const emailInput = document.getElementById('settUserEmail');
    const email = Auth.normalizeEmail(emailInput.value);
    const password = document.getElementById('settUserPassword').value;
    const role = document.getElementById('settUserRole').value;
    const workspaceId = document.getElementById('settUserWorkspace').value || null;

    if (this.editingEmail){
      const user = Auth.findByEmail(users, this.editingEmail);
      if (!user) return;
      if (user.role === 'admin' && role !== 'admin' && this.countAdmins(users) <= 1){
        Toast.show('Minimal harus ada 1 admin.', 'error'); return;
      }
      if (password){
        if (password.length < 4){ Toast.show('Password minimal 4 karakter.', 'error'); return; }
        user.password = password;
      }
      user.role = role;
      user.workspaceId = workspaceId;
      App.saveSettings();
      this.resetUserForm();
      this.closeUserModal();
      this.renderUsers();
      Toast.show('User diperbarui.', 'success');
      return;
    }

    if (!Auth.isValidEmail(email)){ Toast.show('Format email tidak valid.', 'error'); return; }
    if (Auth.findByEmail(users, email)){ Toast.show('Email sudah terdaftar.', 'error'); return; }
    if (password.length < 4){ Toast.show('Password minimal 4 karakter.', 'error'); return; }

    users.push({ email, password, role, workspaceId });
    App.saveSettings();
    this.resetUserForm();
    this.closeUserModal();
    this.renderUsers();
    Toast.show('User ditambahkan.', 'success');
  },

  async deleteUser(email){
    const users = App.state.settings.users || [];
    const user = Auth.findByEmail(users, email);
    if (!user) return;
    if (Auth.normalizeEmail(email) === Auth.currentEmail()){
      Toast.show('Tidak bisa menghapus akun yang sedang login.', 'error'); return;
    }
    if (user.role === 'admin' && this.countAdmins(users) <= 1){
      Toast.show('Minimal harus ada 1 admin.', 'error'); return;
    }
    const ok = await confirmDialog('Hapus User?', `User "${user.email}" akan dihapus permanen.`, 'Hapus');
    if (!ok) return;
    App.state.settings.users = users.filter(u => u !== user);
    App.saveSettings();
    if (this.editingEmail === user.email) this.resetUserForm();
    this.renderUsers();
    Toast.show('User dihapus.', 'info');
  },

  /* ---- Role Permission matrix (settings.rolePermissions, adjustable anytime) ---- */
  renderRolePermissions(){
    if (!Auth.isAdmin()){
      document.getElementById('page-rolepermission').innerHTML = `<p class="text-faint" style="padding:24px 0; text-align:center;">Hanya untuk Admin.</p>`;
      return;
    }
    const roles = Auth.ROLES.filter(r => r.value !== 'admin');
    const body = document.getElementById('rolePermTableBody');
    body.innerHTML = roles.length ? roles.map(r => {
      const perms = App.state.settings.rolePermissions[r.value] || {};
      const activeCount = Auth.PERMISSION_KEYS.filter(p => perms[p.key]).length;
      return `
        <tr>
          <td>${escapeHtml(r.label)}</td>
          <td class="mono text-dim">${escapeHtml(r.value)}</td>
          <td>${activeCount} / ${Auth.PERMISSION_KEYS.length}</td>
          <td style="white-space:nowrap;">${actionMenu(`
            <button data-role-edit="${r.value}">✎ Edit</button>
            <button data-role-dup="${r.value}">⧉ Duplikat</button>
            <button class="danger" data-role-del="${r.value}">🗑 Hapus</button>
          `)}</td>
        </tr>
      `;
    }).join('') : `<tr><td colspan="4" class="text-faint" style="font-size:12.5px;">Belum ada role. Klik "+ Tambah Role".</td></tr>`;

    body.querySelectorAll('[data-role-edit]').forEach(btn => {
      btn.addEventListener('click', () => this.startEditRole(btn.dataset.roleEdit));
    });
    body.querySelectorAll('[data-role-dup]').forEach(btn => {
      btn.addEventListener('click', () => this.startDuplicateRole(btn.dataset.roleDup));
    });
    body.querySelectorAll('[data-role-del]').forEach(btn => {
      btn.addEventListener('click', () => this.deleteRole(btn.dataset.roleDel));
    });
  },

  /* ---- Role Form modal (create/edit role + its permission checkboxes) ---- */
  roleEditingValue: null,
  /* Menu groups for the permission checklist: keyed by the permission key's prefix. */
  PERM_GROUPS: [
    { title: 'Umum', match: k => k === 'dashboard' || k === 'summary' },
    { title: 'Test Case', match: k => k.startsWith('testcase_') },
    { title: 'Bug Report', match: k => k.startsWith('bugreport_') },
    { title: 'Administrasi', match: k => k === 'master' || k === 'usermanagement' || k === 'settings' }
  ],

  openRoleModal(){ document.getElementById('roleFormModalOverlay').classList.add('active'); },
  closeRoleModal(){ document.getElementById('roleFormModalOverlay').classList.remove('active'); },

  renderRoleFormPerms(checkedMap){
    const map = checkedMap || {};
    const remaining = new Set(Auth.PERMISSION_KEYS.map(p => p.key));
    const groups = this.PERM_GROUPS.map(g => {
      const keys = Auth.PERMISSION_KEYS.filter(p => g.match(p.key));
      keys.forEach(p => remaining.delete(p.key));
      return { title: g.title, keys };
    }).filter(g => g.keys.length);
    const rest = Auth.PERMISSION_KEYS.filter(p => remaining.has(p.key));
    if (rest.length) groups.push({ title: 'Lainnya', keys: rest });

    document.getElementById('roleFormPerms').innerHTML = groups.map(g => `
      <div class="role-perm-group">
        <div class="role-perm-group-title">${escapeHtml(g.title)}</div>
        <div class="role-perm-group-items">
          ${g.keys.map(p => `
            <label><input type="checkbox" class="checkbox" data-form-perm="${p.key}" ${map[p.key] ? 'checked' : ''}><span>${escapeHtml(p.label)}</span></label>
          `).join('')}
        </div>
      </div>
    `).join('');
  },

  resetRoleForm(){
    this.roleEditingValue = null;
    document.getElementById('roleFormTitle').textContent = 'Tambah Role';
    document.getElementById('roleFormLabel').value = '';
    const codeInput = document.getElementById('roleFormCode');
    codeInput.value = ''; codeInput.disabled = false;
    this.renderRoleFormPerms({});
  },

  startCreateRole(){
    this.resetRoleForm();
    this.openRoleModal();
  },

  startEditRole(value){
    const role = Auth.findRole(value);
    if (!role) return;
    this.roleEditingValue = value;
    document.getElementById('roleFormTitle').textContent = 'Edit Role';
    document.getElementById('roleFormLabel').value = role.label;
    const codeInput = document.getElementById('roleFormCode');
    codeInput.value = role.value; codeInput.disabled = true;
    this.renderRoleFormPerms(App.state.settings.rolePermissions[value] || {});
    this.openRoleModal();
  },

  startDuplicateRole(value){
    const role = Auth.findRole(value);
    if (!role) return;
    this.roleEditingValue = null;
    document.getElementById('roleFormTitle').textContent = 'Duplikat Role';
    document.getElementById('roleFormLabel').value = `${role.label} (Copy)`;
    const codeInput = document.getElementById('roleFormCode');
    codeInput.value = ''; codeInput.disabled = false;
    this.renderRoleFormPerms(App.state.settings.rolePermissions[value] || {});
    this.openRoleModal();
  },

  saveRole(){
    const label = document.getElementById('roleFormLabel').value;
    const code = document.getElementById('roleFormCode').value;
    const perms = {};
    document.querySelectorAll('#roleFormPerms input[type=checkbox]').forEach(cb => {
      perms[cb.dataset.formPerm] = cb.checked;
    });

    if (this.roleEditingValue){
      const result = Auth.updateRole(this.roleEditingValue, label);
      if (!result.ok){ Toast.show(result.error, 'error'); return; }
      App.state.settings.rolePermissions[this.roleEditingValue] = perms;
      App.saveSettings();
      Toast.show('Role diperbarui.', 'success');
    } else {
      const result = Auth.addRole(label, code);
      if (!result.ok){ Toast.show(result.error, 'error'); return; }
      App.state.settings.rolePermissions[result.value] = perms;
      App.saveSettings();
      Toast.show('Role dibuat.', 'success');
    }
    this.closeRoleModal();
    this.resetRoleForm();
    this.renderRolePermissions();
    document.getElementById('settUserRole').innerHTML = Auth.ROLES.map(r => `<option value="${r.value}">${escapeHtml(r.label)}</option>`).join('');
  },

  async deleteRole(value){
    const role = Auth.findRole(value);
    if (!role) return;
    const ok = await confirmDialog('Hapus Role?', `Role "${role.label}" akan dihapus permanen.`, 'Hapus');
    if (!ok) return;
    const result = Auth.deleteRole(value);
    if (!result.ok){ Toast.show(result.error, 'error'); return; }
    this.renderRolePermissions();
    document.getElementById('settUserRole').innerHTML = Auth.ROLES.map(r => `<option value="${r.value}">${escapeHtml(r.label)}</option>`).join('');
    Toast.show('Role dihapus.', 'info');
  },

  /* ---- Workspace management (settings.workspaces) ---- */
  workspaceEditingId: null,

  refreshWorkspaceSelect(){
    document.getElementById('settUserWorkspace').innerHTML = '<option value="">(Semua / Shared)</option>' +
      Auth.workspaces().map(w => `<option value="${w.id}">${escapeHtml(w.name)}</option>`).join('');
  },

  renderWorkspaces(){
    if (!Auth.isAdmin()){
      document.getElementById('page-workspace').innerHTML = `<p class="text-faint" style="padding:24px 0; text-align:center;">Hanya untuk Admin.</p>`;
      return;
    }
    const workspaces = Auth.workspaces();
    const users = App.state.settings.users || [];
    const files = App.state.files || [];
    const body = document.getElementById('workspaceTableBody');
    body.innerHTML = workspaces.length ? workspaces.map(w => `
      <tr>
        <td>${escapeHtml(w.name)}</td>
        <td>${users.filter(u => u.workspaceId === w.id).length}</td>
        <td>${files.filter(f => f.workspaceId === w.id).length}</td>
        <td>${actionMenu(`
          <button data-ws-edit="${w.id}">✎ Edit</button>
          <button class="danger" data-ws-del="${w.id}">🗑 Hapus</button>
        `)}</td>
      </tr>
    `).join('') : `<tr><td colspan="4" class="text-faint" style="font-size:12.5px;">Belum ada workspace. Klik "+ Tambah Workspace".</td></tr>`;
    body.querySelectorAll('[data-ws-edit]').forEach(btn => {
      btn.addEventListener('click', () => this.startEditWorkspace(btn.dataset.wsEdit));
    });
    body.querySelectorAll('[data-ws-del]').forEach(btn => {
      btn.addEventListener('click', () => this.deleteWorkspace(btn.dataset.wsDel));
    });
  },

  openWorkspaceModal(){ document.getElementById('workspaceFormModalOverlay').classList.add('active'); },
  closeWorkspaceModal(){ document.getElementById('workspaceFormModalOverlay').classList.remove('active'); },

  resetWorkspaceForm(){
    this.workspaceEditingId = null;
    document.getElementById('workspaceFormTitle').textContent = 'Tambah Workspace';
    document.getElementById('workspaceFormName').value = '';
  },

  startCreateWorkspace(){
    this.resetWorkspaceForm();
    this.openWorkspaceModal();
  },

  startEditWorkspace(id){
    const ws = Auth.findWorkspace(id);
    if (!ws) return;
    this.workspaceEditingId = id;
    document.getElementById('workspaceFormTitle').textContent = 'Edit Workspace';
    document.getElementById('workspaceFormName').value = ws.name;
    this.openWorkspaceModal();
  },

  saveWorkspace(){
    const name = document.getElementById('workspaceFormName').value;
    const result = this.workspaceEditingId
      ? Auth.updateWorkspace(this.workspaceEditingId, name)
      : Auth.addWorkspace(name);
    if (!result.ok){ Toast.show(result.error, 'error'); return; }
    Toast.show(this.workspaceEditingId ? 'Workspace diperbarui.' : 'Workspace dibuat.', 'success');
    this.closeWorkspaceModal();
    this.resetWorkspaceForm();
    this.renderWorkspaces();
    this.refreshWorkspaceSelect();
  },

  async deleteWorkspace(id){
    const ws = Auth.findWorkspace(id);
    if (!ws) return;
    const ok = await confirmDialog('Hapus Workspace?', `Workspace "${ws.name}" akan dihapus permanen.`, 'Hapus');
    if (!ok) return;
    const result = Auth.deleteWorkspace(id);
    if (!result.ok){ Toast.show(result.error, 'error'); return; }
    this.renderWorkspaces();
    this.refreshWorkspaceSelect();
    Toast.show('Workspace dihapus.', 'info');
  },

  bindStaticEvents(){
    document.getElementById('settUserRole').innerHTML = Auth.ROLES.map(r => `<option value="${r.value}">${escapeHtml(r.label)}</option>`).join('');
    this.refreshWorkspaceSelect();
    document.getElementById('settUserCreateBtn').addEventListener('click', () => this.startCreateUser());
    document.getElementById('settUserSaveBtn').addEventListener('click', () => this.saveUser());
    const userModal = document.getElementById('userFormModalOverlay');
    userModal.querySelectorAll('[data-close]').forEach(btn => {
      btn.addEventListener('click', () => this.resetUserForm());
    });
    userModal.addEventListener('click', e => { if (e.target === userModal) this.resetUserForm(); });

    document.getElementById('rolePermCreateBtn').addEventListener('click', () => this.startCreateRole());
    document.getElementById('roleFormSaveBtn').addEventListener('click', () => this.saveRole());
    const roleModal = document.getElementById('roleFormModalOverlay');
    roleModal.querySelectorAll('[data-close]').forEach(btn => {
      btn.addEventListener('click', () => this.resetRoleForm());
    });
    roleModal.addEventListener('click', e => { if (e.target === roleModal) this.resetRoleForm(); });

    document.getElementById('workspaceCreateBtn').addEventListener('click', () => this.startCreateWorkspace());
    document.getElementById('workspaceFormSaveBtn').addEventListener('click', () => this.saveWorkspace());
    const wsModal = document.getElementById('workspaceFormModalOverlay');
    wsModal.querySelectorAll('[data-close]').forEach(btn => {
      btn.addEventListener('click', () => this.resetWorkspaceForm());
    });
    wsModal.addEventListener('click', e => { if (e.target === wsModal) this.resetWorkspaceForm(); });
  }
};

document.addEventListener('DOMContentLoaded', () => {
  UserManagementModule.bindStaticEvents();
  const origGoTo = App.goTo.bind(App);
  App.goTo = (page) => {
    origGoTo(page);
    if (page === 'usermanagement') UserManagementModule.render();
    if (page === 'rolepermission') UserManagementModule.renderRolePermissions();
    if (page === 'workspace') UserManagementModule.renderWorkspaces();
  };
});
