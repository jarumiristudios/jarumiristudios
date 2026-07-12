# July 2026 Milestone

## Pending

- [ ] Add `og:image` and `twitter:image` meta tags — needs a logo or cover image asset first (deferred from June)

### Security/Reliability
- [x] Brute-force protection on `/login` and `/admin/login` — added a `LoginAttempt` collection (TTL-indexed) tracking failed attempts in a 15-minute rolling window, capped at 5, same DB-backed pattern as `enforceGuestSubmissionQuota`/the nudge limiter. `/login` keys on the attempted email; `/admin/login` has no email, so it keys on the `jrmr_vid` visitor cookie instead (deliberately not IP — this app doesn't set `trust proxy` behind Railway, so `req.ip` would resolve to the proxy for everyone).
- [x] Password reset flow for client accounts — shipped in `792192e` (forgot/reset password flow, trust proxy for prod cookies).
- [x] Harden session cookie config — `express-session`'s `secret` still falls back to a hardcoded `"jarumiri-dev-secret"` (`server.js:212`) if `SESSION_SECRET` isn't set, but that's confirmed set on the live Railway service. `secure` (`server.js:218`) was silently `false` in production because the Railway env var was misnamed `MODE_ENV` instead of `NODE_ENV` — fixed by renaming the Railway variable (2026-07-09). `sameSite: "lax"` added explicitly (`server.js:219`, 2026-07-09), matching the visitor-id cookie's existing setting.
- [x] Compound index `{ visitorId: 1, createdAt: -1 }` on `BookingRequest` — flagged as a follow-up when the guest-quota tiering shipped (2026-07-04); added 2026-07-11 (uncommitted), along with the same index on `Application` for its identical unindexed quota scan.

### Nice-to-haves
- [x] "Returning client" trust tier on `/hire` — shipped 2026-07-11 (uncommitted) as `hasCompletedProjectHistory()`: anyone (account holder or recognized anonymous visitor) with a `status: "completed"` booking is exempt from the guest submission quota and gets the same upload access as an approved request, without needing an account. See `Plans/journal.md`'s 2026-07-11 entry.

### Handoff
- [ ] Move Stripe off FatShew's own account onto the client's — payment processing is still running through FatShew's Stripe account even though the repo, Railway hosting, and Mongo are now on the client's own infra. Needs a client-owned Stripe account with fresh live/test API keys and webhook secret swapped into the `jarumiristudios` Railway service's `STRIPE_SECRET_KEY`/`STRIPE_WEBHOOK_SECRET` variables, plus the webhook endpoint re-pointed in Stripe's dashboard.

### Cloudflare R2 File Storage Migration
- [x] R2 bucket + scoped Account API token created, `R2_ACCOUNT_ID`/`S3_API`/`R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY`/`R2_BUCKET_NAME` set in `.env` (2026-07-09) — needs mirroring onto the Railway `jarumiristudios` service's Variables tab before any of this ships to production.
- [x] Shared file-metadata schema (`models/shared/fileMetadata.js`) with `storageKey`/`backend` fields, consumed by `BookingRequest.uploadedFiles`/`deliverableFiles` and `Message.attachment`/`attachments`.
- [x] R2 client (`lib/r2.js`) + custom multer storage engine (`lib/r2MulterStorage.js`) — all 4 multer instances (`upload`, `deliverableUpload`, `chatUpload`, `applicationUpload`) switched over. Originally flat `<crCode>/<storedName>` keys; unified (2026-07-12, see below) onto the same nested folder shape local disk uses.
- [x] Read path: `redirectToStoredFile()` (`server.js`, replaces the old `trySendStoredFile`) presign-redirects for `backend:"r2"` docs, falls back to the original local-disk lookup for pre-migration `backend:"local"` docs — both coexist during rollout.
- [x] Delete paths made R2-aware: `archiveAndWipeBookingFiles` now also wipes the booking's `<crCode>/` R2 prefix (`deleteObjectsByPrefix`, `lib/r2.js`); chat soft-delete and single-deliverable-delete branch on `backend` per file.
- [x] `scripts/migrate-uploads-to-r2.js` written (`upload`/`backfill`/`verify` phases, resumable via a local manifest) — **not yet run against production.**
- [x] Local dev storage backend (2026-07-12) — `STORAGE_BACKEND=local` (gitignored `.env` only, never in the deployed config) switches all 4 multer instances to `lib/localMulterStorage.js` instead of R2, so dev doesn't need live R2 credentials or hit R2's presigned-URL CORS restrictions.
- [x] Folder layout unified across both backends (2026-07-12, `e580943`) — `<crCode>/{raws,finals,chats/clients,chats/associate}`, replacing R2's flat keys and local disk's older type/staff-split nesting. "Save chat attachment to project" promotion now does a real R2 copy+delete (`moveStoredFile`/`copyObject`) instead of the old no-op DB update, since folder is part of the key now.
- [ ] `scripts/reorganize-r2-folders.js` written (2026-07-12, dry-run by default, `--execute` to run for real, `--crCode=X` to scope) to migrate pre-existing flat-keyed R2 objects onto the new nested scheme, updating each doc's `storageKey` — **not yet run against production.** Validated against the local dev DB and an isolated live-R2 test only; production's Mongo isn't reachable from this machine, so the real run has to happen wherever `MONGO_URI` points at production (same convention as `migrate-uploads-to-r2.js` below). Purely cosmetic — old flat-keyed docs keep resolving fine via their stored `storageKey` with or without this ever running.
- [ ] Mirror the 5 R2 env vars onto the Railway `jarumiristudios` service, deploy, then run the migration scripts directly on Railway (`railway run node scripts/migrate-uploads-to-r2.js upload`, then `backfill`, then `verify`; optionally `reorganize-r2-folders.js --execute` for folder tidiness).
- [ ] Bake period (a few days–two weeks of real traffic on the new read path) before removing any legacy local-disk code — the soft-archive/bulk-archive/restore routes (`server.js`, `fs.rename` on the whole booking folder) are deliberately untouched for now since they still matter for any file still on `backend:"local"`.
