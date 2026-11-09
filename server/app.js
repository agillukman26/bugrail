const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const db = require('./db');
const { hashPassword, isHashed, verifyPassword, normalizeEmail, userWorkspaceIds, can, findUser, sanitizeSettings, applySettingsWrite } = require('./auth');

const ALLOWED_KEYS = new Set(['qa_testcases', 'qa_bugs', 'qa_files', 'qa_settings', 'qa_counters', 'qa_activity_log']);

const app = express();
app.use(cors());
app.use(express.json({ limit: '20mb' }));
// Serve the frontend too, so local dev is just `npm start` + http://localhost:3001
app.use(express.static(require('path').join(__dirname, '..', 'qa-app')));

// Fixed-window limiter shared by login and the AI routes. map: key -> [timestamps].
// ponytail: in-memory only (resets on restart, not shared across instances, keys never pruned)
// — fine for a single-process internal tool.
function hitLimit(map, key, limit, windowMs){
  const now = Date.now();
  const hits = (map.get(key) || []).filter(t => now - t < windowMs);
  hits.push(now);
  map.set(key, hits);
  return hits.length > limit;
}

const LOGIN_RATE_LIMIT = 10;
const LOGIN_RATE_WINDOW_MS = 5 * 60 * 1000;
const loginHits = new Map(); // ip|email -> [timestamps]
const SESSION_TTL_S = 30 * 24 * 60 * 60;
// Read per request (tests toggle it). Off => passwords stay in their stored format: old builds can't read hashes.
const hashUpgrade = () => process.env.PASSWORD_HASH_UPGRADE === '1';

let sessionIndex = null; // TTL index, created once on first login; failure must not block login
function ensureSessionIndex(conn){
  // On failure forget the promise so the next login retries.
  if (!sessionIndex) sessionIndex = Promise.resolve(conn.collection('sessions').createIndex({ createdAt: 1 }, { expireAfterSeconds: SESSION_TTL_S })).catch(() => { sessionIndex = null; });
  return sessionIndex;
}

// Tell open browsers qa_settings changed (rev read back, since updateOne doesn't return it).
async function broadcastSettings(conn){
  const row = await conn.collection('kv_store').findOne({ _id: 'qa_settings' });
  broadcast({ key: 'qa_settings', rev: (row && row.rev) || 0 });
}

// First login on an empty DB: create the default admin. The filter only matches when users is
// missing/empty, so it can never overwrite real accounts; if users exist the upsert hits a
// duplicate _id (11000) => someone else already seeded.
async function seedAdmin(conn){
  const user = { email: 'admin@bugrail.local', password: hashUpgrade() ? await hashPassword('sama') : 'sama', role: 'admin' };
  try {
    await conn.collection('kv_store').updateOne(
      { _id: 'qa_settings', $or: [{ 'value.users': { $exists: false } }, { 'value.users': { $size: 0 } }] },
      { $set: { 'value.users': [user] }, $inc: { rev: 1 } },
      { upsert: true }
    );
  } catch (err) {
    if (err && err.code === 11000) return null;
    throw err;
  }
  await broadcastSettings(conn);
  return user;
}

