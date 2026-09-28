# TestForge — AI Test Case Generator

Date: 2026-09-21

## Purpose

Add button in Test Case module to auto-generate test cases via AI (Gemini free
API), from 3 possible sources: BRS text, app screenshot, or free-text prompt.
User picks which fields to generate before running, reviews/edits/deletes
generated rows in staging before committing to the real test case table.

## Scope

- New backend endpoint proxying Gemini API (keeps API key server-side).
- New frontend module `testforge.js` + modal UI wired into existing Test Case
  toolbar.
- Reuses existing testcase data model and save path — no schema change, no DB
  migration.

## Backend

`server/server.js` — add `POST /api/testforge/generate`.

Request body:
```json
{
  "mode": "brs" | "screenshot" | "text",
  "content": "string (BRS text or free-text prompt)",
  "images": ["data:image/png;base64,..."],   // screenshot mode only
  "fields": ["module","roleUser","scenario","testCase","preconditions","steps","testData","expectedResult","typeTest"],
  "module": "optional existing module name for context"
}
```

Server builds a Gemini prompt instructing: return ONLY a JSON array of test
case objects, one object per selected field, matching the given field list.
Calls `gemini-1.5-flash` (`GEMINI_API_KEY` from `.env`) via
`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent`.
Screenshot mode sends image parts (`inline_data`) alongside the text prompt —
Gemini flash supports multimodal input natively, no extra vision API needed.

Response: `{ "testcases": [ { ...only requested fields... }, ... ] }`.
Parse/validate Gemini's JSON text response; on parse failure return 502 with
raw text for debugging. No image upload middleware needed — screenshots sent
as base64 JSON strings, no `multer` dependency added.

## Frontend

New file `qa-app/js/testforge.js`, new module `TestForgeModule`. Button "✨
Generate (AI)" added next to existing "+ Add" toolbar button in
`testcase.js`.

### Modal flow

1. **Field template step** — checklist of the 9 generatable fields, all
   pre-checked, user can uncheck any.
2. **Source tabs** — BRS (textarea paste) / Screenshot (multi-file input,
   client-side reads to base64) / Free Text (textarea). One active tab at a
   time; "Generate" button sends that tab's content + checked fields to
   backend.
3. **Loading state** while awaiting response.
4. **Review tab** — switches to staging list on success. Staged rows held in
   `TestForgeModule.ui.staged` (in-memory only, NOT written to
   `App.state.testcases` yet). Each row:
   - inline-editable (reuses field inputs from existing edit form markup)
   - delete button removes it from staged array
5. **Save All to Test Case** button: for each staged row, generate ID via
   existing `IdGen.next(moduleAbbrev(tc.module))`, push into
   `App.state.testcases` with `status:'Open'`, `fileId: activeFileId`,
   `createdAt: nowISO()`, missing fields defaulted same as manual add path.
   Calls `App.saveTestcases()`, logs `ActivityLog.record('tc_ai_generate', ...)`
   once for the batch, closes modal, clears staged array.

### State

All state lives in `TestForgeModule.ui`: `{ step, mode, fields: Set,
content, images: [], staged: [], loading }`. Modal close/cancel at any step
discards staged/content — nothing persisted until explicit Save.

## Error handling

- Backend unreachable / non-200 → toast error, stay on generate step (content
  preserved, so user can retry).
- Gemini returns unparseable JSON → toast "AI response invalid, coba lagi",
  same as above.
- Empty `fields` selection → block Generate button client-side.

## Testing

Manual only (no existing test harness in this repo):
- Generate from BRS text → verify staged rows match selected fields only.
- Generate from screenshot upload → verify image sent, results appear.
- Generate from free text → verify results appear.
- Edit a staged row, delete a staged row, confirm Review list updates.
- Save All → confirm rows appear in real Test Case table with correct IDs,
  module abbreviation, status Open; confirm activity log entry created.
- Cancel modal mid-flow → confirm nothing written to `qa_testcases`.

## Out of scope

- Field-level per-source memory/presets (template is per-generate-session
  only, not saved to settings).
- Multi-provider AI selection (Gemini only for now, per current decision).
- Batch screenshot-to-multiple-test-case-files mapping.
