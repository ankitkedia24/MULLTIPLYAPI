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

**UAT verified 07-08-2026** (base `https://api.mulltiply.app`): full catalogue
38,515 items / 129 batches accepted, zero row errors; update-without-duplicate
proven; `gst: 0` accepted; `Binding`/`Language` variant labels render; no rate
limiting at 300 items/batch with 500 ms spacing.

**Facts confirmed by Mulltiply's team:**
1. **Ingestion is asynchronous** — the API 200 means *queued*; per-batch
   progress appears in the seller panel under Items → Custom Item Logs
   (`/main/items/custom-item-logs`), one `sync_data_<timestamp>` entry per PUT.
2. Row-level errors are reported with the item index and also appear in those
   logs after processing.
3. **Delisting is manual** in the Mulltiply panel (single item or bulk via
   Excel) — not via this API.
4. Production workspace being created; production API key to follow.
   **Still to confirm at go-live: the production base URL** (docs say
   `api.mulltiply.com`, UAT is `api.mulltiply.app`).

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

## Hostinger deployment (24×7)

**LIVE since 03-08-2026 at https://mulltiply.amitbook.com** (hPanel Web App
"mulltiply.amitbook.com", auto-deployment ON, keep-alive cron on the
dl.atlasconnect.in site: `*/5 * * * * curl -s -o /dev/null
https://mulltiply.amitbook.com/health` — the Web App product has no cron menu
of its own, so the ping lives on that classic site).

Every push to `main` runs `.github/workflows/deploy.yml`: typecheck → tests →
build → force-push a ready-to-run **`deploy` branch** (compiled `dist/` +
production `node_modules` + minimal `package.json`). Hostinger's Git
integration auto-deploys that branch with **no build step** (entry
`dist/server.js`, Fastify preset, Node 22).

One-time hPanel setup:

1. **Subdomain** — hPanel → Domains → Subdomains: create
   `mulltiply.amitbook.com` (or similar) and issue SSL.
2. **Node.js app** — create the app on that subdomain:
   repo `ankitkedia24/MULLTIPLYAPI`, branch **`deploy`**, build command
   **(none)**, start command `npm start`, Node 22. Connect the GitHub account
   if the repo is private.
3. **Host `.env`** — create it in the app directory (File Manager or SSH):

   ```
   SUPABASE_URL=https://vlfogshdsrkqdeqaguqr.supabase.co
   SUPABASE_SERVICE_ROLE_KEY=<service role key>
   ADMIN_API_KEY=<fresh random, e.g. openssl rand -hex 24>
   MULLTIPLY_BASE_URL=https://api.mulltiply.com
   MULLTIPLY_API_KEY=            # blank until Mulltiply sends the key
   SYNC_SCHEDULE_ENABLED=false   # flip to true at go-live
   TZ=Asia/Kolkata               # host is UTC; makes SYNC_FULL_HOUR mean IST
   DATA_DIR=/home/<hosting-user>/mulltiply-data   # OUTSIDE the app dir,
                                                  # survives redeploys
   ```

   Do **not** set `PORT` — the panel assigns it and the panel's value wins.
4. **Deploy** — hPanel → Deployments → Deploy, then restart the app.
   Optional: paste the panel's deployment webhook URL into GitHub
   (repo → Settings → Webhooks) so every push goes live automatically.
5. **Cron jobs** (hPanel → Advanced → Cron Jobs) — required for 24×7, because
   Passenger idles quiet Node apps, which would pause the internal scheduler:
   - keep-alive, every 10 min:
     `curl -s https://mulltiply.amitbook.com/health > /dev/null`
   - optional backstop once live, hourly:
     `curl -s -X POST https://mulltiply.amitbook.com/sync -H "x-admin-key: <ADMIN_API_KEY>" -H "Content-Type: application/json" -d '{"mode":"incremental"}'`
6. **Verify** — `curl https://mulltiply.amitbook.com/health` → `{"ok":true,…}`;
   then a dry run:
   `curl -X POST https://mulltiply.amitbook.com/sync -H "x-admin-key: …" -H "Content-Type: application/json" -d '{"mode":"full","dryRun":true,"limit":5}'`
   and check `GET /status`.
7. **Go-live** (when Mulltiply's key arrives) — fill `MULLTIPLY_API_KEY`, set
   `SYNC_SCHEDULE_ENABLED=true`, restart the app, then follow the go-live
   checklist above.

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