app.post('/api/login', async (req, res) => {
  try {
    const email = normalizeEmail(req.body && req.body.email);
    const password = req.body && req.body.password;
    if (hitLimit(loginHits, `${req.ip}|${email}`, LOGIN_RATE_LIMIT, LOGIN_RATE_WINDOW_MS)) {
      return res.status(429).json({ error: 'Terlalu banyak percobaan login, coba lagi nanti.' });
    }
    const conn = await db.getDb();
    const kv = conn.collection('kv_store');
    const load = async () => { const row = await kv.findOne({ _id: 'qa_settings' }); return (row && row.value) || {}; };
    const settings = await load();
    let user = findUser(settings, email);
    if (!(settings.users || []).length) {
      const seeded = await seedAdmin(conn);
      user = findUser(seeded ? { users: [seeded] } : await load(), email);
    }
    if (!user || typeof password !== 'string' || !(await verifyPassword(user.password, password))) {
      return res.status(401).json({ error: 'Email atau password salah.' });
    }
    // Lazy upgrade: filter on the old plaintext so a concurrent password change is never overwritten.
    // Best effort: the password was already verified, so a failed upgrade must not fail the login (next login retries).
    if (hashUpgrade() && !isHashed(user.password)) {
      try {
        const r = await kv.updateOne(
          { _id: 'qa_settings', 'value.users': { $elemMatch: { email: user.email, password: user.password } } },
          { $set: { 'value.users.$.password': await hashPassword(password) }, $inc: { rev: 1 } }
        );
        if (r.modifiedCount) await broadcastSettings(conn);
      } catch (err) {
        console.error('POST /api/login: password hash upgrade failed', err);
      }
    }
    const token = crypto.randomBytes(32).toString('hex');
    await ensureSessionIndex(conn);
    await conn.collection('sessions').insertOne({ _id: token, email: user.email, createdAt: new Date() });
    res.json({ token, email: user.email, role: user.role, workspaceIds: userWorkspaceIds(user) });
  } catch (err) {
    console.error('POST /api/login failed', err);
    res.status(500).json({ error: 'Database unreachable' });
  }
});

// Everything below /api needs a valid session. Identity (role, workspaces) comes from the
// stored user, never from client headers. Static frontend files are served before this.
async function requireAuth(req, res, next){
  const m = /^Bearer (.+)$/.exec(req.get('authorization') || '');
  // ?token= only for the SSE stream (EventSource can't set headers); URLs end up in logs.
  const token = m ? m[1] : (req.path === '/events' && typeof req.query.token === 'string' ? req.query.token : '');
  if (!token) return res.status(503).json({ error: 'Aplikasi diperbarui — muat ulang halaman (Ctrl+F5).' });
  try {
    const conn = await db.getDb();
    const session = await conn.collection('sessions').findOne({ _id: token });
    const row = session && await conn.collection('kv_store').findOne({ _id: 'qa_settings' });
    const settings = (row && row.value) || {};
    const user = session && findUser(settings, session.email);
    if (!user) return res.status(401).json({ error: 'Sesi tidak valid, silakan login ulang.' });
    const workspaceIds = userWorkspaceIds(user);
    const workspace = req.get('x-workspace') || '';
    if (workspace && user.role !== 'admin' && !workspaceIds.includes(workspace)) {
      return res.status(403).json({ error: 'Bukan anggota workspace ini.' });
    }
    req.token = token;
    req.user = { email: user.email, role: user.role, workspaceIds };
    req.settings = settings;
    req.workspace = workspace;
    req.canShare = can(settings, user.role, 'testcase_fileShare');
    next();
  } catch (err) {
    console.error('requireAuth failed', err);
    res.status(500).json({ error: 'Database unreachable' });
  }
}
app.use('/api', requireAuth);

app.post('/api/logout', async (req, res) => {
  try {
    const conn = await db.getDb();
    await conn.collection('sessions').deleteOne({ _id: req.token });
    res.json({ ok: true });
  } catch (err) {
    console.error('POST /api/logout failed', err);
    res.status(500).json({ error: 'Database unreachable' });
  }
});

// Bell "read up to" time per user (own collection, nothing else touched), so reading on
// one laptop clears the badge on the others. Server clock, and $max: never goes backwards.
app.get('/api/notif-seen', async (req, res) => {
  try {
    const conn = await db.getDb();
    const row = await conn.collection('notif_seen').findOne({ _id: normalizeEmail(req.user.email) });
    res.json({ at: (row && row.at) || '' });
  } catch (err) {
    console.error('GET /api/notif-seen failed', err);
    res.status(500).json({ error: 'Database unreachable' });
  }
});
app.put('/api/notif-seen', async (req, res) => {
  try {
    const conn = await db.getDb();
    const at = new Date().toISOString();
    await conn.collection('notif_seen').updateOne({ _id: normalizeEmail(req.user.email) }, { $max: { at } }, { upsert: true });
    broadcast({ key: 'notif_seen' }); // no email in the message: each browser re-reads its own
    res.json({ at });
  } catch (err) {
    console.error('PUT /api/notif-seen failed', err);
    res.status(500).json({ error: 'Database unreachable' });
  }
});

