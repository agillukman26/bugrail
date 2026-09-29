# BugRail Storage API

Express + MongoDB backend for the BugRail QA App (`../qa-app`).
Each data collection (test cases, bugs, files, settings, ID counters,
activity log) is stored as one document per key in the `kv_store`
collection (`_id` = key, `value` = the JSON blob) — same shape the app
keeps in `localStorage`, shared across machines/browsers via MongoDB.
Also proxies the TestForge AI generator to Google Gemini.

Requires **Node.js 18+** (uses global `fetch` and `node --test`).

## Setup (local)

1. Start MongoDB (e.g. `mongod`, a local Community install, or use a MongoDB Atlas URI).
2. Install dependencies:
   ```
   cd server
   npm install
   ```
3. Copy `.env.example` to `server/.env` (a `.env` in the repo root also works) and fill it in:
   ```
   PORT=3001
   MONGO_URI=mongodb://127.0.0.1:27017   # default if empty
   DB_NAME=bugrail                       # default if empty
   GEMINI_API_KEY=                       # optional, for TestForge (free key: https://aistudio.google.com/apikey)
   ```
4. Start the API:
   ```
   npm start
   ```
   Open **http://localhost:3001** — the server also serves the frontend (`qa-app/`),
   so don't open `index.html` from disk. Opening from disk still talks to the
   local API, never production.

No schema import needed — MongoDB creates the database/collection on first write.

## Tests

```
npm test
```
Runs `node --test` against `test/`.

## Frontend

`qa-app/js/utils.js` picks the API URL via the `API_BASE` constant:
`http://localhost:3001/api` when the app is opened from `localhost`, otherwise
the hardcoded production URL (`https://bugrail-api-production.up.railway.app/api`).
Update that constant if the API is deployed somewhere else.

The app fetches all data once on startup (`Storage.hydrate()`) and caches it
in memory. Writes update the cache + `localStorage` immediately and persist to
MongoDB in the background. If the API is unreachable, the app falls back to
`localStorage` (offline mode).

## API

- `GET /api/kv` — all key→value pairs (used for startup hydrate).
- `GET /api/kv/:key` — single value.
- `PUT /api/kv/:key` with `{ "value": ... }` — upsert. Unknown keys → `400`.
  Writes to `qa_files` are checked against the `x-role`, `x-workspace` and
  `x-can-share` headers: non-admins can't create/modify files in another
  workspace or change sharing without share permission (`403`).
- `POST /api/testforge/generate` — generate test cases with Gemini
  (`gemini-2.0-flash`). Body:
  ```json
  { "mode": "brs | screenshot | text", "content": "...", "images": ["data:image/png;base64,..."],
    "fields": ["module", "scenario", "steps", "..."], "module": "optional", "apiKey": "optional" }
  ```
  Uses `apiKey` from the body if given, else `GEMINI_API_KEY`. Max 5 images.
  Rate-limited to 10 requests per 5 minutes per IP (in-memory).

Keys: `qa_testcases`, `qa_bugs`, `qa_files`, `qa_settings`, `qa_counters`, `qa_activity_log`.

## Deploy

1. **MongoDB** — Atlas or self-hosted. On Atlas, allow the server's IP in Network Access.
2. **Backend** — any Node 18+ host (Railway, Render, VPS). Root directory `server/`,
   start command `npm start`. Set `MONGO_URI`, `DB_NAME`, `GEMINI_API_KEY` as
   environment variables on the platform (`.env` is gitignored — never commit it).
   On a VPS, run it under a process manager (e.g. `pm2 start server.js`) behind
   Nginx with HTTPS.
3. **Frontend** — host `qa-app/` as static files (Netlify, Vercel, GitHub Pages, Nginx)
   over HTTPS, and point `API_BASE` in `qa-app/js/utils.js` at the backend URL.
4. **Check** — `GET https://<backend>/api/kv` returns JSON (not `Database unreachable`),
   then log in on the frontend and create a test case to confirm it lands in MongoDB.

### Security caveats

- **No real authentication.** The `x-role`/`x-workspace` headers are client-supplied
  and trivially spoofable; anyone who knows the API URL can read and overwrite all data.
  Expose it only on an internal network, or behind a VPN / IP allowlist, until
  server-side auth (session/JWT) is added.
- **CORS is open** (`app.use(cors())` in `app.js`). Restrict it to the frontend origin
  for production: `cors({ origin: 'https://your-frontend' })`.
- User accounts and passwords live in `qa_settings` and are returned by `GET /api/kv`.
  Change the default admin password (`admin@bugrail.local` / `sama`) right after deploy.
- A Gemini key saved from the Settings page is stored in `qa_settings` too — prefer
  setting `GEMINI_API_KEY` on the server instead.
