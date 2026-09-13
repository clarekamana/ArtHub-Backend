import { Router } from "express";
import { z } from "zod";
import { AccountTier, FileCategory } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { asyncHandler, ApiError } from "../../middleware/errorHandler";
import { requireAuth, requireRole } from "../../middleware/auth";

export const moderationRouter = Router();

moderationRouter.use(requireAuth, requireRole("MODERATOR", "SUPER_ADMIN"));

// FR-6.2: storage dashboard - total usage, per-user usage, largest files, conversion queues
moderationRouter.get(
  "/dashboard",
  asyncHandler(async (_req, res) => {
    const [totalAgg, topUsers, largestFiles, pendingConversions, failedConversions, openReports] =
      await Promise.all([
        prisma.upload.aggregate({ _sum: { fileSizeBytes: true }, where: { deletedAt: null } }),
        prisma.user.findMany({
          orderBy: { storageUsedBytes: "desc" },
          take: 10,
          select: { id: true, displayName: true, storageUsedBytes: true, tier: true },
        }),
        prisma.upload.findMany({
          where: { deletedAt: null },
          orderBy: { fileSizeBytes: "desc" },
          take: 10,
          select: { id: true, title: true, fileSizeBytes: true, uploaderId: true },
        }),
        prisma.upload.count({ where: { conversionStatus: "PENDING" } }),
        prisma.upload.count({ where: { conversionStatus: "FAILED" } }),
        prisma.report.count({ where: { status: "OPEN" } }),
      ]);

    res.json({
      totalStorageBytes: (totalAgg._sum.fileSizeBytes ?? 0n).toString(),
      topUsersByStorage: topUsers.map((u) => ({ ...u, storageUsedBytes: u.storageUsedBytes.toString() })),
      largestFiles: largestFiles.map((f) => ({ ...f, fileSizeBytes: f.fileSizeBytes.toString() })),
      conversionsPending: pendingConversions,
      conversionsFailed: failedConversions,
      openReports,
    });
  })
);

// FR-6.1: review flagged content
moderationRouter.get(
  "/reports",
  asyncHandler(async (req, res) => {
    const status = (req.query.status as string) ?? "OPEN";
    const reports = await prisma.report.findMany({
      where: { status: status as any },
      include: { upload: true, reporter: { select: { id: true, displayName: true } } },
      orderBy: { createdAt: "desc" },
    });
    res.json({ reports });
  })
);

const resolveReportSchema = z.object({
  action: z.enum(["remove_upload", "dismiss"]),
  reason: z.string().max(500).optional(),
});

moderationRouter.post(
  "/reports/:id/resolve",
  asyncHandler(async (req, res) => {
    const { action, reason } = resolveReportSchema.parse(req.body);
    const report = await prisma.report.findUnique({ where: { id: req.params.id } });
    if (!report) throw new ApiError(404, "Report not found");

    await prisma.$transaction(async (tx) => {
      await tx.report.update({
        where: { id: report.id },
        data: { status: action === "remove_upload" ? "ACTIONED" : "DISMISSED", resolvedAt: new Date() },
      });
      if (action === "remove_upload") {
        await tx.upload.update({ where: { id: report.uploadId }, data: { uploadStatus: "TAKEN_DOWN" } });
      }
      await tx.moderationAction.create({
        data: {
          moderatorId: req.auth!.userId,
          targetUploadId: report.uploadId,
          action,
          reason,
        },
      });
    });

    res.status(204).send();
  })
);

// FR-6.1: warn/ban users
const banSchema = z.object({ reason: z.string().max(500).optional() });

moderationRouter.post(
  "/users/:id/ban",
  asyncHandler(async (req, res) => {
    const { reason } = banSchema.parse(req.body);
    await prisma.$transaction([
      prisma.user.update({ where: { id: req.params.id }, data: { status: "BANNED" } }),
      prisma.moderationAction.create({
        data: { moderatorId: req.auth!.userId, targetUserId: req.params.id, action: "ban", reason },
      }),
    ]);
    res.status(204).send();
  })
);

moderationRouter.post(
  "/users/:id/warn",
  asyncHandler(async (req, res) => {
    const { reason } = banSchema.parse(req.body);
    await prisma.moderationAction.create({
      data: { moderatorId: req.auth!.userId, targetUserId: req.params.id, action: "warn", reason },
    });
    res.status(204).send();
  })
);

// FR-6.3 / Section 9.2: adjust per-user tier/quota (Verified Artist unlock)
const tierSchema = z.object({ tier: z.nativeEnum(AccountTier) });

moderationRouter.post(
  "/users/:id/tier",
  asyncHandler(async (req, res) => {
    const { tier } = tierSchema.parse(req.body);
    await prisma.$transaction([
      prisma.user.update({ where: { id: req.params.id }, data: { tier } }),
      prisma.moderationAction.create({
        data: { moderatorId: req.auth!.userId, targetUserId: req.params.id, action: `tier:${tier}` },
      }),
    ]);
    res.status(204).send();
  })
);

// Section 9.3: grant a one-time file-size exception (up to the 2GB absolute ceiling)
const exceptionSchema = z.object({
  userId: z.string().uuid(),
  category: z.nativeEnum(FileCategory),
  maxBytes: z.number().int().positive().max(2 * 1024 * 1024 * 1024),
  reason: z.string().max(500).optional(),
  expiresInDays: z.number().int().positive().max(30).optional(),
});

moderationRouter.post(
  "/size-exceptions",
  requireRole("SUPER_ADMIN"),
  asyncHandler(async (req, res) => {
    const body = exceptionSchema.parse(req.body);
    const approval = await prisma.sizeExceptionApproval.create({
      data: {
        userId: body.userId,
        approvedById: req.auth!.userId,
        category: body.category,
        maxBytes: BigInt(body.maxBytes),
        reason: body.reason,
        expiresAt: body.expiresInDays ? new Date(Date.now() + body.expiresInDays * 86400000) : null,
      },
    });
    res.status(201).json({ ...approval, maxBytes: approval.maxBytes.toString() });
  })
);
