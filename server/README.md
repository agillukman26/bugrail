# BugRail Storage API

MongoDB-backed replacement for the app's old `localStorage` persistence.
Each data collection (test cases, bugs, files, settings, ID counters) is
stored as one document per key in the `kv_store` collection (`_id` = key,
`value` = the JSON blob) — same shape the app already used in
`localStorage`, now shared across machines/browsers via MongoDB instead of
living in one browser only.

## Setup (local MongoDB)

1. Start MongoDB (e.g. `mongod`, or a local MongoDB Compass/Community install).
2. Install dependencies:
   ```
   cd server
   npm install
   ```
3. Copy `.env.example` to `.env` and adjust `MONGO_URI`/`DB_NAME` if needed.
   For the TestForge AI feature, also set `GEMINI_API_KEY` (free key at
   https://aistudio.google.com/apikey).
4. Start the API:
   ```
   npm start
   ```
   Listens on `http://localhost:3001` by default.

No schema import needed — MongoDB creates the database/collection on first write.

## Frontend

`qa-app/js/utils.js` points `Storage` at this API (`API_BASE` constant near
the top of the file). Update that URL if the API runs on a different
host/port. The app now fetches all data once on startup (`Storage.hydrate()`,
wired in `auth.js`) and caches it in memory — reads stay synchronous from
that cache, writes update the cache immediately and persist to MongoDB in
the background.

## API

- `GET /api/kv` — all key→value pairs (used for startup hydrate).
- `GET /api/kv/:key` — single value.
- `PUT /api/kv/:key` with `{ "value": ... }` — upsert.

Keys: `qa_testcases`, `qa_bugs`, `qa_files`, `qa_settings`, `qa_counters`.
