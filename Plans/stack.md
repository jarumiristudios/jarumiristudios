# Tech Stack

## Backend
- **Runtime:** Node.js
- **Framework:** Express.js
- **Templating:** EJS
- **Styling:** Tailwind CSS v4

## Database
- **MongoDB Atlas** (free tier — 512MB)
- Managed via **Mongoose**
- Visualized locally with **MongoDB Compass**

## Authentication
- `bcrypt` for password hashing
- `express-session` for session management, backed by `connect-mongo` (`MongoStore`) instead of the default in-memory store — sessions survive server restarts/redeploys
- No third-party auth providers
- Three separate session flags: `req.session.isAdmin` (single shared password via `ADMIN_PASSWORD` env var, gates `/admin/*`), `req.session.userId` (per-client `User` account, gates `/dashboard/*`), and `req.session.associateId` (per-editor `Associate` account, bcrypt-hashed individually, gates `/associate/*`) — associates are superadmin-created only (`/admin/associates`), never self-signup
- Client accounts are optional — bookings can be submitted as a guest via `/hire` and tracked via `/track`; an account just links bookings to a persistent dashboard

## Associate Portal (Editors)
- Individual `Associate` accounts (name/email/password, `active` flag) sit alongside — not on top of — the client `User` model and the shared admin login, since the assignment/self-claim model needs to know *which* editor did what
- `BookingRequest.assignedTo` (ref `Associate`) — either self-claimed by an editor from the unassigned pool on `/associate` (atomic `findOneAndUpdate` keyed on `assignedTo: null`, avoids two editors racing the same booking) or set/reassigned by the superadmin from `admin/booking.ejs`
- `requireAssignedBooking` middleware scopes every `/associate/booking/:id/*` route to bookings currently assigned to that editor and not archived — an associate gets near-full parity with admin on their own assigned bookings (status changes, deliverables, Stripe invoices, chat) but no cross-project visibility and no archive/restore
- Deposit/final/revision Stripe invoice creation lives in shared functions (`createDepositInvoice`/`reissueDepositInvoice`/`createFinalInvoice`/`reissueFinalInvoice`/`createRevisionInvoice`, `server.js`) called by both the admin and associate route handlers, instead of being duplicated per portal
- `AssociateNotification` model (`assignment`/`payment`/`files_added`) mirrors the client/admin notification pattern — `/associate/notifications` + a 15s poll (`/api/associate/notifications/poll`) for a bell badge. That badge also folds in unread client messages on unassigned-but-chat-unlocked bookings (`unclaimedChatUnlockedBookingIds()`) so an unclaimed thread doesn't sit un-replied-to before anyone grabs it

