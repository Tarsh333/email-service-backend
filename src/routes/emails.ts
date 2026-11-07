import { Router } from "express";
import { randomUUID } from "crypto";
import { query } from "../db";
import { emailQueue } from "../queue";
import { indexEmail, searchEmails } from "../search";
import { config } from "../config";
import { requireAuth, AuthedRequest } from "../auth";

const router = Router();

router.use(requireAuth);

// Schedule a batch. One row + one delayed job per recipient.
// Emails are staggered by `delayMs` starting at `startTime`.
// A campaign key + recipient makes a unique idempotency key so the same
// request submitted twice can't create duplicate rows or jobs.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

router.post("/schedule", async (req: AuthedRequest, res) => {
  const { sender, subject, body, recipients, startTime, delayMs, hourlyLimit } = req.body;
  const campaignKey = req.body.campaignKey || randomUUID();
  const owner = req.userEmail!;

  if (!sender || !subject || !Array.isArray(recipients) || !recipients.length) {
    return res.status(400).json({ error: "sender, subject and recipients are required" });
  }
  if (!EMAIL_RE.test(sender)) {
    return res.status(400).json({ error: "sender is not a valid email" });
  }
  const bad = recipients.filter((r: unknown) => typeof r !== "string" || !EMAIL_RE.test(r));
  if (bad.length) {
    return res.status(400).json({ error: `invalid recipient email(s): ${bad.slice(0, 3).join(", ")}` });
  }
  if (delayMs !== undefined && (!Number.isFinite(Number(delayMs)) || Number(delayMs) < 0)) {
    return res.status(400).json({ error: "delayMs must be a non-negative number" });
  }
  if (hourlyLimit !== undefined && (!Number.isInteger(Number(hourlyLimit)) || Number(hourlyLimit) < 1)) {
    return res.status(400).json({ error: "hourlyLimit must be a positive integer" });
  }
  if (startTime !== undefined && Number.isNaN(new Date(startTime).getTime())) {
    return res.status(400).json({ error: "startTime is not a valid date" });
  }

  const start = startTime ? new Date(startTime).getTime() : Date.now();
  const step = Number(delayMs) || config.minDelayMs;
  const now = Date.now();

  const created: any[] = [];

  for (let i = 0; i < recipients.length; i++) {
    const scheduledAt = new Date(start + i * step);
    const idemKey = `${campaignKey}:${recipients[i]}`;

    const { rows } = await query(
      `INSERT INTO emails (idempotency_key, owner, sender, recipient, subject, body, scheduled_at, hourly_limit)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING *`,
      [idemKey, owner, sender, recipients[i], subject, body, scheduledAt, hourlyLimit || null]
    );

    // conflict -> this email was already scheduled, skip it
    if (!rows.length) continue;
    const email = rows[0];

    const delay = Math.max(0, scheduledAt.getTime() - now);
    await emailQueue.add(
      "send",
      { emailId: email.id, sender, hourlyLimit: hourlyLimit || undefined },
      { delay, jobId: `email-${email.id}` }
    );

    await query(`UPDATE emails SET job_id = $2 WHERE id = $1`, [email.id, `email-${email.id}`]);
    await indexEmail(email);
    created.push(email);
  }

  res.json({ scheduled: created.length, campaignKey, emails: created });
});

router.get("/scheduled", async (req: AuthedRequest, res) => {
  const { rows } = await query(
    `SELECT * FROM emails WHERE status IN ('scheduled','processing') AND owner = $1 ORDER BY scheduled_at ASC`,
    [req.userEmail]
  );
  res.json(rows);
});

router.get("/sent", async (req: AuthedRequest, res) => {
  const { rows } = await query(
    `SELECT * FROM emails WHERE status IN ('sent','failed') AND owner = $1 ORDER BY sent_at DESC NULLS LAST`,
    [req.userEmail]
  );
  res.json(rows);
});

router.get("/search", async (req: AuthedRequest, res) => {
  const q = String(req.query.q || "");
  if (!q) return res.json([]);
  try {
    const hits = await searchEmails(q, req.userEmail!);
    res.json(hits);
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

export default router;
