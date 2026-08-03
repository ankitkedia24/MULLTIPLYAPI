# Mulltiply Item Sync — Amit Book Depot

Integration service that pushes Amit Book Depot's item master (books) from the
**AMITCLOUD ERP** (erp.amitbook.com, Supabase) to **Mulltiply AI's Item Sync API**
(`PUT https://api.mulltiply.com/v2/items/sync-data`), so customers can order on
WhatsApp from a live catalogue with current prices and stock.

```
AMITCLOUD ERP (Supabase, read-only)
        │  books: name, publisher, category, MRP, live stock…
        ▼
  THIS SERVICE  ──  transform → validate → batch → retry/backoff
        │  item → SKU → selling-unit JSON (Mulltiply spec)
        ▼
Mulltiply API  PUT /v2/items/sync-data   (x-api-key)
```

Spec: `docs/Item Sync API document.docx` · https://docs.mulltiply.ai/item/

## For Mulltiply's team — contract summary

- We call `PUT {base}/v2/items/sync-data` with header `x-api-key` and a JSON
  **array** of items, in batches of ≤300 (configurable).
- One book = one item with exactly **one SKU** (books have no size/colour
  variants) and **one base selling unit** (`PCS`, multiplier 1).
- `syncId` (item and SKU) = the book's ISBN / internal item code — stable and
  globally unique. `barCode` is set only when the code is a real ISBN-10/13.
- Books are GST-exempt: `gst: 0`, `hsnCode: "4901"`. Variant pairs are
  `Binding` (PB/HB) and `Language` — both relabelable via env if your platform
  expects different labels.
- `availableQuantity` = live closing stock from the ERP (negative → 0).
- We honor `Retry-After`, back off exponentially on 429/5xx, and parse the
  documented partial-failure envelope (`data.errors[]`) into per-ISBN reports.

**Open questions for Mulltiply** (please confirm):
1. API key delivery + rate limits / preferred max batch size.
2. Is `gst: 0` accepted for GST-exempt goods?
3. Do the variant labels `Binding` / `Language` render correctly for buyers?
4. How do we retire/delist an item (the API has no delete)? We can re-sync with
   `availableQuantity: 0` if that's the convention.
5. In partial-failure responses, is `errors[].row` 0-based or 1-based?

## Quick start (local, no Mulltiply key needed)

```bash
npm install
cp .env.example .env     # fill in SUPABASE_SERVICE_ROLE_KEY + ADMIN_API_KEY
npm run mock             # terminal 1 — local mock of Mulltiply's API :4010
npm run preview          # terminal 2 — dry-run 5 books, nothing sent
npm run sync:full        # full sync of all books → mock
npm test                 # 32 unit/integration/e2e tests
```

`.env` defaults point `MULLTIPLY_BASE_URL` at the mock (`http://localhost:4010`,
key `test-key`). Inspect what the mock received: `GET http://localhost:4010/debug/items`.

## CLI

```bash
npx tsx src/cli.ts --full [--dry-run] [--limit N]
npx tsx src/cli.ts --incremental [--since 2026-08-01T00:00:00Z]
npx tsx src/cli.ts --isbn 9781234567890 [--dry-run]
```

- **full** — every book matching `SYNC_BOOK_FILTER` (default: all active books).
- **incremental** — only books whose `updated_at` moved since the last
  successful sync (stock movements bump `updated_at`, so stock changes are
  caught). 60s overlap protects against clock skew.
- **dry-run** — transform + validate only; nothing is sent.

## Admin API server

`npm run dev` (or `npm start` after `npm run build`) — Fastify on `PORT`.
All routes except `/health` require header `x-admin-key: <ADMIN_API_KEY>`.

| Route | Purpose |
|---|---|
| `GET /health` | liveness + last run summary (no auth) |
| `POST /sync` | body `{"mode":"full"\|"incremental","dryRun":false,"limit":100}` → `202 {runId}`; `409` if a run is in progress |
| `GET /preview?limit=5` or `?isbn=…` | the exact payload that would be sent, plus validation findings — use this to demo the feed to Mulltiply |
| `GET /status` | in-flight progress, watermark state, latest run report (incl. per-row errors) |

Run reports are also written to `data/runs/run-<timestamp>.json`.

## Scheduler

Set `SYNC_SCHEDULE_ENABLED=true` to run, inside the server process:
- a **full** sync nightly at `SYNC_FULL_HOUR` (default 02:00 server time), and
- an **incremental** sync every `SYNC_INCR_MINUTES` (default 30) for fresh stock.

Overlapping runs are skipped, never queued.

## Go-live checklist (when the Mulltiply key arrives)

1. In `.env`: `MULLTIPLY_BASE_URL=https://api.mulltiply.com`, `MULLTIPLY_API_KEY=<real key>`.
2. Smoke one book: `npx tsx src/cli.ts --isbn 0002720671 --dry-run`, then without `--dry-run`.
3. Verify the book appears correctly in Mulltiply's panel (name, price, stock).
4. Change that book's rate in the ERP, re-run the same command, confirm the
   update lands (proves create-or-update).
5. Trial batch: `npx tsx src/cli.ts --full --limit 50`.
6. Full sync: `npm run sync:full` (~38.5k books, 129 batches, ~2 min).
7. Enable the scheduler (`SYNC_SCHEDULE_ENABLED=true`) and restart the server.

## Hostinger deployment (owner steps)

1. Push this repo to GitHub (already wired: `ankitkedia24/MULLTIPLYAPI`).
2. hPanel → Node.js app: repo = this project, build = `npm install && npm run build`,
   entry file = `dist/server.js`, Node ≥22.
3. Set every `.env` variable in the panel's environment section (never commit `.env`).
4. Point a subdomain (e.g. `mulltiply.amitbook.com`) at the app.
5. Passenger may idle the process, which pauses the in-process scheduler — add an
   hPanel cron as backup, e.g. hourly:
   `curl -s -X POST https://<your-domain>/sync -H "x-admin-key: $ADMIN_API_KEY" -H "Content-Type: application/json" -d '{"mode":"incremental"}'`

## Data-quality notes (owner)

From the 03-08-2026 full rehearsal (38,515 active books, 74s, all batches accepted):

- **2 books skipped — no sale rate** (fix in ERP): `9788169826761`, `9789372180107`.
- **29,943 books have no category/subject** → they land in the fallback category
  `BOOKS`; all books currently fall back to sub-category `GENERAL`. Filling
  `category`/`sub_category` in the ERP directly improves Mulltiply's storefront navigation.
- **No cover images yet** — the moment `cover_image_url` is filled in the ERP,
  images flow automatically on the next sync.
- **210 books had negative stock**, clamped to 0.
- One ISBN had a leading backtick (Excel artifact) — sanitized automatically.

## Project layout

```
src/config.ts      env → typed config (zod, fail-fast)
src/supabase.ts    paged read-only fetch from books (PostgREST, 1000/page)
src/transform.ts   pure book → Mulltiply item mapping (unit-tested)
src/validate.ts    pre-flight checks mirroring Mulltiply's checklist
src/mulltiply-client.ts  batched PUT with retry/backoff/partial-failure parsing
src/sync.ts        orchestrator: fetch → transform → validate → push → report
src/state.ts       data/state.json watermark (atomic writes)
src/report.ts      data/runs/*.json + console summaries
src/scheduler.ts   nightly full + periodic incremental
src/server.ts      Fastify admin API
src/cli.ts         one-shot runs
mock/mulltiply-mock.ts   local stand-in for Mulltiply's endpoint (+ /debug/items)
test/              vitest: transform, validate, client, end-to-end vs mock
```
