import dotenv from "dotenv";
dotenv.config();

export const config = {
  port: Number(process.env.PORT || 4000),
  databaseUrl: process.env.DATABASE_URL || "postgres://postgres:postgres@localhost:5432/email_scheduler",
  redisUrl: process.env.REDIS_URL || "redis://localhost:6379",
  // elasticsearch is optional - if ELASTIC_URL isn't set, search is disabled
  // and the app runs fine without it (handy for free hosting without ES).
  elasticUrl: process.env.ELASTIC_URL || "",
  searchEnabled: !!process.env.ELASTIC_URL,

  // run the bullmq worker inside this process. set true when deploying as a
  // single service (one host runs api + worker); false to run it separately.
  runWorker: process.env.RUN_WORKER === "true",

  googleClientId: process.env.GOOGLE_CLIENT_ID || "",

  concurrency: Number(process.env.WORKER_CONCURRENCY || 5),
  minDelayMs: Number(process.env.MIN_DELAY_MS || 2000),
  maxPerHour: Number(process.env.MAX_EMAILS_PER_HOUR_PER_SENDER || 200),

  slack: {
    clientId: process.env.SLACK_CLIENT_ID || "",
    clientSecret: process.env.SLACK_CLIENT_SECRET || "",
    redirectUri: process.env.SLACK_REDIRECT_URI || "http://localhost:4000/slack/callback",
  },

  frontendUrl: process.env.FRONTEND_URL || "http://localhost:3000",

  // basic auth for the bull board dashboard
  adminUser: process.env.ADMIN_USER || "admin",
  adminPass: process.env.ADMIN_PASS || "admin",
};
