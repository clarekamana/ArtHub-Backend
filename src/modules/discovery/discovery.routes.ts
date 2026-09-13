import { Router } from "express";
import { z } from "zod";
import { FileCategory, LicenseType, Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { asyncHandler } from "../../middleware/errorHandler";
import { toUploadDto } from "../uploads/uploads.service";

export const discoveryRouter = Router();

const searchSchema = z.object({
  q: z.string().max(200).optional(),
  category: z.nativeEnum(FileCategory).optional(),
  license: z.nativeEnum(LicenseType).optional(),
  sort: z.enum(["recent", "popular"]).default("recent"),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
});

// FR-4.1/4.2: full-text-ish search across title/description/tags, filterable, paginated
/**
 * @openapi
 * /discovery/search:
 *   get:
 *     summary: Search and browse published uploads
 *     tags: [Discovery]
 *     security: []
 *     parameters:
 *       - name: q
 *         in: query
 *         schema: { type: string, maxLength: 200 }
 *         description: Free-text search over title/description/tags
 *       - name: category
 *         in: query
 *         schema: { type: string }
 *         description: FileCategory enum value
 *       - name: license
 *         in: query
 *         schema: { type: string }
 *         description: LicenseType enum value
 *       - name: sort
 *         in: query
 *         schema: { type: string, enum: [recent, popular], default: recent }
 *       - name: page
 *         in: query
 *         schema: { type: integer, minimum: 1, default: 1 }
 *       - name: pageSize
 *         in: query
 *         schema: { type: integer, minimum: 1, maximum: 50, default: 20 }
 *     responses:
 *       200:
 *         description: Paginated search results
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 results:
 *                   type: array
 *                   items: { $ref: '#/components/schemas/UploadDto' }
 *                 page: { type: integer }
 *                 pageSize: { type: integer }
 *                 total: { type: integer }
 *                 totalPages: { type: integer }
 *       400: { $ref: '#/components/responses/ValidationError' }
 */
discoveryRouter.get(
  "/search",
  asyncHandler(async (req, res) => {
    const { q, category, license, sort, page, pageSize } = searchSchema.parse(req.query);

    const where: Prisma.UploadWhereInput = {
      uploadStatus: "PUBLISHED",
      deletedAt: null,
      ...(category ? { category } : {}),
      ...(license ? { licenseType: license } : {}),
      ...(q
        ? {
            OR: [
              { title: { contains: q, mode: "insensitive" } },
              { description: { contains: q, mode: "insensitive" } },
              { tags: { some: { tag: { name: { contains: q, mode: "insensitive" } } } } },
            ],
          }
        : {}),
    };

    const [uploads, total] = await Promise.all([
      prisma.upload.findMany({
        where,
        orderBy: sort === "popular" ? [{ likeCount: "desc" }] : [{ publishedAt: "desc" }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.upload.count({ where }),
    ]);

    res.json({
      results: uploads.map(toUploadDto),
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
    });
  })
);

// Convenience listing of available license types for upload forms (FR-7.1)
/**
 * @openapi
 * /discovery/licenses:
 *   get:
 *     summary: List available license types
 *     tags: [Discovery]
 *     security: []
 *     responses:
 *       200:
 *         description: All LicenseType enum values
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 licenses: { type: array, items: { type: string } }
 */
discoveryRouter.get("/licenses", (_req, res) => {
  res.json({ licenses: Object.values(LicenseType) });
});

/**
 * @openapi
 * /discovery/categories:
 *   get:
 *     summary: List available file categories
 *     tags: [Discovery]
 *     security: []
 *     responses:
 *       200:
 *         description: All FileCategory enum values
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 categories: { type: array, items: { type: string } }
 */
discoveryRouter.get("/categories", (_req, res) => {
  res.json({ categories: Object.values(FileCategory) });
});