// Passwords never leave the server.
const publicValue = (key, value) => (key === 'qa_settings' && value && typeof value === 'object' ? sanitizeSettings(value) : value);

// All KV pairs at once — used for the one-time hydrate on app boot.
app.get('/api/kv', async (req, res) => {
  try {
    const conn = await db.getDb();
    const rows = await conn.collection('kv_store').find().toArray();
    // _revs: each key's version, sent back on PUT so a stale write is refused (see PUT below).
    // _auth: tells the client this server polices passwords; without it the client stops writing
    // (an older server would store its password-less users and wipe every password).
    const out = { _revs: {}, _auth: 1 };
    rows.forEach(r => { out[r._id] = publicValue(r._id, r.value); out._revs[r._id] = r.rev || 0; });
    res.json(out);
  } catch (err) {
    console.error('GET /api/kv failed', err);
    res.status(500).json({ error: 'Database unreachable' });
  }
});

app.get('/api/kv/:key', async (req, res) => {
  try {
    const conn = await db.getDb();
    const row = await conn.collection('kv_store').findOne({ _id: req.params.key });
    res.json({ value: row ? publicValue(req.params.key, row.value) : null, rev: (row && row.rev) || 0, _auth: 1 }); // _auth: see GET /api/kv
  } catch (err) {
    console.error('GET /api/kv/:key failed', err);
    res.status(500).json({ error: 'Database unreachable' });
  }
});

