# July 2026 Milestone

## Pending

- [ ] Add `og:image` and `twitter:image` meta tags — needs a logo or cover image asset first (deferred from June)

### Security/Reliability
- [x] Brute-force protection on `/login` and `/admin/login` — added a `LoginAttempt` collection (TTL-indexed) tracking failed attempts in a 15-minute rolling window, capped at 5, same DB-backed pattern as `enforceGuestSubmissionQuota`/the nudge limiter. `/login` keys on the attempted email; `/admin/login` has no email, so it keys on the `jrmr_vid` visitor cookie instead (deliberately not IP — this app doesn't set `trust proxy` behind Railway, so `req.ip` would resolve to the proxy for everyone).
- [x] Password reset flow for client accounts — shipped in `792192e` (forgot/reset password flow, trust proxy for prod cookies).
- [x] Harden session cookie config — `express-session`'s `secret` still falls back to a hardcoded `"jarumiri-dev-secret"` (`server.js:212`) if `SESSION_SECRET` isn't set, but that's confirmed set on the live Railway service. `secure` (`server.js:218`) was silently `false` in production because the Railway env var was misnamed `MODE_ENV` instead of `NODE_ENV` — fixed by renaming the Railway variable (2026-07-09). `sameSite: "lax"` added explicitly (`server.js:219`, 2026-07-09), matching the visitor-id cookie's existing setting.
- [ ] Compound index `{ visitorId: 1, createdAt: -1 }` on `BookingRequest` — flagged as a follow-up when the guest-quota tiering shipped (2026-07-04); the guest-submission-quota `exists()` check is currently an unindexed scan.

### Nice-to-haves
- [ ] "Returning client" trust tier on `/hire` — a third tier between guest and full account holder (e.g. ≥1 completed project gets guest-like users more room than the base 3-file/25MB cap) — discussed and explicitly deferred when the two-tier guest/account system shipped.

### Handoff
- [ ] Move Stripe off FatShew's own account onto the client's — payment processing is still running through FatShew's Stripe account even though the repo, Railway hosting, and Mongo are now on the client's own infra. Needs a client-owned Stripe account with fresh live/test API keys and webhook secret swapped into the `jarumiristudios` Railway service's `STRIPE_SECRET_KEY`/`STRIPE_WEBHOOK_SECRET` variables, plus the webhook endpoint re-pointed in Stripe's dashboard.

### Cloudflare R2 File Storage Migration
- [x] R2 bucket + scoped Account API token created, `R2_ACCOUNT_ID`/`S3_API`/`R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY`/`R2_BUCKET_NAME` set in `.env` (2026-07-09) — needs mirroring onto the Railway `jarumiristudios` service's Variables tab before any of this ships to production.
- [x] Shared file-metadata schema (`models/shared/fileMetadata.js`) with `storageKey`/`backend` fields, consumed by `BookingRequest.uploadedFiles`/`deliverableFiles` and `Message.attachment`/`attachments`.
- [x] R2 client (`lib/r2.js`) + custom multer storage engine (`lib/r2MulterStorage.js`, flat `<crCode>/<storedName>` keys — images buffered for blur-preview generation, everything else streamed) — all 3 multer instances (`upload`, `deliverableUpload`, `chatUpload`) switched over.
- [x] Read path: `redirectToStoredFile()` (`server.js`, replaces the old `trySendStoredFile`) presign-redirects for `backend:"r2"` docs, falls back to the original local-disk lookup for pre-migration `backend:"local"` docs — both coexist during rollout.
- [x] Delete paths made R2-aware: `archiveAndWipeBookingFiles` now also wipes the booking's `<crCode>/` R2 prefix (`deleteObjectsByPrefix`, `lib/r2.js`); chat soft-delete and single-deliverable-delete branch on `backend` per file.
- [x] `scripts/migrate-uploads-to-r2.js` written (`upload`/`backfill`/`verify` phases, resumable via a local manifest) — **not yet run against production.**
- [ ] Mirror the 5 R2 env vars onto the Railway `jarumiristudios` service, deploy, then run the migration script directly on Railway (`railway run node scripts/migrate-uploads-to-r2.js upload`, then `backfill`, then `verify`).
- [ ] Bake period (a few days–two weeks of real traffic on the new read path) before removing any legacy local-disk code — the soft-archive/bulk-archive/restore routes (`server.js`, `fs.rename` on the whole booking folder) are deliberately untouched for now since they still matter for any file still on `backend:"local"`.
