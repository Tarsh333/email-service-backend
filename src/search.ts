import { Client } from "@elastic/elasticsearch";
import { config } from "./config";

// only build a client when ES is configured; otherwise search is a no-op
export const es = config.searchEnabled ? new Client({ node: config.elasticUrl }) : null;

const INDEX = "emails";

export async function initSearch() {
  if (!es) {
    console.log("elasticsearch not configured - search disabled");
    return;
  }
  try {
    const exists = await es.indices.exists({ index: INDEX });
    if (!exists) {
      await es.indices.create({
        index: INDEX,
        mappings: {
          properties: {
            owner: { type: "keyword" },
            sender: { type: "keyword" },
            recipient: { type: "keyword" },
            subject: { type: "text" },
            body: { type: "text" },
            status: { type: "keyword" },
            scheduled_at: { type: "date" },
            sent_at: { type: "date" },
          },
        },
      });
    }
  } catch (e) {
    console.error("elastic init failed (search will be degraded):", (e as Error).message);
  }
}

export async function indexEmail(email: any) {
  if (!es) return;
  try {
    await es.index({
      index: INDEX,
      id: String(email.id),
      document: {
        owner: email.owner,
        sender: email.sender,
        recipient: email.recipient,
        subject: email.subject,
        body: email.body,
        status: email.status,
        scheduled_at: email.scheduled_at,
        sent_at: email.sent_at,
      },
    });
  } catch (e) {
    console.error("index failed for", email.id, (e as Error).message);
  }
}

export async function searchEmails(q: string, owner: string) {
  if (!es) return []; // search disabled -> no results, no crash
  const res = await es.search({
    index: INDEX,
    query: {
      bool: {
        must: {
          multi_match: {
            query: q,
            fields: ["subject", "body", "recipient", "sender"],
          },
        },
        filter: { term: { owner } },
      },
    },
  });
  return res.hits.hits.map((h) => ({ id: h._id, ...(h._source as object) }));
}
