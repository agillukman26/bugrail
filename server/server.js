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

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`BugRail storage API listening on http://localhost:${PORT}`));
