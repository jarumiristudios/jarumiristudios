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
- Two separate session flags: `req.session.isAdmin` (single shared password via `ADMIN_PASSWORD` env var, gates `/admin/*`) and `req.session.userId` (per-client `User` account, gates `/dashboard/*`)
- Client accounts are optional — bookings can be submitted as a guest via `/hire` and tracked via `/track`; an account just links bookings to a persistent dashboard

## Payments
- **Stripe** (no monthly fee — % per transaction only)
- Flow: **Stripe Invoices** (not Payment Links) — two invoices per project
  1. Admin accepts booking + sets agreed price and a deposit due date → server creates Stripe customer + sends 30% deposit invoice with that `due_date`
  2. Client pays → webhook fires `invoice.payment_succeeded` → booking moves to `in-progress`; admin can now set a delivery date
  3. Work delivered → admin sends 70% final invoice
  4. Client pays → webhook fires again → booking moves to `completed`
- Invoices chosen over Payment Links for: formal paper trail, line items, auto-reminders, professional appearance
- **Invoice expiry job** (`lib/invoiceExpiry.js`, renamed from `depositExpiry.js`) — in-process `setInterval`, runs hourly, no external cron dependency; two checks:
  - Deposit: auto-declines any `status: accepted` / `depositStatus: pending` booking whose `depositDueDate` has passed, voids the Stripe deposit invoice, and emails client + admin.
  - Final: voids the Stripe final invoice for any `finalPaymentStatus: pending` booking whose `finalDueDate` has passed, resets `finalPaymentStatus`/`finalInvoiceId`/`finalDueDate` so admin can send a fresh invoice, and emails client + admin. Does not touch `status` (project stays wherever it was, e.g. `in-progress`).
  Started from the `mongoose.connect().then()` callback in `server.js` so it only runs once the DB connection is live.
- **Stale-payment guard on the webhook** — `invoice.payment_succeeded` no longer blindly auto-progresses `status`. If the booking is `archived`, `declined`, or `paused` when a payment lands (e.g. an invoice that was still live when the project's state changed underneath it), the payment is still recorded (`depositStatus`/`finalPaymentStatus` → `paid`) but `status` is left alone and admin gets a distinct "payment on inactive project" alert (`sendAdminUnexpectedPaymentAlert`) instead of the normal one — so a stale-but-not-yet-expired link can't silently resurrect/complete a project nobody's tracking anymore.

## File Delivery
- Direct upload via `multer` on `/hire` — up to 250MB per file, 20 files per submission
- **Storage: Cloudflare R2** (S3-compatible object storage, `lib/r2.js`) — a custom multer storage engine (`lib/r2MulterStorage.js`) writes straight to R2 instead of local disk. Keys are flat (`<crCode>/<storedName>`); folder/category (`video`/`audio`/`image`/`other`/`deliverables`/`chat`) is a Mongo metadata field, never encoded in the key
- Reads go through short-lived presigned URLs (`redirectToStoredFile()` in `server.js`) rather than proxying bytes through Express — supports Range requests for video scrubbing natively
- A `backend: "local"|"r2"` field on every file-metadata record (shared shape in `models/shared/fileMetadata.js`) lets old (pre-migration) local-disk files and new R2 files coexist during the phased rollout — see `Plans/july26-milestone.md`'s Handoff section for migration status
- Users can also paste media links (YouTube, Google Drive, Dropbox, etc.) for content already hosted elsewhere
- Telegram handle is an optional fallback field for files too large for the 250MB upload limit

## Email
- **Nodemailer** via Gmail SMTP (`PERSONAL_GMAIL` + app password)
- Transactional emails: booking confirmation (client), new booking alert (admin), acceptance email (client, sent alongside the deposit invoice), invoice-sent alert (admin), payment-confirmed alert (admin), deposit-expired notice (client) + auto-decline alert (admin) from the deposit expiry job
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
