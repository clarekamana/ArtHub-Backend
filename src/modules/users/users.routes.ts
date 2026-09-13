import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { asyncHandler, ApiError } from "../../middleware/errorHandler";
import { requireAuth, optionalAuth } from "../../middleware/auth";
import { cdnUrl } from "../../lib/s3";
import { quotaForTier } from "../../utils/quota";

export const usersRouter = Router();

// FR-1.2: public artist profile with portfolio grid
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
