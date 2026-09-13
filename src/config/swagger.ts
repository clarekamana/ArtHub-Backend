import swaggerJsdoc from "swagger-jsdoc";

const options: swaggerJsdoc.Options = {
  definition: {
    openapi: "3.0.3",
    info: {
      title: "ArtHub API",
      version: "1.0.0",
      description:
        "Arts & Design Club Portfolio and 3D Asset Platform — REST API for auth, profiles, uploads, discovery, community interactions, collections, and moderation.",
    },
    servers: [{ url: "/api", description: "API base path" }],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
        },
      },
      schemas: {
        Error: {
          type: "object",
          properties: {
            error: { type: "string", example: "Resource not found" },
          },
        },
        PublicUser: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
            email: { type: "string", format: "email" },
            displayName: { type: "string" },
            role: { type: "string", enum: ["USER", "MODERATOR", "SUPER_ADMIN"] },
            tier: { type: "string", enum: ["FREE", "VERIFIED_ARTIST"] },
            isArtistMode: { type: "boolean" },
            storageUsedBytes: { type: "string", example: "10485760" },
          },
        },
        AuthResponse: {
          type: "object",
          properties: {
            token: { type: "string" },
            user: { $ref: "#/components/schemas/PublicUser" },
          },
        },
        UploadDto: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
            title: { type: "string" },
            description: { type: "string", nullable: true },
            category: { type: "string" },
            licenseType: { type: "string" },
            uploadStatus: {
              type: "string",
              enum: ["PENDING", "PUBLISHED", "TAKEN_DOWN", "DELETED"],
            },
            fileSizeBytes: { type: "string" },
            likeCount: { type: "integer" },
            viewCount: { type: "integer" },
            publishedAt: { type: "string", format: "date-time", nullable: true },
            createdAt: { type: "string", format: "date-time" },
          },
        },
        Comment: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
            uploadId: { type: "string", format: "uuid" },
            userId: { type: "string", format: "uuid" },
            body: { type: "string" },
            createdAt: { type: "string", format: "date-time" },
          },
        },
        Report: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
            uploadId: { type: "string", format: "uuid" },
            reporterId: { type: "string", format: "uuid" },
            reason: { type: "string" },
            details: { type: "string", nullable: true },
            status: { type: "string", enum: ["OPEN", "ACTIONED", "DISMISSED"] },
            createdAt: { type: "string", format: "date-time" },
          },
        },
        Collection: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
            ownerId: { type: "string", format: "uuid" },
            title: { type: "string" },
            description: { type: "string", nullable: true },
            isCurated: { type: "boolean" },
          },
        },
      },
      responses: {
        Unauthorized: {
          description: "Missing or invalid authentication token",
          content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
        },
        Forbidden: {
          description: "Authenticated but not permitted to perform this action",
          content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
        },
        NotFound: {
          description: "Resource not found",
          content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
        },
        ValidationError: {
          description: "Request body/query failed validation",
          content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
        },
      },
    },
    security: [{ bearerAuth: [] }],
  },
  apis: ["./src/modules/**/*.routes.ts", "./src/app.ts"],
};

export const swaggerSpec = swaggerJsdoc(options);
