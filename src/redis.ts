import IORedis from "ioredis";
import { config } from "./config";

// bullmq needs maxRetriesPerRequest null
export const connection = new IORedis(config.redisUrl, {
  maxRetriesPerRequest: null,
});
