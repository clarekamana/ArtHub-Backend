import { Router } from "express";
import { z } from "zod";
import { AccountTier, FileCategory } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { asyncHandler, ApiError } from "../../middleware/errorHandler";
import { requireAuth, requireRole } from "../../middleware/auth";

export const moderationRouter = Router();

moderationRouter.use(requireAuth, requireRole("MODERATOR", "SUPER_ADMIN"));

// FR-6.2: storage dashboard - total usage, per-user usage, largest files, conversion queues
/**
 * @openapi
 * /admin/dashboard:
 *   get:
 *     summary: Storage & moderation dashboard
 *     description: Total usage, top users by storage, largest files, conversion queue counts, open reports. Requires MODERATOR or SUPER_ADMIN.
 *     tags: [Moderation]
 *     responses:
 *       200:
 *         description: Dashboard data
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 totalStorageBytes: { type: string }
 *                 topUsersByStorage:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id: { type: string, format: uuid }
 *                       displayName: { type: string }
 *                       storageUsedBytes: { type: string }
 *                       tier: { type: string }
 *                 largestFiles:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id: { type: string, format: uuid }
 *                       title: { type: string }
 *                       fileSizeBytes: { type: string }
 *                       uploaderId: { type: string, format: uuid }
 *                 conversionsPending: { type: integer }
 *                 conversionsFailed: { type: integer }
 *                 openReports: { type: integer }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 */
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
/**
 * @openapi
 * /admin/reports:
 *   get:
 *     summary: List content reports
 *     tags: [Moderation]
 *     parameters:
 *       - name: status
 *         in: query
 *         schema: { type: string, enum: [OPEN, ACTIONED, DISMISSED], default: OPEN }
 *     responses:
 *       200:
 *         description: Reports, newest first
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 reports:
 *                   type: array
 *                   items: { $ref: '#/components/schemas/Report' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 */
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

/**
 * @openapi
 * /admin/reports/{id}/resolve:
 *   post:
 *     summary: Resolve a content report
 *     tags: [Moderation]
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
 *             required: [action]
 *             properties:
 *               action: { type: string, enum: [remove_upload, dismiss] }
 *               reason: { type: string, maxLength: 500 }
 *     responses:
 *       204: { description: Report resolved }
 *       400: { $ref: '#/components/responses/ValidationError' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *       404: { $ref: '#/components/responses/NotFound' }
 */
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

/**
 * @openapi
 * /admin/users/{id}/ban:
 *   post:
 *     summary: Ban a user
 *     tags: [Moderation]
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               reason: { type: string, maxLength: 500 }
 *     responses:
 *       204: { description: User banned }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 */
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

/**
 * @openapi
 * /admin/users/{id}/warn:
 *   post:
 *     summary: Warn a user
 *     tags: [Moderation]
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               reason: { type: string, maxLength: 500 }
 *     responses:
 *       204: { description: Warning recorded }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 */
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

/**
 * @openapi
 * /admin/users/{id}/tier:
 *   post:
 *     summary: Change a user's account tier
 *     description: Adjusts per-user tier/quota, e.g. to unlock Verified Artist.
 *     tags: [Moderation]
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
 *             required: [tier]
 *             properties:
 *               tier: { type: string, description: AccountTier enum value }
 *     responses:
 *       204: { description: Tier updated }
 *       400: { $ref: '#/components/responses/ValidationError' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 */
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

/**
 * @openapi
 * /admin/size-exceptions:
 *   post:
 *     summary: Grant a one-time file-size exception
 *     description: Up to the 2GB absolute ceiling (Section 9.3). Requires SUPER_ADMIN.
 *     tags: [Moderation]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [userId, category, maxBytes]
 *             properties:
 *               userId: { type: string, format: uuid }
 *               category: { type: string, description: FileCategory enum value }
 *               maxBytes: { type: integer, minimum: 1, maximum: 2147483648 }
 *               reason: { type: string, maxLength: 500 }
 *               expiresInDays: { type: integer, minimum: 1, maximum: 30 }
 *     responses:
 *       201:
 *         description: Exception approval created
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 id: { type: string, format: uuid }
 *                 userId: { type: string, format: uuid }
 *                 approvedById: { type: string, format: uuid }
 *                 category: { type: string }
 *                 maxBytes: { type: string }
 *                 reason: { type: string, nullable: true }
 *                 expiresAt: { type: string, format: date-time, nullable: true }
 *       400: { $ref: '#/components/responses/ValidationError' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 */
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
