import express from "express";
import cors from "cors";
import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { ExpressAdapter } from "@bull-board/express";

import { config } from "./config";
import { initDb } from "./db";
import { initSearch } from "./search";
import { emailQueue } from "./queue";
import emailRoutes from "./routes/emails";
import slackRoutes from "./routes/slack";
import { startWorker } from "./worker";
import { Request, Response, NextFunction } from "express";

function basicAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization || "";
  const [user, pass] = Buffer.from(header.split(" ")[1] || "", "base64").toString().split(":");
  if (user === config.adminUser && pass === config.adminPass) return next();
  res.set("WWW-Authenticate", 'Basic realm="bull-board"').status(401).send("auth required");
}

async function main() {
  await initDb();
  await initSearch();

  const app = express();
  app.use(cors({ origin: config.frontendUrl }));
  app.use(express.json({ limit: "5mb" }));

  // live bullmq dashboard at /admin/queues (behind basic auth)
  const serverAdapter = new ExpressAdapter();
  serverAdapter.setBasePath("/admin/queues");
  createBullBoard({
    queues: [new BullMQAdapter(emailQueue)],
    serverAdapter,
  });
  app.use("/admin/queues", basicAuth, serverAdapter.getRouter());

  app.use("/emails", emailRoutes);
  app.use("/slack", slackRoutes);

  app.get("/health", (_req, res) => res.json({ ok: true }));

  app.listen(config.port, () => {
    console.log(`api on http://localhost:${config.port}`);
    console.log(`bull board on http://localhost:${config.port}/admin/queues`);
  });

  // single-service deploy: run the worker in the same process as the api
  if (config.runWorker) {
    startWorker();
    console.log("worker running in-process (RUN_WORKER=true)");
  }
}

main();
