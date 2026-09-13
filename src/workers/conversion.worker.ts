import "dotenv/config";
import { Worker, Job } from "bullmq";
import { prisma } from "../lib/prisma";
import { connection, SCAN_CONVERT_QUEUE, ScanConvertJobData } from "../lib/queue";
import { env } from "../config/env";
import { copyBetweenBuckets, putObject, deleteObject } from "../lib/s3";
import { scanObject } from "./scanner";
import { convertToGlbAndThumbnail } from "./converter";
import { getExtension, isThreeD } from "../utils/filePolicy";

/**
 * Section 4.2 steps 4-7 end to end:
 *  4. file already landed in quarantine (done by the client + /confirm route)
 *  5. malware/script scan
 *  6. best-effort .glb + thumbnail generation for 3D files, inside a sandboxed worker
 *  7. promote original (+ derivatives if any) into the public bucket, update DB pointers
 *
 * Conversion failures never block publishing the original file (Section 3.3 / 4.2 step 6):
 * conversionStatus becomes FAILED and the item still ships with a placeholder icon.
 */
async function processJob(job: Job<ScanConvertJobData>) {
  const { uploadId } = job.data;
  const upload = await prisma.upload.findUniqueOrThrow({ where: { id: uploadId } });

  if (!upload.storageKeyOriginal) throw new Error(`Upload ${uploadId} has no storage key`);

  await prisma.upload.update({ where: { id: uploadId }, data: { uploadStatus: "SCANNING" } });

  const scan = await scanObject(env.s3.bucketQuarantine, upload.storageKeyOriginal, upload.mimeType);
  if (!scan.clean) {
    await prisma.upload.update({
      where: { id: uploadId },
      data: { uploadStatus: "SCAN_FAILED", conversionStatus: "FAILED", conversionError: scan.reason ?? "Failed security scan" },
    });
    // Malicious/failed-scan files are never promoted; leave them in quarantine for audit, don't serve them.
    return;
  }

  const publicKeyOriginal = `originals/${upload.uploaderId}/${upload.id}/${upload.originalFilename}`;
  let publicKeyGlb: string | null = null;
  let publicKeyThumb: string | null = null;
  let conversionStatus: "SUCCESS" | "FAILED" | "NOT_APPLICABLE" = "NOT_APPLICABLE";
  let conversionError: string | null = null;
  let blenderVersion: string | null = null;

  if (isThreeD(upload.category)) {
    const ext = getExtension(upload.originalFilename);
    const result = await convertToGlbAndThumbnail(upload.storageKeyOriginal, ext);
    if (result.success && result.glbBuffer && result.thumbnailBuffer) {
      publicKeyGlb = `derivatives/${upload.uploaderId}/${upload.id}/model.glb`;
      publicKeyThumb = `derivatives/${upload.uploaderId}/${upload.id}/thumbnail.png`;
      await putObject(env.s3.bucketPublic, publicKeyGlb, result.glbBuffer, "model/gltf-binary");
      await putObject(env.s3.bucketPublic, publicKeyThumb, result.thumbnailBuffer, "image/png");
      conversionStatus = "SUCCESS";
      blenderVersion = result.blenderVersion ?? null;
    } else {
      // FR-3.3: conversion failed - keep the original, no live preview, generic placeholder shown by the client
      conversionStatus = "FAILED";
      conversionError = result.error ?? "Conversion failed";
    }
  }

  // Step 7: promote the original from quarantine to the public-serving bucket
  await copyBetweenBuckets(env.s3.bucketQuarantine, upload.storageKeyOriginal, env.s3.bucketPublic, publicKeyOriginal);
  await deleteObject(env.s3.bucketQuarantine, upload.storageKeyOriginal);

  await prisma.$transaction([
    prisma.upload.update({
      where: { id: uploadId },
      data: {
        storageKeyOriginal: publicKeyOriginal,
        storageKeyPreviewGlb: publicKeyGlb,
        storageKeyThumbnail: publicKeyThumb,
        conversionStatus,
        conversionError,
        blenderVersion,
        uploadStatus: "PUBLISHED",
        publishedAt: new Date(),
        storageTier: "HOT",
      },
    }),
    prisma.user.update({
      where: { id: upload.uploaderId },
      data: { storageUsedBytes: { increment: upload.fileSizeBytes } },
    }),
  ]);
}

const worker = new Worker<ScanConvertJobData>(SCAN_CONVERT_QUEUE, processJob, { connection, concurrency: 2 });

worker.on("completed", (job) => console.log(`[conversion-worker] completed upload ${job.data.uploadId}`));
worker.on("failed", (job, err) => console.error(`[conversion-worker] failed upload ${job?.data.uploadId}:`, err));

console.log("ArtHub conversion worker running");