// The client always PUTs the WHOLE qa_files array (every workspace's files,
// since Auth.visibleFiles() lets a non-admin see files shared into their
// workspace too) — so validation must diff against what's already stored
// and only police what THIS write actually changed, not every row in the
// array, or a non-admin would get 403'd just for having someone else's
// file present-but-untouched in their payload.
function sameSharedWith(a, b){
  const x = (a || []).slice().sort();
  const y = (b || []).slice().sort();
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

async function validateFilesWrite(req, res, next){
  const { role } = req.user;
  const { workspace, canShare } = req;
  if (role === 'admin') return next();
  const files = Array.isArray(req.body.value) ? req.body.value : [];
  try {
    const conn = await db.getDb();
    const row = await conn.collection('kv_store').findOne({ _id: 'qa_files' });
    const oldFiles = (row && Array.isArray(row.value)) ? row.value : [];
    const oldById = new Map(oldFiles.map(f => [f.id, f]));
    const newById = new Map(files.map(f => [f.id, f]));

    for (const f of files){
      const old = oldById.get(f.id);
      if (!old){
        // New file: must be created in own workspace (or shared/legacy).
        if (f.workspaceId && f.workspaceId !== workspace){
          return res.status(403).json({ error: `Tidak berhak membuat file di workspace lain: ${f.id}` });
        }
        continue;
      }
      const changed = old.name !== f.name || old.workspaceId !== f.workspaceId || !sameSharedWith(old.sharedWith, f.sharedWith);
      if (!changed) continue;
      // Editing an existing file: only its owning workspace (or legacy/shared) may touch it.
      if (old.workspaceId && old.workspaceId !== workspace){
        return res.status(403).json({ error: `Tidak berhak mengubah file milik workspace lain: ${f.id}` });
      }
      if (!sameSharedWith(old.sharedWith, f.sharedWith) && !canShare){
        return res.status(403).json({ error: `Tidak punya izin share file: ${f.id}` });
      }
    }
    for (const old of oldFiles){
      if (newById.has(old.id)) continue;
      // Deleting a file: only its owning workspace (or legacy/shared) may delete it.
      if (old.workspaceId && old.workspaceId !== workspace){
        return res.status(403).json({ error: `Tidak berhak menghapus file milik workspace lain: ${old.id}` });
      }
    }
    next();
  } catch (err) {
    console.error('validateFilesWrite failed', err);
    res.status(500).json({ error: 'Database unreachable' });
  }
}

// A qa_settings write must keep every top-level key already stored (users,
// workspaces, roles, rolePermissions, bugStatusMaster...). A client that booted
// without the real settings (offline fallback, empty browser storage) would
// otherwise replace them with its seed defaults — this once wiped every account
// and workspace. Clearing a list is still fine: send it as [] / {}.
async function validateSettingsWrite(req, res, next){
  const value = req.body.value;
  if (!value || typeof value !== 'object' || Array.isArray(value)){
    return res.status(400).json({ error: 'qa_settings harus berupa object' });
  }
  try {
    const conn = await db.getDb();
    const row = await conn.collection('kv_store').findOne({ _id: 'qa_settings' });
    const stored = (row && row.value && typeof row.value === 'object') ? row.value : {};
    const missing = Object.keys(stored).filter(k => !(k in value));
    if (missing.length){
      return res.status(409).json({ error: `Settings ditolak: akan menghapus ${missing.join(', ')} di server. Muat ulang halaman.` });
    }
    // Passwords/roles/permissions are policed here, not trusted from the client (see auth.js).
    const result = await applySettingsWrite(stored, value, req.user, { hashUpgrade: hashUpgrade() });
    if (result.status) return res.status(result.status).json({ error: result.error });
    req.body.value = result.value;
    // Whose password this write changes: their other sessions end once it is saved (see PUT).
    req.pwChanged = value.users && Array.isArray(value.users)
      ? value.users.filter(u => u && u.newPassword !== undefined).map(u => (findUser(stored, u.email) || u).email)
      : [];
    next();
  } catch (err) {
    console.error('validateSettingsWrite failed', err);
    res.status(500).json({ error: 'Database unreachable' });
  }
}

// qa_bugs is PUT whole too — only police bugs this write ADDS (ids not stored yet):
// title + actual result present, and (non-admin) the bug's file belongs to the
// writer's workspace, is shared into it, or is legacy (no workspace).
// The full form rules (qa-app/js/utils.js BUG_FORM) stay client-side: Excel
// import and bugs saved before those fields existed don't carry them.
async function validateBugsWrite(req, res, next){
  const { role } = req.user;
  const { workspace } = req;
  const bugs = Array.isArray(req.body.value) ? req.body.value : null;
  if (!bugs) return res.status(400).json({ error: 'qa_bugs harus berupa array' });
  try {
    const conn = await db.getDb();
    const row = await conn.collection('kv_store').findOne({ _id: 'qa_bugs' });
    const known = new Set(((row && Array.isArray(row.value)) ? row.value : []).map(b => b.id));
    const added = bugs.filter(b => b && !known.has(b.id));
    if (!added.length) return next();
    const text = v => String(v == null ? '' : v).trim();
    for (const b of added){
      if (b.status === 'Entry') continue; // auto draft from a Failed test case: tester fills title later
      const title = text(b.title).length;
      if (!title || title > 150) return res.status(400).json({ error: `Bug Title wajib diisi (maks. 150 karakter): ${b.code || b.id}` });
      if (!text(b.actualResult)) return res.status(400).json({ error: `Actual Result wajib diisi: ${b.code || b.id}` });
    }
    if (role === 'admin') return next();
    const filesRow = await conn.collection('kv_store').findOne({ _id: 'qa_files' });
    const files = new Map(((filesRow && Array.isArray(filesRow.value)) ? filesRow.value : []).map(f => [f.id, f]));
    for (const b of added){
      const f = files.get(b.fileId);
      const member = !f || !f.workspaceId || f.workspaceId === workspace || (f.sharedWith || []).includes(workspace);
      if (!member) return res.status(403).json({ error: `Tidak berhak membuat bug di workspace lain: ${b.code || b.id}` });
    }
    next();
  } catch (err) {
    console.error('validateBugsWrite failed', err);
    res.status(500).json({ error: 'Database unreachable' });
  }
}

// Live push (Server-Sent Events): every open browser keeps GET /api/events open and is told
// which key changed after each saved PUT, then re-reads just that key. Only key + rev go out.
// ponytail: in-memory listener set — fine for one Node process; needs Redis pub/sub if scaled out.
const listeners = new Set();
function broadcast(msg){
  const line = `data: ${JSON.stringify(msg)}\n\n`;
  listeners.forEach(res => res.write(line));
}
app.get('/api/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' }); // no-buffer: nginx
  res.flushHeaders();
  res.write(': connected\n\n');
  listeners.add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000); // keeps proxies from closing an idle stream
  req.on('close', () => { clearInterval(ping); listeners.delete(res); });
});

