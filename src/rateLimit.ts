import { connection } from "./redis";
import { config } from "./config";

// Redis-backed hourly counter per sender. Safe across workers because
// INCR is atomic. Key rolls over every hour window.
function hourKey(sender: string, date = new Date()) {
  const window = `${date.getUTCFullYear()}-${date.getUTCMonth()}-${date.getUTCDate()}-${date.getUTCHours()}`;
  return `rl:${sender}:${window}`;
}

// Try to consume one slot for this hour. Returns true if allowed.
// `limit` comes from the request; falls back to the env default.
export async function tryConsume(sender: string, limit?: number): Promise<boolean> {
  const max = limit && limit > 0 ? limit : config.maxPerHour;
  const key = hourKey(sender);
  const count = await connection.incr(key);
  if (count === 1) {
    // first hit this window, expire a bit after the hour
    await connection.expire(key, 3700);
  }
  if (count > max) {
    // give the slot back so we don't leak the count
    await connection.decr(key);
    return false;
  }
  return true;
}

// ms until the top of the next hour, used to reschedule rejected jobs.
export function msUntilNextHour(): number {
  const now = new Date();
  const next = new Date(now);
  next.setUTCMinutes(0, 0, 0);
  next.setUTCHours(now.getUTCHours() + 1);
  return next.getTime() - now.getTime();
}
