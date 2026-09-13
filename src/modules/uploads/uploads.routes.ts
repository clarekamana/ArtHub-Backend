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
/**
 * @openapi
 * /uploads/initiate:
 *   post:
 *     summary: Initiate an upload and get a presigned upload URL
 *     description: File bytes never pass through this server; the client uploads directly to S3 using the returned presigned URL (multipart for anything >20MB).
 *     tags: [Uploads]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [title, filename, mimeType, fileSizeBytes]
 *             properties:
 *               title: { type: string, minLength: 1, maxLength: 120 }
 *               description: { type: string, maxLength: 2000 }
 *               filename: { type: string, minLength: 1 }
 *               mimeType: { type: string, minLength: 1 }
 *               fileSizeBytes: { type: integer, minimum: 1 }
 *               sizeExceptionApprovalId: { type: string, format: uuid }
 *     responses:
 *       201:
 *         description: Upload record created and presigned URL issued
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 uploadId: { type: string, format: uuid }
 *                 uploadUrl: { type: string, format: uri }
 *                 expiresIn: { type: integer }
 *       400: { $ref: '#/components/responses/ValidationError' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
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

/**
 * @openapi
 * /uploads/{id}/confirm:
 *   post:
 *     summary: Confirm that a file was successfully uploaded to S3
 *     tags: [Uploads]
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Upload confirmed
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/UploadDto' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       404: { $ref: '#/components/responses/NotFound' }
 */
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
/**
 * @openapi
 * /uploads/{id}/publish:
 *   post:
 *     summary: Publish an upload
 *     description: Requires license and tags to be set before the upload becomes publicly visible.
 *     tags: [Uploads]
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [licenseType]
 *             properties:
 *               licenseType: { type: string, description: LicenseType enum value }
 *               tags:
 *                 type: array
 *                 items: { type: string, minLength: 1, maxLength: 30 }
 *                 maxItems: 20
 *     responses:
 *       200:
 *         description: Upload published
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/UploadDto' }
 *       400: { $ref: '#/components/responses/ValidationError' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       404: { $ref: '#/components/responses/NotFound' }
 */
uploadsRouter.post(
  "/:id/publish",
  requireAuth,
  asyncHandler(async (req, res) => {
    const body = publishSchema.parse(req.body);
    const upload = await publishUpload(req.params.id, req.auth!.userId, body);
    res.json(toUploadDto(upload as any));
  })
);

/**
 * @openapi
 * /uploads/{id}:
 *   get:
 *     summary: Get an upload's details
 *     description: Published uploads are visible to anyone; unpublished uploads are only visible to their owner.
 *     tags: [Uploads]
 *     security: []
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Upload details
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/UploadDto'
 *                 - type: object
 *                   properties:
 *                     tags: { type: array, items: { type: string } }
 *                     uploader:
 *                       type: object
 *                       properties:
 *                         id: { type: string, format: uuid }
 *                         displayName: { type: string }
 *                     canDownload: { type: boolean }
 *       404: { $ref: '#/components/responses/NotFound' }
 */
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
/**
 * @openapi
 * /uploads/{id}/download-url:
 *   get:
 *     summary: Get a presigned, time-limited download URL for an upload
 *     description: Gated by the upload's license terms.
 *     tags: [Uploads]
 *     security: []
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Presigned download URL
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 url: { type: string, format: uri }
 *       404: { $ref: '#/components/responses/NotFound' }
 */
uploadsRouter.get(
  "/:id/download-url",
  optionalAuth,
  asyncHandler(async (req, res) => {
    const url = await getDownloadUrl(req.params.id);
    res.json({ url });
  })
);

/**
 * @openapi
 * /uploads/{id}:
 *   delete:
 *     summary: Delete an upload
 *     tags: [Uploads]
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       204: { description: Upload deleted }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       404:
 *         description: Upload not found or not owned by the current user
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 */
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

/**
 * @openapi
 * /uploads/user/{userId}:
 *   get:
 *     summary: List a user's uploads
 *     description: Owners see all their uploads; other viewers only see published ones.
 *     tags: [Uploads]
 *     security: []
 *     parameters:
 *       - name: userId
 *         in: path
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Uploads, newest first
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 uploads:
 *                   type: array
 *                   items: { $ref: '#/components/schemas/UploadDto' }
 */
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
