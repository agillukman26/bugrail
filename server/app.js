const express = require('express');
const cors = require('cors');
const db = require('./db');

const ALLOWED_KEYS = new Set(['qa_testcases', 'qa_bugs', 'qa_files', 'qa_settings', 'qa_counters', 'qa_activity_log']);

const app = express();
app.use(cors());
app.use(express.json({ limit: '20mb' }));
// Serve the frontend too, so local dev is just `npm start` + http://localhost:3001
app.use(express.static(require('path').join(__dirname, '..', 'qa-app')));

// All KV pairs at once — used for the one-time hydrate on app boot.
app.get('/api/kv', async (req, res) => {
  try {
    const conn = await db.getDb();
    const rows = await conn.collection('kv_store').find().toArray();
    const out = {};
    rows.forEach(r => { out[r._id] = r.value; });
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
    res.json({ value: row ? row.value : null });
  } catch (err) {
    console.error('GET /api/kv/:key failed', err);
    res.status(500).json({ error: 'Database unreachable' });
  }
});

// Client identifies itself via these headers (see Storage.set in qa-app/js/utils.js).
// Not real authentication (no signature/session check) — but stops a non-admin
// client from writing files it doesn't own into another workspace, or granting
// cross-workspace sharing without the share permission, even if the frontend
// UI gating is bypassed.
function readClientAuth(req){
  return {
    role: req.get('x-role') || '',
    workspace: req.get('x-workspace') || '',
    canShare: req.get('x-can-share') === '1'
  };
}

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
  const { role, workspace, canShare } = readClientAuth(req);
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

app.put('/api/kv/:key', async (req, res, next) => {
  if (req.params.key === 'qa_files') return validateFilesWrite(req, res, next);
  next();
}, async (req, res) => {
  const { key } = req.params;
  if (!ALLOWED_KEYS.has(key)) return res.status(400).json({ error: `Unknown key: ${key}` });
  try {
    const conn = await db.getDb();
    await conn.collection('kv_store').updateOne(
      { _id: key },
      { $set: { value: req.body.value } },
      { upsert: true }
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('PUT /api/kv/:key failed', err);
    res.status(500).json({ error: 'Database unreachable' });
  }
});

const VALID_FIELDS = ['module', 'roleUser', 'scenario', 'testCase', 'preconditions', 'steps', 'testData', 'expectedResult', 'typeTest'];

// ponytail: fixed-window per-IP limiter, in-memory only (resets on restart,
// not shared across instances) — fine for a single-process internal tool.
const TESTFORGE_RATE_LIMIT = 10;
const TESTFORGE_RATE_WINDOW_MS = 5 * 60 * 1000;
const testForgeHits = new Map(); // ip -> [timestamps]
function isTestForgeRateLimited(ip){
  const now = Date.now();
  const hits = (testForgeHits.get(ip) || []).filter(t => now - t < TESTFORGE_RATE_WINDOW_MS);
  hits.push(now);
  testForgeHits.set(ip, hits);
  return hits.length > TESTFORGE_RATE_LIMIT;
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

    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({ contents: [{ parts }] })
      }
    );
    if (!geminiRes.ok) {
      const errText = await geminiRes.text();
      console.error('Gemini API error', geminiRes.status, errText);
      return res.status(502).json({ error: 'AI provider error' });
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

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

module.exports = { app, sameSharedWith, isTestForgeRateLimited, buildTestForgePrompt, testForgeHits };