// Password changed: log that user out everywhere except the session that made the change.
// Already saved, so a failure is only logged.
async function endSessions(conn, emails, keepToken){
  try {
    await conn.collection('sessions').deleteMany({ email: { $in: emails }, _id: { $ne: keepToken } });
  } catch (err) {
    console.error('ending sessions after password change failed', err);
  }
}

app.put('/api/kv/:key', async (req, res, next) => {
  if (req.params.key === 'qa_files') return validateFilesWrite(req, res, next);
  if (req.params.key === 'qa_bugs') return validateBugsWrite(req, res, next);
  if (req.params.key === 'qa_settings') return validateSettingsWrite(req, res, next);
  next();
}, async (req, res) => {
  const { key } = req.params;
  if (!ALLOWED_KEYS.has(key)) return res.status(400).json({ error: `Unknown key: ${key}` });
  // Optimistic lock: every value is PUT whole, so a write based on an old copy
  // would silently wipe what other users/tabs saved since. The client sends the
  // rev it last read; only that exact rev may be replaced (atomically, rev + 1).
  const rev = req.body.rev;
  if (!Number.isInteger(rev) || rev < 0){
    return res.status(409).json({ error: 'Aplikasi versi lama — muat ulang halaman (Ctrl+F5).', stale: true });
  }
  try {
    const conn = await db.getDb();
    const doc = await conn.collection('kv_store').findOneAndUpdate(
      { _id: key, rev: rev === 0 ? { $in: [0, null] } : rev }, // null matches docs saved before revs existed
      { $set: { value: req.body.value }, $inc: { rev: 1 } },
      { upsert: true, returnDocument: 'after' }
    );
    res.json({ ok: true, rev: doc.rev });
    broadcast({ key, rev: doc.rev });
    if (req.pwChanged && req.pwChanged.length) await endSessions(conn, req.pwChanged, req.token);
  } catch (err) {
    // Upsert collided with the existing doc => its rev moved on: someone saved first.
    if (err && err.code === 11000) return res.status(409).json({ error: 'Data sudah diubah di tab/user lain.', stale: true });
    console.error('PUT /api/kv/:key failed', err);
    res.status(500).json({ error: 'Database unreachable' });
  }
});

const VALID_FIELDS = ['module', 'roleUser', 'scenario', 'testCase', 'preconditions', 'steps', 'testData', 'expectedResult', 'typeTest'];

const TESTFORGE_RATE_LIMIT = 10;
const TESTFORGE_RATE_WINDOW_MS = 5 * 60 * 1000;
const testForgeHits = new Map(); // ip -> [timestamps]
const isTestForgeRateLimited = ip => hitLimit(testForgeHits, ip, TESTFORGE_RATE_LIMIT, TESTFORGE_RATE_WINDOW_MS);

