const crypto = require('crypto');
const { promisify, isDeepStrictEqual } = require('util');
const scrypt = promisify(crypto.scrypt);

// Copy of DEFAULT_ROLE_PERMISSIONS in qa-app/js/auth.js — keep in sync.
const DEFAULT_ROLE_PERMISSIONS = {
  pm_ba: { dashboard: true, summary: true, report: true, bugreport_read: true, bugreport_updateStatusPriority: true },
  qa_internal: { testcase_create: true, testcase_read: true, testcase_update: true, testcase_fileShare: true, bugreport_fileCreate: true, bugreport_create: true, bugreport_read: true, bugreport_update: true, bugreport_statusQA: true },
  qa_vendor: { testcase_create: true, testcase_read: true, testcase_update: true, bugreport_read: true, bugreport_update: true, bugreport_board: true, bugreport_statusQA: true },
  user_umum: { testcase_read: true, bugreport_read: true }
};

// Settings key -> permission needed to change it.
const GATES = { users: 'usermanagement', roles: 'usermanagement', rolePermissions: 'usermanagement', workspaces: 'usermanagement', bugStatusMaster: 'master', bugSeverityMaster: 'master', bugPriorityMaster: 'master', customFieldDefs: 'settings', geminiApiKey: 'settings' };

const isPlain = v => v && typeof v === 'object' && !Array.isArray(v);
const normalizeEmail = e => String(e || '').trim().toLowerCase();
const isHashed = s => typeof s === 'string' && s.startsWith('scrypt$');

async function hashPassword(plain){
  const salt = crypto.randomBytes(16);
  const key = await scrypt(String(plain), salt, 64);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

async function verifyPassword(stored, plain){
  if (!stored || typeof stored !== 'string') return false;
  if (!isHashed(stored)) return stored === plain; // legacy plaintext
  const [, saltHex, hashHex] = stored.split('$');
  if (!saltHex || !hashHex) return false;
  const want = Buffer.from(hashHex, 'hex');
  const got = await scrypt(String(plain), Buffer.from(saltHex, 'hex'), want.length);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

// Copy of WorkspaceCalc.userWorkspaceIds (qa-app/js/workspace.js).
function userWorkspaceIds(user){
  if (!user) return [];
  if (Array.isArray(user.workspaceIds)) return user.workspaceIds.filter(Boolean);
  return user.workspaceId ? [user.workspaceId] : [];
}

function can(settings, role, permKey){
  if (role === 'admin') return true;
  const r = role === 'user' ? 'user_umum' : role;
  const map = { ...DEFAULT_ROLE_PERMISSIONS[r], ...settings?.rolePermissions?.[r] };
  return !!map[permKey];
}

function findUser(settings, email){
  const n = normalizeEmail(email);
  return (settings?.users || []).find(u => normalizeEmail(u.email) === n) || null;
}

const sanUser = ({ password, newPassword, ...rest }) => rest;
function sanitizeSettings(value){
  const out = { ...value };
  if (Array.isArray(out.users)) out.users = out.users.map(sanUser);
  return out;
}

// True if b keeps everything in a (b may only add keys).
function onlyAdds(a, b){
  if (a === undefined) return true;
  if (isPlain(a) && isPlain(b)) return Object.keys(a).every(k => k in b && onlyAdds(a[k], b[k]));
  return JSON.stringify(a) === JSON.stringify(b);
}

const sameJson = isDeepStrictEqual; // key order must not matter
const err = (status, error) => ({ status, error });

// Validate + merge a client settings write. actor = { email, role }.
async function applySettingsWrite(stored, incoming, actor, { hashUpgrade } = {}){
  stored = stored || {};
  const out = { ...incoming };
  const may = k => can(stored, actor.role, k);
  if (incoming.users !== undefined && !Array.isArray(incoming.users)) return err(400, 'users harus berupa array');
  const inUsers = Array.isArray(incoming.users) ? incoming.users : null;

  if (inUsers) {
    const seen = new Set();
    for (const u of inUsers) {
      const n = normalizeEmail(u.email);
      if (seen.has(n)) return err(400, `Email user duplikat: ${n}`);
      seen.add(n);
    }
    out.users = [];
    for (const u of inUsers) {
      const sm = findUser(stored, u.email);
      const { password, newPassword, ...rest } = u;
      if (sm?.password !== undefined) rest.password = sm.password; // clients never set passwords directly
      if (newPassword !== undefined) {
        if (!may('usermanagement')) return err(403, 'Tidak punya izin.');
        if (typeof newPassword !== 'string' || newPassword.length < 4) return err(400, 'Password minimal 4 karakter.');
        rest.password = hashUpgrade ? await hashPassword(newPassword) : newPassword;
      } else if (!sm) return err(400, 'User baru harus punya password.');
      out.users.push(rest);
    }
  }

  const sStored = sanitizeSettings(stored);
  const sIncoming = sanitizeSettings(incoming);
  for (const [k, perm] of Object.entries(GATES)) {
    let changed;
    if (k === 'users') {
      if (!inUsers) continue;
      const sUsers = sStored.users || [];
      changed = sUsers.some(x => !findUser(sIncoming, x.email)) // removed
        || sIncoming.users.some(u => { const sm = sUsers.find(x => normalizeEmail(x.email) === normalizeEmail(u.email)); return !sm || !sameJson(sm, u); })
        || inUsers.some(u => u.newPassword !== undefined);
    } else changed = !onlyAdds(sStored[k], sIncoming[k]);
    if (changed && !may(perm)) return err(403, 'Tidak punya izin.');
  }

  if (actor.role !== 'admin' && inUsers) {
    for (const u of inUsers) {
      if (u.role === 'admin' && findUser(stored, u.email)?.role !== 'admin') return err(403, 'Hanya admin yang boleh memberi role admin.');
    }
    for (const sm of stored.users || []) {
      if (sm.role !== 'admin') continue;
      const u = inUsers.find(x => normalizeEmail(x.email) === normalizeEmail(sm.email));
      if (!u || u.newPassword !== undefined || !sameJson(sanUser(sm), sanUser(u))) return err(403, 'Hanya admin yang boleh mengubah admin.');
    }
  }
  return { value: out };
}

module.exports = { hashPassword, isHashed, verifyPassword, normalizeEmail, userWorkspaceIds, DEFAULT_ROLE_PERMISSIONS, can, findUser, sanitizeSettings, applySettingsWrite, onlyAdds };
