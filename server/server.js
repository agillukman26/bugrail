require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { getDb } = require('./db');

const ALLOWED_KEYS = new Set(['qa_testcases', 'qa_bugs', 'qa_files', 'qa_settings', 'qa_counters']);

const app = express();
app.use(cors());
app.use(express.json({ limit: '20mb' }));

// All KV pairs at once — used for the one-time hydrate on app boot.
app.get('/api/kv', async (req, res) => {
  try {
    const db = await getDb();
    const rows = await db.collection('kv_store').find().toArray();
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
    const db = await getDb();
    const row = await db.collection('kv_store').findOne({ _id: req.params.key });
    res.json({ value: row ? row.value : null });
  } catch (err) {
    console.error('GET /api/kv/:key failed', err);
    res.status(500).json({ error: 'Database unreachable' });
  }
});

app.put('/api/kv/:key', async (req, res) => {
  const { key } = req.params;
  if (!ALLOWED_KEYS.has(key)) return res.status(400).json({ error: `Unknown key: ${key}` });
  try {
    const db = await getDb();
    await db.collection('kv_store').updateOne(
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

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 3002;
app.listen(PORT, () => console.log(`BugRail storage API listening on http://localhost:${PORT}`));
