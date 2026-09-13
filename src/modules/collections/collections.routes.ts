import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { asyncHandler, ApiError } from "../../middleware/errorHandler";
import { requireAuth, optionalAuth, requireRole } from "../../middleware/auth";
import { toUploadDto } from "../uploads/uploads.service";

export const collectionsRouter = Router();

const createSchema = z.object({
  title: z.string().min(1).max(120),
  description: z.string().max(1000).optional(),
  isCurated: z.boolean().optional(),
});

// FR-4.3: user portfolios/collections; isCurated=true reserved for club-run showcases
collectionsRouter.post(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const body = createSchema.parse(req.body);
    if (body.isCurated) {
      requireRole("MODERATOR", "SUPER_ADMIN")(req, res, () => {});
      if (!req.auth || !["MODERATOR", "SUPER_ADMIN"].includes(req.auth.role)) {
        throw new ApiError(403, "Only club admins can create curated collections");
      }
    }
    const collection = await prisma.collection.create({
      data: { ownerId: req.auth!.userId, ...body },
    });
    res.status(201).json(collection);
  })
);

collectionsRouter.get(
  "/:id",
  optionalAuth,
  asyncHandler(async (req, res) => {
    const collection = await prisma.collection.findUnique({
      where: { id: req.params.id },
      include: { items: { include: { upload: true }, orderBy: { addedAt: "desc" } } },
    });
    if (!collection) throw new ApiError(404, "Collection not found");
    res.json({
      ...collection,
      items: collection.items
        .filter((i) => i.upload.uploadStatus === "PUBLISHED")
        .map((i) => toUploadDto(i.upload)),
    });
  })
);

collectionsRouter.post(
  "/:id/items/:uploadId",
  requireAuth,
  asyncHandler(async (req, res) => {
    const collection = await prisma.collection.findUnique({ where: { id: req.params.id } });
    if (!collection || collection.ownerId !== req.auth!.userId) throw new ApiError(404, "Collection not found");

    await prisma.collectionItem.upsert({
      where: { collectionId_uploadId: { collectionId: req.params.id, uploadId: req.params.uploadId } },
      create: { collectionId: req.params.id, uploadId: req.params.uploadId },
      update: {},
    });
    res.status(204).send();
  })
);

collectionsRouter.delete(
  "/:id/items/:uploadId",
  requireAuth,
  asyncHandler(async (req, res) => {
    const collection = await prisma.collection.findUnique({ where: { id: req.params.id } });
    if (!collection || collection.ownerId !== req.auth!.userId) throw new ApiError(404, "Collection not found");

    await prisma.collectionItem
      .delete({ where: { collectionId_uploadId: { collectionId: req.params.id, uploadId: req.params.uploadId } } })
      .catch(() => null);
    res.status(204).send();
  })
);
