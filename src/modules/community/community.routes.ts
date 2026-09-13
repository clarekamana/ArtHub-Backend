import { Router } from "express";
import { z } from "zod";
import { ReportReason } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { asyncHandler, ApiError } from "../../middleware/errorHandler";
import { requireAuth } from "../../middleware/auth";

export const communityRouter = Router();

// FR-5.1: likes
/**
 * @openapi
 * /community/uploads/{uploadId}/like:
 *   post:
 *     summary: Like an upload
 *     tags: [Community]
 *     parameters:
 *       - name: uploadId
 *         in: path
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       204: { description: Liked (idempotent) }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       404: { $ref: '#/components/responses/NotFound' }
 */
communityRouter.post(
  "/uploads/:uploadId/like",
  requireAuth,
  asyncHandler(async (req, res) => {
    const uploadId = req.params.uploadId;
    const upload = await prisma.upload.findUnique({ where: { id: uploadId } });
    if (!upload || upload.uploadStatus !== "PUBLISHED") throw new ApiError(404, "Upload not found");

    await prisma.$transaction([
      prisma.like.upsert({
        where: { userId_uploadId: { userId: req.auth!.userId, uploadId } },
        create: { userId: req.auth!.userId, uploadId },
        update: {},
      }),
      prisma.upload.update({ where: { id: uploadId }, data: { likeCount: { increment: 1 } } }),
    ]).catch(async (e) => {
      // Already liked - ignore silently (idempotent like)
      if (e.code !== "P2002") throw e;
    });

    res.status(204).send();
  })
);

/**
 * @openapi
 * /community/uploads/{uploadId}/like:
 *   delete:
 *     summary: Unlike an upload
 *     tags: [Community]
 *     parameters:
 *       - name: uploadId
 *         in: path
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       204: { description: Unliked (idempotent) }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
communityRouter.delete(
  "/uploads/:uploadId/like",
  requireAuth,
  asyncHandler(async (req, res) => {
    const uploadId = req.params.uploadId;
    const deleted = await prisma.like
      .delete({ where: { userId_uploadId: { userId: req.auth!.userId, uploadId } } })
      .catch(() => null);
    if (deleted) {
      await prisma.upload.update({ where: { id: uploadId }, data: { likeCount: { decrement: 1 } } });
    }
    res.status(204).send();
  })
);

// FR-5.1: comments
const commentSchema = z.object({ body: z.string().min(1).max(1000) });

/**
 * @openapi
 * /community/uploads/{uploadId}/comments:
 *   post:
 *     summary: Add a comment to an upload
 *     tags: [Community]
 *     parameters:
 *       - name: uploadId
 *         in: path
 *         required: true
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [body]
 *             properties:
 *               body: { type: string, minLength: 1, maxLength: 1000 }
 *     responses:
 *       201:
 *         description: Comment created
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Comment' }
 *       400: { $ref: '#/components/responses/ValidationError' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       404: { $ref: '#/components/responses/NotFound' }
 */
communityRouter.post(
  "/uploads/:uploadId/comments",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { body } = commentSchema.parse(req.body);
    const upload = await prisma.upload.findUnique({ where: { id: req.params.uploadId } });
    if (!upload || upload.uploadStatus !== "PUBLISHED") throw new ApiError(404, "Upload not found");

    const comment = await prisma.comment.create({
      data: { uploadId: req.params.uploadId, userId: req.auth!.userId, body },
    });
    res.status(201).json(comment);
  })
);

/**
 * @openapi
 * /community/uploads/{uploadId}/comments:
 *   get:
 *     summary: List comments on an upload
 *     tags: [Community]
 *     security: []
 *     parameters:
 *       - name: uploadId
 *         in: path
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Comments, oldest first
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 comments:
 *                   type: array
 *                   items: { $ref: '#/components/schemas/Comment' }
 */
communityRouter.get(
  "/uploads/:uploadId/comments",
  asyncHandler(async (req, res) => {
    const comments = await prisma.comment.findMany({
      where: { uploadId: req.params.uploadId, deletedAt: null },
      orderBy: { createdAt: "asc" },
      include: { user: { select: { id: true, displayName: true } } },
    });
    res.json({ comments });
  })
);

// FR-5.1: follows
/**
 * @openapi
 * /community/users/{userId}/follow:
 *   post:
 *     summary: Follow a user
 *     tags: [Community]
 *     parameters:
 *       - name: userId
 *         in: path
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       204: { description: Followed (idempotent) }
 *       400:
 *         description: Cannot follow yourself
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
communityRouter.post(
  "/users/:userId/follow",
  requireAuth,
  asyncHandler(async (req, res) => {
    if (req.params.userId === req.auth!.userId) throw new ApiError(400, "Cannot follow yourself");
    await prisma.follow.upsert({
      where: { followerId_followingId: { followerId: req.auth!.userId, followingId: req.params.userId } },
      create: { followerId: req.auth!.userId, followingId: req.params.userId },
      update: {},
    });
    res.status(204).send();
  })
);

/**
 * @openapi
 * /community/users/{userId}/follow:
 *   delete:
 *     summary: Unfollow a user
 *     tags: [Community]
 *     parameters:
 *       - name: userId
 *         in: path
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       204: { description: Unfollowed (idempotent) }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
communityRouter.delete(
  "/users/:userId/follow",
  requireAuth,
  asyncHandler(async (req, res) => {
    await prisma.follow
      .delete({ where: { followerId_followingId: { followerId: req.auth!.userId, followingId: req.params.userId } } })
      .catch(() => null);
    res.status(204).send();
  })
);

// FR-5.2: report/flag content for moderation
const reportSchema = z.object({
  reason: z.nativeEnum(ReportReason),
  details: z.string().max(1000).optional(),
});

/**
 * @openapi
 * /community/uploads/{uploadId}/report:
 *   post:
 *     summary: Report/flag an upload for moderation
 *     tags: [Community]
 *     parameters:
 *       - name: uploadId
 *         in: path
 *         required: true
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [reason]
 *             properties:
 *               reason:
 *                 type: string
 *                 description: ReportReason enum value
 *               details: { type: string, maxLength: 1000 }
 *     responses:
 *       201:
 *         description: Report created
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Report' }
 *       400: { $ref: '#/components/responses/ValidationError' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       404: { $ref: '#/components/responses/NotFound' }
 */
communityRouter.post(
  "/uploads/:uploadId/report",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { reason, details } = reportSchema.parse(req.body);
    const upload = await prisma.upload.findUnique({ where: { id: req.params.uploadId } });
    if (!upload) throw new ApiError(404, "Upload not found");

    const report = await prisma.report.create({
      data: { uploadId: req.params.uploadId, reporterId: req.auth!.userId, reason, details },
    });
    res.status(201).json(report);
  })
);
