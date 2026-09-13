import { Router } from "express";
import { z } from "zod";
import { LicenseType } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { asyncHandler, ApiError } from "../../middleware/errorHandler";
import { requireAuth, optionalAuth } from "../../middleware/auth";
import {
  initiateUpload,
  confirmUpload,
  publishUpload,
  toUploadDto,
  getDownloadUrl,
} from "./uploads.service";

export const uploadsRouter = Router();

const initiateSchema = z.object({
  title: z.string().min(1).max(120),
  description: z.string().max(2000).optional(),
  filename: z.string().min(1),
  mimeType: z.string().min(1),
  fileSizeBytes: z.number().int().positive(),
  sizeExceptionApprovalId: z.string().uuid().optional(),
});

// FR-2.2: chunked/resumable upload for anything >20MB is handled client-side against
// the presigned URL directly with S3 multipart; this endpoint issues that URL.
uploadsRouter.post(
  "/initiate",
  requireAuth,
  asyncHandler(async (req, res) => {
    const input = initiateSchema.parse(req.body);
    const { upload, presignedUpload } = await initiateUpload({ ...input, userId: req.auth!.userId });
    res.status(201).json({
      uploadId: upload.id,
      uploadUrl: presignedUpload.url,
      expiresIn: presignedUpload.expiresIn,
    });
  })
);

uploadsRouter.post(
  "/:id/confirm",
  requireAuth,
  asyncHandler(async (req, res) => {
    const upload = await confirmUpload(req.params.id, req.auth!.userId);
    res.json(toUploadDto(upload));
  })
);

const publishSchema = z.object({
  licenseType: z.nativeEnum(LicenseType),
  tags: z.array(z.string().min(1).max(30)).max(20).default([]),
});

// FR-2.4: title/tags/category/license required before an upload is published
uploadsRouter.post(
  "/:id/publish",
  requireAuth,
  asyncHandler(async (req, res) => {
    const body = publishSchema.parse(req.body);
    const upload = await publishUpload(req.params.id, req.auth!.userId, body);
    res.json(toUploadDto(upload as any));
  })
);

uploadsRouter.get(
  "/:id",
  optionalAuth,
  asyncHandler(async (req, res) => {
    const upload = await prisma.upload.findUnique({
      where: { id: req.params.id },
      include: { tags: { include: { tag: true } }, uploader: { select: { id: true, displayName: true } } },
    });
    if (!upload || upload.deletedAt) throw new ApiError(404, "Upload not found");

    const isOwner = req.auth?.userId === upload.uploaderId;
    if (upload.uploadStatus !== "PUBLISHED" && !isOwner) throw new ApiError(404, "Upload not found");

    if (upload.uploadStatus === "PUBLISHED" && !isOwner) {
      await prisma.upload.update({ where: { id: upload.id }, data: { viewCount: { increment: 1 } } });
    }

    res.json({
      ...toUploadDto(upload),
      tags: upload.tags.map((t) => t.tag.name),
      uploader: upload.uploader,
      // FR-3.2: original stays listed/downloadable even if conversion failed
      canDownload: upload.uploadStatus === "PUBLISHED",
    });
  })
);

// FR-3.2 / FR-7.2: gated by license terms, presigned + time-limited
uploadsRouter.get(
  "/:id/download-url",
  optionalAuth,
  asyncHandler(async (req, res) => {
    const url = await getDownloadUrl(req.params.id);
    res.json({ url });
  })
);

uploadsRouter.delete(
  "/:id",
  requireAuth,
  asyncHandler(async (req, res) => {
    const upload = await prisma.upload.findUnique({ where: { id: req.params.id } });
    if (!upload || upload.uploaderId !== req.auth!.userId) throw new ApiError(404, "Upload not found");
    await prisma.upload.update({ where: { id: req.params.id }, data: { deletedAt: new Date(), uploadStatus: "DELETED" } });
    res.status(204).send();
  })
);

uploadsRouter.get(
  "/user/:userId",
  optionalAuth,
  asyncHandler(async (req, res) => {
    const isOwner = req.auth?.userId === req.params.userId;
    const uploads = await prisma.upload.findMany({
      where: {
        uploaderId: req.params.userId,
        deletedAt: null,
        ...(isOwner ? {} : { uploadStatus: "PUBLISHED" }),
      },
      orderBy: { createdAt: "desc" },
    });
    res.json({ uploads: uploads.map(toUploadDto) });
  })
);
