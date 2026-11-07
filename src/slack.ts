import { config } from "./config";
import { query } from "./db";

// Exchange the oauth code for an incoming webhook and save it per tenant.
export async function handleSlackCallback(code: string, tenant: string) {
  const params = new URLSearchParams({
    code,
    client_id: config.slack.clientId,
    client_secret: config.slack.clientSecret,
    redirect_uri: config.slack.redirectUri,
  });

  const res = await fetch("https://slack.com/api/oauth.v2.access", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  const data: any = await res.json();

  if (!data.ok) {
    throw new Error(data.error || "slack oauth failed");
  }

  const webhook = data.incoming_webhook;
  await query(
    `INSERT INTO slack_connections (tenant, team_name, webhook_url, channel)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (tenant) DO UPDATE SET webhook_url = $3, channel = $4, team_name = $2`,
    [tenant, data.team?.name || null, webhook.url, webhook.channel || null]
  );

  return { team: data.team?.name, channel: webhook.channel };
}

export function slackAuthorizeUrl(tenant: string) {
  const params = new URLSearchParams({
    client_id: config.slack.clientId,
    scope: "incoming-webhook",
    redirect_uri: config.slack.redirectUri,
    state: tenant,
  });
  return `https://slack.com/oauth/v2/authorize?${params.toString()}`;
}

export async function notifyRateLimit(tenant: string, sender: string) {
  const { rows } = await query(`SELECT webhook_url FROM slack_connections WHERE tenant = $1`, [tenant]);
  if (!rows.length) return; // not connected, just skip

  const url = rows[0].webhook_url;
  console.log(`rate limit hit - notifying slack for ${sender}`);
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: `⚠️ Hourly rate limit reached for sender *${sender}*. Remaining emails pushed to the next hour window.`,
      }),
    });
  } catch (e) {
    console.error("slack notify failed:", (e as Error).message);
  }
}
