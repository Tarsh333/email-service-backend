import { Worker, Job } from "bullmq";
import { connection } from "./redis";
import { config } from "./config";
import { EMAIL_QUEUE, EmailJob, emailQueue } from "./queue";
import { query, initDb } from "./db";
import { sendEmail } from "./mailer";
import { tryConsume, msUntilNextHour } from "./rateLimit";
import { notifyRateLimit } from "./slack";
import { indexEmail, initSearch } from "./search";

async function processEmail(job: Job<EmailJob>) {
  const { emailId, sender, hourlyLimit } = job.data;

  const { rows } = await query(`SELECT * FROM emails WHERE id = $1`, [emailId]);
  const email = rows[0];
  if (!email) return;

  // idempotency - if it's already sent, do nothing. this also protects against
  // a retry re-running a job whose previous attempt actually sent.
  if (email.status === "sent") return;

  // rate limit check (redis counter, shared across workers)
  const allowed = await tryConsume(sender, hourlyLimit || email.hourly_limit);
  if (!allowed) {
    // slack is keyed per sender (tenant = the from address)
    await notifyRateLimit(sender, sender);
    // push into next hour window, keep it scheduled
    await emailQueue.add("send", job.data, { delay: msUntilNextHour() });
    return;
  }

  // mark in-flight so the dashboard doesn't show it as plain scheduled
  const proc = await query(
    `UPDATE emails SET status = 'processing' WHERE id = $1 AND status <> 'sent' RETURNING *`,
    [emailId]
  );
  if (proc.rows[0]) await indexEmail(proc.rows[0]);

  try {
    const result = await sendEmail({
      sender,
      to: email.recipient,
      subject: email.subject,
      body: email.body,
    });

    // NOTE: SMTP send and this DB write are not one transaction. If the process
    // dies between them, a retry could send again. The status==='sent' guard
    // above closes most of the window; true exactly-once isn't possible here.
    const upd = await query(
      `UPDATE emails SET status = 'sent', sent_at = now(), preview_url = $2, error = NULL WHERE id = $1 RETURNING *`,
      [emailId, result.previewUrl]
    );
    await indexEmail(upd.rows[0]);
  } catch (err) {
    const lastAttempt = job.attemptsMade + 1 >= (job.opts.attempts || 1);
    const nextStatus = lastAttempt ? "failed" : "scheduled";
    const upd = await query(
      `UPDATE emails SET status = $2, error = $3 WHERE id = $1 RETURNING *`,
      [emailId, nextStatus, (err as Error).message]
    );
    if (upd.rows[0]) await indexEmail(upd.rows[0]);
    throw err; // let bullmq handle the retry/backoff
  }
}

// create the worker. callers must have already run initDb()/initSearch().
// used both standalone (npm run worker) and in-process with the api (deploy).
export function startWorker() {
  const worker = new Worker(EMAIL_QUEUE, processEmail, {
    connection,
    concurrency: config.concurrency,
    // min delay between sends -> 1 job per minDelayMs
    limiter: { max: 1, duration: config.minDelayMs },
  });

  worker.on("completed", (job) => console.log(`job ${job.id} done`));
  worker.on("failed", (job, err) => console.log(`job ${job?.id} failed: ${err.message}`));

  console.log(`worker up. concurrency=${config.concurrency} delay=${config.minDelayMs}ms`);

  // graceful shutdown - let the current job finish before exiting so we don't
  // leave a stalled job that another worker could re-run.
  const shutdown = async () => {
    console.log("shutting down worker...");
    await worker.close();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  return worker;
}

// standalone entry point - only runs when this file is executed directly
if (require.main === module) {
  (async () => {
    await initDb();
    await initSearch();
    startWorker();
  })();
}
