import { Pool, Client } from "pg";
import { config } from "./config";

export const pool = new Pool({ connectionString: config.databaseUrl });

export async function query(text: string, params?: any[]) {
  return pool.query(text, params);
}

// create the database if it doesn't exist yet (connect to the default
// "postgres" db to do it). lets a fresh checkout boot without manual setup.
async function ensureDatabase() {
  const url = new URL(config.databaseUrl);
  const dbName = url.pathname.slice(1);

  url.pathname = "/postgres";
  const admin = new Client({ connectionString: url.toString() });
  await admin.connect();
  const exists = await admin.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [dbName]);
  if (exists.rowCount === 0) {
    try {
      await admin.query(`CREATE DATABASE ${dbName}`);
    } catch (e: any) {
      // 42P04 = duplicate_database, 23505 = race on pg_database unique index.
      // either way the other process already made it.
      if (e.code !== "42P04" && e.code !== "23505") throw e;
    }
  }
  await admin.end();
}

// run on boot - creates tables if they aren't there yet
export async function initDb() {
  await ensureDatabase();

  // advisory lock on one dedicated connection so api + worker don't race the DDL
  const client = await pool.connect();
  try {
    await client.query(`SELECT pg_advisory_lock(42)`);
    await initSchema(client);
    await client.query(`SELECT pg_advisory_unlock(42)`);
  } finally {
    client.release();
  }
}

async function initSchema(db: { query: typeof pool.query }) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS emails (
      id SERIAL PRIMARY KEY,
      idempotency_key TEXT UNIQUE NOT NULL,
      owner TEXT NOT NULL,
      sender TEXT NOT NULL,
      recipient TEXT NOT NULL,
      subject TEXT NOT NULL,
      body TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'scheduled',
      hourly_limit INT,
      scheduled_at TIMESTAMPTZ NOT NULL,
      sent_at TIMESTAMPTZ,
      job_id TEXT,
      preview_url TEXT,
      error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await db.query(`CREATE INDEX IF NOT EXISTS emails_status_idx ON emails(status);`);

  await db.query(`
    CREATE TABLE IF NOT EXISTS slack_connections (
      tenant TEXT PRIMARY KEY,
      team_name TEXT,
      webhook_url TEXT NOT NULL,
      channel TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}
