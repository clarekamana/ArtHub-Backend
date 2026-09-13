import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  CopyObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "../config/env";

// S3-compatible client - works against Cloudflare R2, Backblaze B2, MinIO, or AWS S3 (Section 4.1)
export const s3 = new S3Client({
  endpoint: env.s3.endpoint,
  region: env.s3.region,
  forcePathStyle: env.s3.forcePathStyle,
  credentials: {
    accessKeyId: env.s3.accessKeyId,
    secretAccessKey: env.s3.secretAccessKey,
  },
});

/**
 * Step 2 of Section 4.2: issue a presigned PUT URL so the browser uploads
 * directly to the private quarantine bucket, never through the app server.
 */
export async function createPresignedUploadUrl(key: string, contentType: string) {
  const cmd = new PutObjectCommand({
    Bucket: env.s3.bucketQuarantine,
    Key: key,
    ContentType: contentType,
  });
  const url = await getSignedUrl(s3, cmd, { expiresIn: env.presign.uploadTtlSeconds });
  return { url, expiresIn: env.presign.uploadTtlSeconds };
}

/** Step 8: time-limited presigned download for the (comparatively rarely requested) original file. */
export async function createPresignedDownloadUrl(bucket: string, key: string) {
  const cmd = new GetObjectCommand({ Bucket: bucket, Key: key });
  return getSignedUrl(s3, cmd, { expiresIn: env.presign.downloadTtlSeconds });
}

export async function headObject(bucket: string, key: string) {
  return s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
}

/** Step 7: promote scanned/converted artifacts from quarantine into the public-serving bucket. */
export async function copyToPublicBucket(sourceKey: string, destKey: string) {
  await s3.send(
    new CopyObjectCommand({
      Bucket: env.s3.bucketPublic,
      CopySource: `/${env.s3.bucketQuarantine}/${encodeURIComponent(sourceKey)}`,
      Key: destKey,
    })
  );
}

export async function copyBetweenBuckets(sourceBucket: string, sourceKey: string, destBucket: string, destKey: string) {
  await s3.send(
    new CopyObjectCommand({
      Bucket: destBucket,
      CopySource: `/${sourceBucket}/${encodeURIComponent(sourceKey)}`,
      Key: destKey,
    })
  );
}

export async function deleteObject(bucket: string, key: string) {
  await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}

export async function putObject(bucket: string, key: string, body: Buffer, contentType: string) {
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }));
}

/** CDN-cached public URL for a key in the public bucket (Section 4.2 step 8). */
export function cdnUrl(key: string) {
  return `${env.cdnBaseUrl}/${key}`;
}