// Returns the model's text, or null when the provider call fails (logged).
async function askGemini(apiKey, parts){
  const geminiRes = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({ contents: [{ parts }] })
    }
  );
  if (!geminiRes.ok) {
    console.error('Gemini API error', geminiRes.status, await geminiRes.text());
    return null;
  }
  const geminiJson = await geminiRes.json();
  return geminiJson?.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

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
  // Paused (server load) — the UI button is hidden too. Set TESTFORGE_ENABLED=1 in .env to turn it back on.
  if (process.env.TESTFORGE_ENABLED !== '1') {
    return res.status(503).json({ error: 'Fitur Generate AI sedang dinonaktifkan.' });
  }
  try {
    if (isTestForgeRateLimited(req.ip)) {
      return res.status(429).json({ error: 'Too many requests, coba lagi nanti.' });
    }
    const { mode, content, images, fields, module, apiKey: bodyApiKey } = req.body || {};
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
    if (mode === 'screenshot' && images.length > 5) {
      return res.status(400).json({ error: 'Maksimal 5 screenshot per generate.' });
    }

    const apiKey = (typeof bodyApiKey === 'string' && bodyApiKey.trim()) || process.env.GEMINI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'GEMINI_API_KEY belum diisi. Isi di halaman Settings atau .env server.' });

    const promptText = buildTestForgePrompt(mode, content, cleanFields, module);
    const parts = [{ text: promptText }];
    if (mode === 'screenshot') {
      images.forEach(dataUrl => {
        const m = String(dataUrl).match(/^data:(image\/[a-zA-Z+]+);base64,(.+)$/);
        if (m) parts.push({ inline_data: { mime_type: m[1], data: m[2] } });
      });
    }

    const rawText = await askGemini(apiKey, parts);
    if (rawText === null) return res.status(502).json({ error: 'AI provider error' });
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

// Failed test case -> draft bug (title, severity, priority, analysis). The tester
// reviews it in the bug form before saving; nothing is stored here.
const BUG_SEVERITIES = ['Critical', 'High', 'Medium', 'Low'];
const BUG_PRIORITIES = ['Urgent', 'High', 'Medium', 'Low'];
const BUG_TC_FIELDS = ['module', 'scenario', 'testCase', 'preconditions', 'steps', 'testData', 'expectedResult', 'actualResult'];

function buildBugAnalyzePrompt(tc){
  const lines = BUG_TC_FIELDS.map(f => `${f}: ${String(tc[f] || '').slice(0, 3000)}`).join('\n');
  return `You are a QA engineer. This test case FAILED. Write a bug report draft from it, based mainly on the actualResult vs expectedResult.
Respond with ONLY a JSON object, no markdown fences, with these keys:
title = short bug title (max 120 chars, Bahasa Indonesia), describing what is wrong;
severity = one of ${BUG_SEVERITIES.join(', ')};
priority = one of ${BUG_PRIORITIES.join(', ')};
analysis = short analysis in Bahasa Indonesia (max 600 chars): impact to the user and possible cause.
Test case:
${lines}`;
}

app.post('/api/bug/analyze', async (req, res) => {
  try {
    if (isTestForgeRateLimited(req.ip)) {
      return res.status(429).json({ error: 'Too many requests, coba lagi nanti.' });
    }
    const { testcase, apiKey: bodyApiKey } = req.body || {};
    if (!testcase || typeof testcase !== 'object' || !String(testcase.actualResult || '').trim()) {
      return res.status(400).json({ error: 'Actual Result test case wajib diisi' });
    }
    const apiKey = (typeof bodyApiKey === 'string' && bodyApiKey.trim()) || process.env.GEMINI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'GEMINI_API_KEY belum diisi. Isi di halaman Settings atau .env server.' });

    const rawText = await askGemini(apiKey, [{ text: buildBugAnalyzePrompt(testcase) }]);
    if (rawText === null) return res.status(502).json({ error: 'AI provider error' });
    let parsed;
    try { parsed = JSON.parse((rawText.match(/\{[\s\S]*\}/) || [])[0]); } catch (e) { parsed = null; }
    if (!parsed || typeof parsed !== 'object') return res.status(502).json({ error: 'AI response JSON parse failed' });
    const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
    res.json({
      title: str(parsed.title, 150),
      severity: BUG_SEVERITIES.includes(parsed.severity) ? parsed.severity : '',
      priority: BUG_PRIORITIES.includes(parsed.priority) ? parsed.priority : '',
      analysis: str(parsed.analysis, 2000)
    });
  } catch (err) {
    console.error('POST /api/bug/analyze failed', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

module.exports = { app, sameSharedWith, isTestForgeRateLimited, buildTestForgePrompt, buildBugAnalyzePrompt, testForgeHits };
