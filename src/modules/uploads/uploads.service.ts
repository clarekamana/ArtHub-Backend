import { v4 as uuid } from "uuid";
import { FileCategory } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { createPresignedUploadUrl, createPresignedDownloadUrl, cdnUrl } from "../../lib/s3";
import { scanConvertQueue } from "../../lib/queue";
import { env } from "../../config/env";
import { categorizeFile, isThreeD, maxStandardSizeFor, absoluteMaxSizeFor } from "../../utils/filePolicy";
import { hasRoomFor } from "../../utils/quota";
import { ApiError } from "../../middleware/errorHandler";

export interface InitiateUploadInput {
  userId: string;
  title: string;
  description?: string;
  filename: string;
  mimeType: string;
  fileSizeBytes: number;
  sizeExceptionApprovalId?: string;
}

/**
 * Section 4.2 steps 1-2: validate against limits, then hand back a presigned
 * PUT URL so the browser uploads straight to the private quarantine bucket.
 */
export async function initiateUpload(input: InitiateUploadInput) {
  const category = categorizeFile(input.filename);
  if (!category) throw new ApiError(400, "Unsupported file type");

  const fileSizeBytes = BigInt(input.fileSizeBytes);
  let sizeCap = maxStandardSizeFor(category);
  let exceptionApproval = null;

  if (input.fileSizeBytes > sizeCap) {
    if (!isThreeD(category)) {
      throw new ApiError(413, `File exceeds the ${Math.round(sizeCap / 1024 / 1024)}MB cap for this category`);
    }
    if (!input.sizeExceptionApprovalId) {
      throw new ApiError(
        413,
        `File exceeds the ${Math.round(sizeCap / 1024 / 1024)}MB standard cap. An admin-approved exception is required for files up to 2GB.`
      );
    }
    exceptionApproval = await prisma.sizeExceptionApproval.findUnique({ where: { id: input.sizeExceptionApprovalId } });
    if (
      !exceptionApproval ||
      exceptionApproval.userId !== input.userId ||
      exceptionApproval.usedByUploadId ||
      (exceptionApproval.expiresAt && exceptionApproval.expiresAt < new Date())
    ) {
      throw new ApiError(403, "Invalid or already-used size exception approval");
    }
    sizeCap = Number(exceptionApproval.maxBytes);
    if (input.fileSizeBytes > sizeCap || input.fileSizeBytes > absoluteMaxSizeFor(category)) {
      throw new ApiError(413, "File exceeds the approved exception size");
    }
  }

  const user = await prisma.user.findUniqueOrThrow({ where: { id: input.userId } });
  if (!hasRoomFor(user.storageUsedBytes, user.tier, fileSizeBytes)) {
    throw new ApiError(
      413,
      "This upload would exceed your storage quota. Free space or request a Verified Artist tier increase."
    );
  }

  const uploadId = uuid();
  const storageKey = `quarantine/${input.userId}/${uploadId}/${input.filename}`;

  const upload = await prisma.upload.create({
    data: {
      id: uploadId,
      uploaderId: input.userId,
      title: input.title,
      description: input.description,
      category,
      originalFilename: input.filename,
      mimeType: input.mimeType,
      fileSizeBytes,
      storageKeyOriginal: storageKey,
      uploadStatus: "AWAITING_UPLOAD",
      conversionStatus: isThreeD(category) ? "PENDING" : "NOT_APPLICABLE",
    },
  });

  if (exceptionApproval) {
    await prisma.sizeExceptionApproval.update({
      where: { id: exceptionApproval.id },
      data: { usedByUploadId: upload.id },
    });
  }

  const presigned = await createPresignedUploadUrl(storageKey, input.mimeType);

  return { upload, presignedUpload: presigned };
}

/**
 * Section 4.2 steps 4-5: client confirms the bytes landed in quarantine storage;
 * this marks the record and enqueues the sandboxed scan/convert worker.
 */
export async function confirmUpload(uploadId: string, userId: string) {
  const upload = await prisma.upload.findUnique({ where: { id: uploadId } });
  if (!upload || upload.uploaderId !== userId) throw new ApiError(404, "Upload not found");
  if (upload.uploadStatus !== "AWAITING_UPLOAD") throw new ApiError(409, "Upload already confirmed");

  const updated = await prisma.upload.update({
    where: { id: uploadId },
    data: { uploadStatus: "QUARANTINED" },
  });

  await scanConvertQueue.add("scan-and-convert", { uploadId }, { attempts: 2 });

  return updated;
}

export async function publishUpload(
  uploadId: string,
  userId: string,
  data: { licenseType: string; tags: string[]; category?: FileCategory }
) {
  const upload = await prisma.upload.findUnique({ where: { id: uploadId } });
  if (!upload || upload.uploaderId !== userId) throw new ApiError(404, "Upload not found");
  if (upload.uploadStatus !== "PUBLISHED" && upload.uploadStatus !== "QUARANTINED" && upload.uploadStatus !== "SCANNING") {
    throw new ApiError(409, `Upload cannot be published from status ${upload.uploadStatus}`);
  }

  // FR-2.4: title/tags/category/license required before an upload is publicly visible
  const tagRecords = await Promise.all(
    data.tags.map((name) =>
      prisma.tag.upsert({ where: { name }, create: { name }, update: {} })
    )
  );

  const result = await prisma.upload.update({
    where: { id: uploadId },
    data: {
      licenseType: data.licenseType as any,
      tags: {
        deleteMany: {},
        create: tagRecords.map((t) => ({ tagId: t.id })),
      },
    },
    include: { tags: { include: { tag: true } } },
  });

  return result;
}

export function toUploadDto(upload: {
  id: string;
  title: string;
  description: string | null;
  category: string;
  licenseType: string | null;
  uploadStatus: string;
  conversionStatus: string;
  conversionError: string | null;
  fileSizeBytes: bigint;
  storageKeyThumbnail: string | null;
  storageKeyPreviewGlb: string | null;
  viewCount: number;
  likeCount: number;
  createdAt: Date;
  publishedAt: Date | null;
}) {
  return {
    id: upload.id,
    title: upload.title,
    description: upload.description,
    category: upload.category,
    licenseType: upload.licenseType,
    uploadStatus: upload.uploadStatus,
    conversionStatus: upload.conversionStatus,
    conversionError: upload.conversionError,
    fileSizeBytes: upload.fileSizeBytes.toString(),
    thumbnailUrl: upload.storageKeyThumbnail ? cdnUrl(upload.storageKeyThumbnail) : null,
    previewGlbUrl: upload.storageKeyPreviewGlb ? cdnUrl(upload.storageKeyPreviewGlb) : null,
    viewCount: upload.viewCount,
    likeCount: upload.likeCount,
    createdAt: upload.createdAt,
    publishedAt: upload.publishedAt,
  };
}

/** Section 4.2 step 8: original file served via on-demand presigned URL, not the CDN. */
export async function getDownloadUrl(uploadId: string) {
  const upload = await prisma.upload.findUniqueOrThrow({ where: { id: uploadId } });
  if (upload.uploadStatus !== "PUBLISHED") throw new ApiError(403, "File is not available for download");
  if (!upload.storageKeyOriginal) throw new ApiError(404, "Original file missing");

  const bucket = upload.storageTier === "COLD" ? env.s3.bucketArchive : env.s3.bucketPublic;
  return createPresignedDownloadUrl(bucket, upload.storageKeyOriginal);
}
