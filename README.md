# Email Scheduler — Backend

Schedules and sends emails at scale using BullMQ delayed jobs (no cron). Sends
through Ethereal (fake SMTP), stores everything in Postgres, indexes into
Elasticsearch, and notifies Slack when a sender hits its hourly limit.

## Stack

- Express + TypeScript
- BullMQ (Redis) for the delayed-job scheduler
- Postgres (via `pg`)
- Elasticsearch for search
- Nodemailer + Ethereal for sending
- Bull Board for live queue visibility

## Running

```bash
docker compose up -d        # postgres, redis, elasticsearch
cp .env.example .env
npm install
npm run dev                 # api + bull board on :4000
npm run worker              # the queue worker (separate process)
```

- API: `http://localhost:4000`
- Bull Board: `http://localhost:4000/admin/queues`

## API

| Method | Path | Notes |
|--------|------|-------|
| POST | `/emails/schedule` | `{ sender, subject, body, recipients[], startTime, delayMs }` |
| GET | `/emails/scheduled` | emails still queued |
| GET | `/emails/sent` | sent + failed |
| GET | `/emails/search?q=` | elasticsearch full-text |
| GET | `/slack/connect?tenant=` | starts Slack OAuth |
| GET | `/slack/status?tenant=` | connection status |

## How things work

### Scheduling (no cron)
Each recipient becomes one row in `emails` and one **BullMQ delayed job**. The
delay is `scheduledAt - now`, so BullMQ fires it at the right time. Because the
queue lives in Redis, delayed jobs survive an API/worker restart — they fire
when their time comes, not from scratch. Docker Compose mounts named volumes for
Postgres, Redis and Elasticsearch, and Redis runs with `--appendonly yes` (AOF),
so data survives `docker compose down && up`, not just a process restart.

### Idempotency
Two layers:
1. **DB-enforced** — each email row has a unique `idempotency_key` =
   `<campaignKey>:<recipient>`. The schedule insert uses
   `ON CONFLICT (idempotency_key) DO NOTHING`, so submitting the same campaign
   twice can't create duplicate rows, and we only queue a job when a row is
   actually inserted. The frontend generates one `campaignKey` per compose.
2. **Queue + worker** — the job id is deterministic (`email-<rowId>`), so BullMQ
   drops a duplicate add, and the worker checks `status === 'sent'` before
   sending.

### Worker states & retries
A job goes `scheduled → processing → sent`. On a send error the worker does
**not** immediately mark it `failed`: it only marks `failed` once BullMQ's
retries are exhausted (`attemptsMade + 1 >= attempts`), otherwise it sets the
row back to `scheduled` and rethrows so BullMQ retries with backoff.

**Honest limitation (exactly-once):** the SMTP send and the `status='sent'` DB
write are two separate operations, not one transaction. If the process dies
*after* SMTP accepts the mail but *before* the DB write, a retry would send
again. The `status === 'sent'` guard closes most of this window but cannot make
it exactly-once — SMTP + Postgres can't share a transaction. At-least-once with
a best-effort guard is the honest guarantee here.

### Auth
The `/emails/*` routes require a Google `id_token` as a `Bearer` token. The
backend verifies it against Google's `tokeninfo` endpoint, checks the audience
matches `GOOGLE_CLIENT_ID`, and scopes every query to the verified email
(`owner` column), so users only see their own emails.

### Concurrency + delay between sends
`WORKER_CONCURRENCY` controls how many jobs run in parallel. The worker's BullMQ
limiter is set to `max: 1 per MIN_DELAY_MS`, so there's at least `MIN_DELAY_MS`
(default **2s**) between individual sends to mimic provider throttling.

### Hourly rate limit
Redis counter keyed by `sender + hour-window` (`rl:<sender>:<window>`). `INCR` is
atomic so it's correct across multiple workers. When a sender goes over
`MAX_EMAILS_PER_HOUR_PER_SENDER`, the job is **not dropped** — it's re-added with
a delay until the top of the next hour, and the row stays `scheduled`.

### Slack on rate limit
When the limit is hit we POST to the sender/tenant's stored incoming webhook
(obtained via real Slack OAuth at `/slack/connect`). If Slack isn't connected we
just skip it — no crash. Connect later and it starts working with no redeploy.

### Behaviour under load
1000+ emails for the same time all get queued as delayed jobs. Concurrency +
the per-send limiter drain them steadily; the hourly counter spills the overflow
into later hours instead of blasting them out or failing.

## Note on resetting state

The DB (Postgres) and the queue (Redis) must be reset together. Job ids are
deterministic (`email-<rowId>`) for idempotency, so if you drop the DB without
flushing Redis, new rows reuse old ids and BullMQ rejects them as duplicates —
the emails never send. To start fresh:

```bash
docker compose exec redis redis-cli FLUSHALL
# then truncate the emails table, or drop the DB and let it recreate
```

## Config (.env)

| var | default | meaning |
|-----|---------|---------|
| `WORKER_CONCURRENCY` | 5 | parallel jobs |
| `MIN_DELAY_MS` | 2000 | min gap between sends |
| `MAX_EMAILS_PER_HOUR_PER_SENDER` | 200 | hourly cap per sender |
| `ADMIN_USER` / `ADMIN_PASS` | admin / admin | basic-auth login for Bull Board |

Bull Board (`/admin/queues`) is behind HTTP basic auth, and CORS is restricted to
`FRONTEND_URL`. Input on `/schedule` is validated (email format, non-negative
`delayMs`, positive integer `hourlyLimit`, valid `startTime`). The worker closes
gracefully on SIGTERM/SIGINT so an in-flight send isn't left stalled.
