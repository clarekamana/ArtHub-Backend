# ArtHub Backend (MVP)

Backend for the ArtHub platform per the SRS: Node.js/TypeScript + Express, PostgreSQL (via Prisma) for metadata only, and S3-compatible object storage for all file bytes, with a background worker pipeline for scanning/converting 3D uploads.

## Architecture

- **API** (`src/app.ts`, `src/modules/*`): stateless Express app, JWT auth, all metadata CRUD.
- **Database** (`prisma/schema.prisma`): Postgres holds only metadata/pointers, never file bytes (Section 4.1).
- **Object storage** (`src/lib/s3.ts`): S3-compatible (Cloudflare R2 / Backblaze B2 / MinIO / AWS S3). Uploads/downloads go browser⇄storage directly via presigned URLs, never through the API server.
- **Workers** (`src/workers/*`): BullMQ/Redis-backed background jobs implementing the Section 4.2 pipeline (quarantine → scan → convert → promote to public) and Section 4.4/9.4 lifecycle sweeps (version purge, inactive-account archival, deleted-account purge).

## Upload flow (Section 4.2)

1. `POST /api/uploads/initiate` — validates category/size/quota, creates an `Upload` row, returns a presigned PUT URL into the private quarantine bucket.
2. Client uploads bytes directly to that URL (chunked/multipart for large files, done client-side against S3).
3. `POST /api/uploads/:id/confirm` — marks the row `QUARANTINED` and enqueues the scan/convert job.
4. Worker (`npm run worker`) scans the file, and for 3D formats attempts a headless conversion to `.glb` + thumbnail, then promotes everything to the public bucket and updates the DB pointers. Conversion failure never blocks publishing the original (`conversionStatus: FAILED`, original still downloadable).
5. `POST /api/uploads/:id/publish` — attaches license + tags, required before public listing.

**Production note:** `src/workers/scanner.ts` and `src/workers/converter.ts` are the integration boundaries for a real ClamAV scan and a real sandboxed, network-isolated, pinned-version headless Blender container (Section 4.3). They're stubbed in this MVP so the full pipeline is exercisable without that infrastructure — replace both before any public deployment.

## Local dev setup

```bash
docker compose up -d          # postgres + redis + minio
cp .env.example .env          # adjust as needed
npm install
npm run prisma:migrate        # creates tables
npm run dev                   # API on :4000
npm run worker                # scan/convert worker (separate terminal)
npm run worker:lifecycle      # daily tiering/retention sweep (separate terminal)
```

MinIO console is at http://localhost:9001 (minioadmin/minioadmin) — create the three buckets named in `.env` (`arthub-quarantine`, `arthub-public`, `arthub-archive`) before testing uploads.

## API surface

- `POST /api/auth/register|login|oauth/google`, `GET /api/auth/me`
- `GET /api/users/:id`, `GET /api/users/:id/portfolio`, `PATCH /api/users/me`, `GET /api/users/me/quota`, `POST /api/users/me/delete|restore`
- `POST /api/uploads/initiate|:id/confirm|:id/publish`, `GET /api/uploads/:id|:id/download-url|user/:userId`, `DELETE /api/uploads/:id`
- `GET /api/discovery/search|licenses|categories`
- `POST/DELETE /api/community/uploads/:id/like`, `POST/GET /api/community/uploads/:id/comments`, `POST/DELETE /api/community/users/:id/follow`, `POST /api/community/uploads/:id/report`
- `POST /api/collections`, `GET /api/collections/:id`, `POST/DELETE /api/collections/:id/items/:uploadId`
- Admin (`MODERATOR`/`SUPER_ADMIN` only): `GET /api/admin/dashboard`, `GET /api/admin/reports`, `POST /api/admin/reports/:id/resolve`, `POST /api/admin/users/:id/ban|warn|tier`, `POST /api/admin/size-exceptions`

## Not yet wired (explicitly out of MVP code, per SRS boundaries)

- Real ClamAV/AV integration and real sandboxed Blender container invocation (interfaces exist, stubbed).
- Email delivery (inactivity notices, DMCA correspondence) — Section 5.6/9.4 hooks are marked `TODO(production)`.
- Native mobile apps, paid marketplace/checkout — explicitly out of scope for v1.0 (Section 1.2).
