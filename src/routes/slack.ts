import { Router } from "express";
import { slackAuthorizeUrl, handleSlackCallback } from "../slack";
import { query } from "../db";
import { config } from "../config";

const router = Router();

// start oauth - frontend hits this / or redirects here
router.get("/connect", (req, res) => {
  const tenant = String(req.query.tenant || "default");
  res.redirect(slackAuthorizeUrl(tenant));
});

router.get("/callback", async (req, res) => {
  const code = String(req.query.code || "");
  const tenant = String(req.query.state || "default");
  try {
    const r = await handleSlackCallback(code, tenant);
    console.log(`slack connected for ${tenant}:`, r);
    res.redirect(`${config.frontendUrl}?slack=connected`);
  } catch (e) {
    console.error(`slack connect failed for ${tenant}:`, (e as Error).message);
    res.redirect(`${config.frontendUrl}?slack=error`);
  }
});

router.get("/status", async (req, res) => {
  const tenant = String(req.query.tenant || "default");
  const { rows } = await query(`SELECT team_name, channel FROM slack_connections WHERE tenant = $1`, [tenant]);
  res.json({ connected: rows.length > 0, ...(rows[0] || {}) });
});

export default router;
