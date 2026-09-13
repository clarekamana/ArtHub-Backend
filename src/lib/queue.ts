import { Queue } from "bullmq";
import IORedis from "ioredis";
import { env } from "../config/env";

export const connection = new IORedis(env.redisUrl, { maxRetriesPerRequest: null });

export const SCAN_CONVERT_QUEUE = "scan-and-convert";
export const LIFECYCLE_QUEUE = "lifecycle";

// Section 4.2 steps 5-7: scan (malware + .blend auto-run check) then convert to .glb/thumbnail
export const scanConvertQueue = new Queue(SCAN_CONVERT_QUEUE, { connection });

// Section 4.4/9.4: scheduled tiering (hot->warm->cold) and retention purges
export const lifecycleQueue = new Queue(LIFECYCLE_QUEUE, { connection });

export interface ScanConvertJobData {
  uploadId: string;
}
