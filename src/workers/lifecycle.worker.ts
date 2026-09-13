import "dotenv/config";
import { Worker } from "bullmq";
import { prisma } from "../lib/prisma";
import { connection, lifecycleQueue, LIFECYCLE_QUEUE } from "../lib/queue";
import { env } from "../config/env";
import { copyBetweenBuckets, deleteObject } from "../lib/s3";

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const TWELVE_MONTHS_MS = 365 * 24 * 60 * 60 * 1000;

/** FR-2.5: purge soft version-history files past their 30-day retention window. */
async function purgeExpiredVersions() {
  const expired = await prisma.uploadVersion.findMany({ where: { purgeAfter: { lt: new Date() } } });
  for (const v of expired) {
    await deleteObject(env.s3.bucketPublic, v.storageKeyOriginal).catch(() => null);
    await prisma.uploadVersion.delete({ where: { id: v.id } });
  }
  return expired.length;
}

/** Section 9.4: mark accounts inactive after 12 months without login and move their files to cold storage. */
async function flagInactiveAccounts() {
  const cutoff = new Date(Date.now() - TWELVE_MONTHS_MS);
  const inactive = await prisma.user.findMany({
    where: { status: "ACTIVE", lastLoginAt: { lt: cutoff } },
  });

  for (const user of inactive) {
    const uploads = await prisma.upload.findMany({
      where: { uploaderId: user.id, uploadStatus: "PUBLISHED", storageTier: { not: "COLD" } },
    });
    for (const upload of uploads) {
      if (!upload.storageKeyOriginal) continue;
      const archiveKey = upload.storageKeyOriginal;
      await copyBetweenBuckets(env.s3.bucketPublic, upload.storageKeyOriginal, env.s3.bucketArchive, archiveKey).catch(
        () => null
      );
      await deleteObject(env.s3.bucketPublic, upload.storageKeyOriginal).catch(() => null);
      await prisma.upload.update({ where: { id: upload.id }, data: { storageTier: "COLD" } });
    }
    await prisma.user.update({ where: { id: user.id }, data: { status: "INACTIVE" } });
    // TODO(production): send the inactivity notification email required by Section 9.4.
  }
  return inactive.length;
}

/** Section 9.4: hard-purge accounts and their files 30 days after deletion request. */
async function purgeDeletedAccounts() {
  const cutoff = new Date(Date.now() - THIRTY_DAYS_MS);
  const toPurge = await prisma.user.findMany({
    where: { status: "PENDING_DELETION", deletionRequestedAt: { lt: cutoff } },
    include: { uploads: true },
  });

  for (const user of toPurge) {
    for (const upload of user.uploads) {
      if (upload.storageKeyOriginal) {
        const bucket = upload.storageTier === "COLD" ? env.s3.bucketArchive : env.s3.bucketPublic;
        await deleteObject(bucket, upload.storageKeyOriginal).catch(() => null);
      }
      if (upload.storageKeyPreviewGlb) await deleteObject(env.s3.bucketPublic, upload.storageKeyPreviewGlb).catch(() => null);
      if (upload.storageKeyThumbnail) await deleteObject(env.s3.bucketPublic, upload.storageKeyThumbnail).catch(() => null);
    }
    await prisma.upload.deleteMany({ where: { uploaderId: user.id } });
    await prisma.user.update({ where: { id: user.id }, data: { status: "DELETED" } });
  }
  return toPurge.length;
}

async function runLifecycleSweep() {
  const [versionsPurged, accountsFlaggedInactive, accountsPurged] = await Promise.all([
    purgeExpiredVersions(),
    flagInactiveAccounts(),
    purgeDeletedAccounts(),
  ]);
  console.log(
    `[lifecycle] versionsPurged=${versionsPurged} accountsFlaggedInactive=${accountsFlaggedInactive} accountsPurged=${accountsPurged}`
  );
}

const worker = new Worker(LIFECYCLE_QUEUE, runLifecycleSweep, { connection });
worker.on("failed", (job, err) => console.error("[lifecycle] sweep failed:", err));

// Schedule a daily sweep (Section 4.4: "a scheduled job periodically moves...").
async function scheduleDaily() {
  await lifecycleQueue.add(
    "daily-sweep",
    {},
    { repeat: { pattern: "0 3 * * *" }, jobId: "daily-lifecycle-sweep" } // 03:00 every day
  );
}
scheduleDaily();

console.log("ArtHub lifecycle worker running");
