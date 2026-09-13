import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { asyncHandler, ApiError } from "../../middleware/errorHandler";
import { requireAuth, optionalAuth } from "../../middleware/auth";
import { cdnUrl } from "../../lib/s3";
import { quotaForTier } from "../../utils/quota";

export const usersRouter = Router();

// FR-1.2: public artist profile with portfolio grid
/**
 * @openapi
 * /users/{id}:
 *   get:
 *     summary: Get a public artist profile
 *     tags: [Users]
 *     security: []
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Public profile
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 id: { type: string, format: uuid }
 *                 displayName: { type: string }
 *                 bio: { type: string, nullable: true }
 *                 avatarUrl: { type: string, nullable: true }
 *                 links: { type: array, items: { type: string } }
 *                 isArtistMode: { type: boolean }
 *                 tier: { type: string }
 *                 uploadCount: { type: integer }
 *                 followerCount: { type: integer }
 *                 followingCount: { type: integer }
 *       404: { $ref: '#/components/responses/NotFound' }
 */
usersRouter.get(
  "/:id",
  optionalAuth,
  asyncHandler(async (req, res) => {
    const user = await prisma.user.findUnique({
      where: { id: req.params.id },
      include: {
        _count: { select: { uploads: true, followedBy: true, following: true } },
      },
    });
    if (!user || user.status === "DELETED") throw new ApiError(404, "User not found");

    res.json({
      id: user.id,
      displayName: user.displayName,
      bio: user.bio,
      avatarUrl: user.avatarStorageKey ? cdnUrl(user.avatarStorageKey) : null,
      links: user.links,
      isArtistMode: user.isArtistMode,
      tier: user.tier,
      uploadCount: user._count.uploads,
      followerCount: user._count.followedBy,
      followingCount: user._count.following,
    });
  })
);

/**
 * @openapi
 * /users/{id}/portfolio:
 *   get:
 *     summary: List a user's published portfolio uploads
 *     tags: [Users]
 *     security: []
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Up to 60 most recently published uploads
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 uploads:
 *                   type: array
 *                   items: { $ref: '#/components/schemas/UploadDto' }
 */
usersRouter.get(
  "/:id/portfolio",
  optionalAuth,
  asyncHandler(async (req, res) => {
    const uploads = await prisma.upload.findMany({
      where: { uploaderId: req.params.id, uploadStatus: "PUBLISHED", deletedAt: null },
      orderBy: { publishedAt: "desc" },
      take: 60,
    });
    res.json({ uploads });
  })
);

const updateProfileSchema = z.object({
  displayName: z.string().min(2).max(60).optional(),
  bio: z.string().max(500).optional(),
  links: z.array(z.string().url()).max(10).optional(),
  isArtistMode: z.boolean().optional(),
});

/**
 * @openapi
 * /users/me:
 *   patch:
 *     summary: Update the current user's profile
 *     tags: [Users]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               displayName: { type: string, minLength: 2, maxLength: 60 }
 *               bio: { type: string, maxLength: 500 }
 *               links: { type: array, items: { type: string, format: uri }, maxItems: 10 }
 *               isArtistMode: { type: boolean }
 *     responses:
 *       200:
 *         description: Updated profile
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 id: { type: string, format: uuid }
 *                 displayName: { type: string }
 *                 bio: { type: string, nullable: true }
 *                 links: { type: array, items: { type: string } }
 *                 isArtistMode: { type: boolean }
 *       400: { $ref: '#/components/responses/ValidationError' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
usersRouter.patch(
  "/me",
  requireAuth,
  asyncHandler(async (req, res) => {
    const data = updateProfileSchema.parse(req.body);
    const user = await prisma.user.update({ where: { id: req.auth!.userId }, data });
    res.json({
      id: user.id,
      displayName: user.displayName,
      bio: user.bio,
      links: user.links,
      isArtistMode: user.isArtistMode,
    });
  })
);

// Section 9.4: deletion request starts the 30-day grace period; a moderator/lifecycle
// job performs the hard purge afterwards, and the account can be restored on request until then.
/**
 * @openapi
 * /users/me/delete:
 *   post:
 *     summary: Request account deletion
 *     description: Starts the 30-day grace period (Section 9.4). A moderator/lifecycle job performs the hard purge afterwards; the account can be restored until then via /users/me/restore.
 *     tags: [Users]
 *     responses:
 *       204: { description: Deletion requested }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
usersRouter.post(
  "/me/delete",
  requireAuth,
  asyncHandler(async (req, res) => {
    await prisma.user.update({
      where: { id: req.auth!.userId },
      data: { status: "PENDING_DELETION", deletionRequestedAt: new Date() },
    });
    res.status(204).send();
  })
);

/**
 * @openapi
 * /users/me/restore:
 *   post:
 *     summary: Cancel a pending account deletion
 *     tags: [Users]
 *     responses:
 *       204: { description: Account restored to active }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       409:
 *         description: Account is not pending deletion
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 */
usersRouter.post(
  "/me/restore",
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: req.auth!.userId } });
    if (user.status !== "PENDING_DELETION") throw new ApiError(409, "Account is not pending deletion");
    await prisma.user.update({ where: { id: user.id }, data: { status: "ACTIVE", deletionRequestedAt: null } });
    res.status(204).send();
  })
);

// Section 9.1: current quota usage, exposed so the client can show "1.2GB / 2GB"
/**
 * @openapi
 * /users/me/quota:
 *   get:
 *     summary: Get the current user's storage quota usage
 *     tags: [Users]
 *     responses:
 *       200:
 *         description: Quota usage
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 usedBytes: { type: string, example: "104857600" }
 *                 quotaBytes: { type: string, example: "2147483648" }
 *                 tier: { type: string }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
usersRouter.get(
  "/me/quota",
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: req.auth!.userId } });
    res.json({
      usedBytes: user.storageUsedBytes.toString(),
      quotaBytes: quotaForTier(user.tier).toString(),
      tier: user.tier,
    });
  })
);
