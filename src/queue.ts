import { Queue } from "bullmq";
import { connection } from "./redis";

export const EMAIL_QUEUE = "emails";

export const emailQueue = new Queue(EMAIL_QUEUE, {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 5000 },
    removeOnComplete: 1000,
    removeOnFail: 1000,
  },
});

export type EmailJob = {
  emailId: number;
  sender: string;
  hourlyLimit?: number;
};
