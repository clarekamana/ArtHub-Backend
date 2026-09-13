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
/**
 * @openapi
 * /collections:
 *   post:
 *     summary: Create a collection
 *     description: isCurated=true is reserved for club-run showcases and requires a MODERATOR or SUPER_ADMIN role.
 *     tags: [Collections]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [title]
 *             properties:
 *               title: { type: string, minLength: 1, maxLength: 120 }
 *               description: { type: string, maxLength: 1000 }
 *               isCurated: { type: boolean }
 *     responses:
 *       201:
 *         description: Collection created
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Collection' }
 *       400: { $ref: '#/components/responses/ValidationError' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 */
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

/**
 * @openapi
 * /collections/{id}:
 *   get:
 *     summary: Get a collection with its published items
 *     tags: [Collections]
 *     security: []
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Collection with items
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/Collection'
 *                 - type: object
 *                   properties:
 *                     items:
 *                       type: array
 *                       items: { $ref: '#/components/schemas/UploadDto' }
 *       404: { $ref: '#/components/responses/NotFound' }
 */
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

/**
 * @openapi
 * /collections/{id}/items/{uploadId}:
 *   post:
 *     summary: Add an upload to a collection
 *     tags: [Collections]
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema: { type: string, format: uuid }
 *       - name: uploadId
 *         in: path
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       204: { description: Item added (idempotent) }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       404:
 *         description: Collection not found or not owned by the current user
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 */
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

/**
 * @openapi
 * /collections/{id}/items/{uploadId}:
 *   delete:
 *     summary: Remove an upload from a collection
 *     tags: [Collections]
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema: { type: string, format: uuid }
 *       - name: uploadId
 *         in: path
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       204: { description: Item removed (idempotent) }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       404:
 *         description: Collection not found or not owned by the current user
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 */
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
