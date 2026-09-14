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

## Deploying for free (Render + Neon + Upstash + Cloudflare R2)

Render's free plan only covers a **Web Service** — there's no free Background Worker/Cron
instance type, so the free deploy runs the BullMQ workers in the same process as the API
(`ENABLE_WORKERS=true`, see `src/index.ts`). Split them into `npm run worker` /
`npm run worker:lifecycle` on their own paid worker services later if the queue backs up.

1. **Postgres — [Neon](https://neon.tech)**: create a free project, copy the pooled connection
   string into `DATABASE_URL` (append `?sslmode=require` if Neon doesn't already include it).
2. **Redis — [Upstash](https://upstash.com)**: create a free Redis database, copy the `rediss://`
   connection string into `REDIS_URL`.
3. **Object storage — [Cloudflare R2](https://developers.cloudflare.com/r2/)**: create three
   buckets (`arthub-quarantine`, `arthub-public`, `arthub-archive`), an R2 API token
   (Access Key ID/Secret), and enable public access (or a custom domain) on `arthub-public` for
   `CDN_BASE_URL`. R2 is S3-compatible, so no code changes are needed:
   - `S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com`
   - `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` — from the R2 API token
   - `CDN_BASE_URL` — the public bucket's `r2.dev` URL or your custom domain
4. **Backend — [Render](https://render.com)**: push this repo to GitHub, then either click
   "New > Blueprint" and point Render at `render.yaml`, or create the Web Service by hand with:
   - Build command: `npm install --include=dev && npm run build` (the `--include=dev` is required
     because `NODE_ENV=production` at runtime otherwise makes npm skip `typescript`/`@types/*` too)
   - Start command: `npm run render-start` (runs `prisma migrate deploy` before booting)
   - Health check path: `/health`
   Fill in the `sync: false` env vars from steps 1–3 in the Render dashboard, plus
   `APP_BASE_URL` (your Render URL) and `CORS_ORIGINS` (your deployed frontend origin, comma-separated,
   no trailing slash).
5. **Frontend — [Vercel](https://vercel.com) or [Netlify](https://netlify.com)**: point it at
   `https://<your-service>.onrender.com/api` as the API base URL.

**Free-tier caveats:** the Render free web service spins down after 15 minutes idle, so the
first request after a lull cold-starts (10–50s) and in-process workers won't drain the queue
while asleep — a queued job runs as soon as the next request wakes the service. Neon/Upstash
free tiers also idle/pause on their own schedules; expect a similar cold-start on the DB/Redis
side after inactivity.

## Not yet wired (explicitly out of MVP code, per SRS boundaries)

- Real ClamAV/AV integration and real sandboxed Blender container invocation (interfaces exist, stubbed).
- Email delivery (inactivity notices, DMCA correspondence) — Section 5.6/9.4 hooks are marked `TODO(production)`.
- Native mobile apps, paid marketplace/checkout — explicitly out of scope for v1.0 (Section 1.2).
