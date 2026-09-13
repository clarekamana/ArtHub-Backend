import { Router } from "express";
import { z } from "zod";
import { ReportReason } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { asyncHandler, ApiError } from "../../middleware/errorHandler";
import { requireAuth } from "../../middleware/auth";

export const communityRouter = Router();

// FR-5.1: likes
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
