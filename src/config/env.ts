import "dotenv/config";

function required(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function num(name: string, fallback: number): number {
  const v = process.env[name];
  return v ? Number(v) : fallback;
}

export const env = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  port: num("PORT", 4000),
  appBaseUrl: required("APP_BASE_URL", "http://localhost:4000"),

  jwtSecret: required("JWT_SECRET", "dev-secret-change-me"),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? "7d",

  // Comma-separated list of allowed frontend origins, e.g. https://arthub.vercel.app
  corsOrigins: (process.env.CORS_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),

  // When true, this process also runs the BullMQ workers in-thread (Render free tier
  // has no long-running Background Worker instance type, so the single free web
  // service does double duty).
  enableInProcessWorkers: (process.env.ENABLE_WORKERS ?? "false") === "true",

  databaseUrl: required("DATABASE_URL"),
  redisUrl: required("REDIS_URL", "redis://localhost:6379"),

  s3: {
    endpoint: required("S3_ENDPOINT"),
    region: process.env.S3_REGION ?? "auto",
    accessKeyId: required("S3_ACCESS_KEY_ID"),
    secretAccessKey: required("S3_SECRET_ACCESS_KEY"),
    forcePathStyle: (process.env.S3_FORCE_PATH_STYLE ?? "true") === "true",
    bucketQuarantine: required("S3_BUCKET_QUARANTINE", "arthub-quarantine"),
    bucketPublic: required("S3_BUCKET_PUBLIC", "arthub-public"),
    bucketArchive: required("S3_BUCKET_ARCHIVE", "arthub-archive"),
  },

  cdnBaseUrl: required("CDN_BASE_URL", "http://localhost:9000/arthub-public"),

  presign: {
    uploadTtlSeconds: num("PRESIGN_UPLOAD_TTL", 900),
    downloadTtlSeconds: num("PRESIGN_DOWNLOAD_TTL", 14400),
  },

  quotas: {
    freeBytes: BigInt(num("QUOTA_FREE_BYTES", 2 * 1024 * 1024 * 1024)),
    verifiedBytes: BigInt(num("QUOTA_VERIFIED_BYTES", 10 * 1024 * 1024 * 1024)),
  },

  // Hard file-size caps by category, Section 9.3
  maxFileSize: {
    RASTER_IMAGE: num("MAX_FILE_SIZE_IMAGE", 20 * 1024 * 1024),
    VECTOR_DESIGN: num("MAX_FILE_SIZE_VECTOR", 100 * 1024 * 1024),
    THREE_D_STANDARD: num("MAX_FILE_SIZE_3D_STANDARD", 500 * 1024 * 1024),
    THREE_D_EXCEPTION: num("MAX_FILE_SIZE_3D_EXCEPTION", 2 * 1024 * 1024 * 1024),
  },
};