## Careers / Job Applications
- `Role` model (title/description/requirements/active/order) drives the public `/career` page, replacing a pair of hardcoded homepage cards; managed via `/admin/roles`
- `Application` model — own `appCode` (same random-code pattern as a booking's `crCode`), optional `roleId` + a snapshotted `roleTitle` (survives the role posting being closed/deleted later), optional file upload (200MB cap, video/audio/image/PDF/archive)
- Rate-limited to 1 submission per rolling 24h per visitor cookie, unconditionally — unlike the booking-side guest quota, applicants have no account concept to key off instead

## Payments
- **Stripe** (no monthly fee — % per transaction only)
- Flow: **Stripe Invoices** (not Payment Links) — two invoices per project, plus optional ad-hoc revision invoices
  1. Admin accepts booking + sets agreed price and a deposit due date → server creates Stripe customer + sends 30% deposit invoice with that `due_date`
  2. Client pays → webhook fires `invoice.payment_succeeded` → booking moves to `in-progress`; admin can now set a delivery date
  3. Work delivered → admin sends 70% final invoice
  4. Client pays → webhook fires again → booking moves to `completed`
- **Revision invoices** — separate from the deposit/final pair, an admin can send any number of ad-hoc invoices for extra revision work (`revisionInvoices[]` on `BookingRequest`, admin-set amount defaulting to the `"Extra revision"` add-on price and an admin-picked due date), requires a Stripe customer to already exist (i.e. a deposit invoice has gone out at least once)
- Invoices chosen over Payment Links for: formal paper trail, line items, auto-reminders, professional appearance
- **Invoice expiry job** (`lib/invoiceExpiry.js`, renamed from `depositExpiry.js`) — in-process `setInterval`, runs hourly, no external cron dependency; three checks:
  - Deposit: auto-declines any `status: accepted` / `depositStatus: pending` booking whose `depositDueDate` has passed, voids the Stripe deposit invoice, archives it (`archived: true` + moves its upload folder), and emails client + admin.
  - Final: voids the Stripe final invoice for any `finalPaymentStatus: pending` booking whose `finalDueDate` has passed, resets `finalPaymentStatus`/`finalInvoiceId` (but leaves `finalDueDate` set, deliberately, as the anchor for the next check) so admin can send a fresh invoice, and emails client + admin. Does not touch `status` (project stays wherever it was, e.g. `in-progress`).
  - Stale-after-final-expiry (2026-07-11, uncommitted): if a `finalPaymentStatus: "none"` booking's (now-stale) `finalDueDate` is more than 3 days in the past with no fresh final invoice sent since, the project is auto-archived (same archive-folder-move as the deposit case) and both client + admin are emailed.
  Started from the `mongoose.connect().then()` callback in `server.js` so it only runs once the DB connection is live.
- **Stale-payment guard on the webhook** — `invoice.payment_succeeded` no longer blindly auto-progresses `status`. If the booking is `archived`, `declined`, or `paused` when a payment lands (e.g. an invoice that was still live when the project's state changed underneath it), the payment is still recorded (`depositStatus`/`finalPaymentStatus` → `paid`) but `status` is left alone and admin gets a distinct "payment on inactive project" alert (`sendAdminUnexpectedPaymentAlert`) instead of the normal one — so a stale-but-not-yet-expired link can't silently resurrect/complete a project nobody's tracking anymore.

## File Delivery
- Direct upload via `multer` on `/hire` — up to 250MB per file, 20 files per submission
- **Storage: Cloudflare R2** (S3-compatible object storage, `lib/r2.js`) — a custom multer storage engine (`lib/r2MulterStorage.js`) writes straight to R2 instead of local disk. Keys now mirror local disk's folder shape (2026-07-12, unified — `<crCode>/{raws,finals,chats/clients,chats/associate}/<storedName>`, replacing R2's originally-flat `<crCode>/<storedName>` scheme); `folder` stays a logical DB field (`raws`/`deliverables`/`chat`) decoupled from the physical path. Since folder is part of the key now, promoting a chat attachment to project files (`moveStoredFile`) does a real R2 copy+delete rather than a DB-only update. `scripts/reorganize-r2-folders.js` (dry-run by default) migrates pre-existing flat-keyed R2 objects onto the new scheme — **not yet run against production**; old flat keys keep resolving fine regardless since every read/delete path uses each doc's stored `storageKey` directly
- Local dev: `STORAGE_BACKEND=local` (gitignored `.env`) switches all uploads to disk via `lib/localMulterStorage.js` instead of R2 — avoids needing live R2 credentials or hitting R2's presigned-URL CORS restrictions locally; never set in the deployed environment
- Reads go through short-lived presigned URLs (`redirectToStoredFile()` in `server.js`) rather than proxying bytes through Express — supports Range requests for video scrubbing natively
- A `backend: "local"|"r2"` field on every file-metadata record (shared shape in `models/shared/fileMetadata.js`) lets old (pre-migration) local-disk files and new R2 files coexist during the phased rollout — see `Plans/july26-milestone.md`'s Handoff section for migration status
- Client-initiated hard-delete (`POST /dashboard/booking/:id/delete`, account delete) wipes raw uploads and chat attachments but **spares delivered final files** — `hardDeleteBookingFiles` skips the local `deliverables` subfolder and `deleteObjectsByPrefixExcept` (`lib/r2.js`) excludes their R2 keys from the batch-delete, so there's still a record of what was actually handed over even after a client deletes everything else
- Users can also paste media links (YouTube, Google Drive, Dropbox, etc.) for content already hosted elsewhere
- Telegram handle is an optional fallback field for files too large for the 250MB upload limit

## Email
- **Resend** (HTTPS API, `lib/mailer.js`) — Railway blocks outbound raw SMTP, so Gmail SMTP via Nodemailer (the original choice) never actually delivered from production even after forcing IPv4 routing; Resend sidesteps the port block entirely. Domain `jarumiristudios.com` is verified on Resend so `MAIL_FROM` sends as an on-domain address.
- All 14 templates share a branded table-based HTML layout (dark header, amber accents, pill buttons, code chips, detail tables) — table-based specifically for compatibility with email clients (Outlook etc.) that don't reliably support modern CSS layout in HTML mail.
- Transactional emails: booking confirmation (client), new booking alert (admin), acceptance email (client, sent alongside the deposit invoice), invoice-sent alert (admin), payment-confirmed alert (admin), deposit-expired notice (client) + auto-decline alert (admin) from the deposit expiry job, password reset
- Client "nudge admin" no longer sends an email (see In-app Notifications (Admin) below) — `sendAdminNudgeAlert` was removed from `lib/mailer.js`

## In-app Notifications (Client)
- `Notification` model (Mongoose) — one doc per event (`status_change`, `invoice_sent`, `payment_confirmed`, `project_dismissed`), tied to a `userId` + `bookingId`
- Only created for bookings linked to a client account (`clientId` set) — guest-only bookings rely on email instead
- `/dashboard/notifications` page + lightweight polling endpoint (`/api/notifications/poll`) for a live unread badge

## In-app Notifications (Admin)
- `AdminNotification` model (Mongoose) — one doc per event (`type` enum, currently only `"nudge"`), `bookingId`, `crCode`, `message`, `read`
- Replaces the old email-based nudge alert: `POST /dashboard/booking/:id/nudge` creates an `AdminNotification` instead of emailing; rate-limited to 3 per booking per rolling hour (`429` past that)
- `/admin/notifications` page (marks all read on view) + `/api/admin/notifications/poll` for a bell badge that polls every 15s and toasts new nudges; wired into every admin view via a shared `views/admin/_notif-poll.ejs` partial and an `app.use("/admin", ...)` middleware that injects `res.locals.adminUnreadCount`

## Coupons
- `Coupon` model — code, `discountType` (percent/fixed), `discountValue`, optional `expiresAt`, `active` flag
- Validated both client-side (AJAX on `/hire`) and server-side (re-checked on submit) before being applied to a booking's subtotal

## Hosting
- **Railway.app** (free tier)
- MongoDB stays on Atlas (not self-hosted)

## Why these choices
- Zero monthly cost for a hobby/test project
- No data in third-party hands except Atlas (acceptable tradeoff for uptime)
- Simple stack — no React, no build pipeline complexity
- Can upgrade any piece independently when the project grows
