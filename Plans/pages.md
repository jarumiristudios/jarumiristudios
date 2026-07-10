# Pages & Routes

## Public (no login required)

| Route | Page | Purpose |
|-------|------|---------|
| `/` | Landing | Hero, reel, services, in-page `#pricing` section (Clip/Scene/Feature/Custom + add-ons), about, footer — no standalone `/pricing` route |
| `/hire` | Request Form | Name, location, email, client type (Independent Creator/Agency/Studio/Brand-Business/Other, required), 1–3 required external platform links (Instagram/Twitter/TikTok/OnlyFans/Fansly/Fanview/MannyVids/Pornhub/Other), services, pricing tier + add-ons, coupon codes (up to 3, stackable/compounding), project brief, media links (only shown once upload-trusted), direct file upload gated on `hasTrustedDepositHistory` (a prior paid booking) — untrusted first-time clients submit with no direct upload at all, large files go through Messages post-signup instead |
| `GET /hire/success` | Post-submit | Shown to guests after submitting; offers inline account creation to track the booking going forward |
| `POST /hire/coupon/validate` | — | AJAX coupon validation for the `/hire` form |
| `POST /signup` | — | Inline signup from `/hire/success` — creates a `User`, links the just-submitted booking via `crCode`, logs in |
| `/track` | Project Tracker | Look up a booking by BR code or name + email combo; shows deposit due date notice while `depositStatus` is `pending`, estimated delivery date once admin sets it, and final deliverable downloads once `status === "completed"` |
| `GET /track/:crCode/deliverables/:filename` | — | Public deliverable download — no session, gated on `status === "completed"` and the file belonging to that `crCode` (same trust model as the rest of `/track`: the BR code is the bearer token) |
| `/login` | Client Login | Existing client login; supports `?next=` redirect and `?cr=` to link a just-submitted booking on login |
| `/forgot-password` | Forgot Password | Requests a reset link by email; always renders the same neutral "submitted" response regardless of whether the email matches an account, to avoid leaking account existence |
| `/reset-password/:token` | Reset Password | Sets a new password from a mailed reset link; token is looked up by its sha256 hash with a 1-hour TTL (`PasswordResetToken` model) |

## Authenticated (client login required)

| Route | Page | Purpose |
|-------|------|---------|
| `/dashboard` | Client Dashboard | All submitted requests, statuses, payment progress |
| `/dashboard/new` | New Project | Gated on profile completeness (name + location) before letting a client start a fresh `/hire` submission |
| `/dashboard/booking/:id` | Booking Detail | Full detail of one request; client can submit revision requests, delete the project |
| `POST /dashboard/booking/:id/revision` | — | Client submits a revision request message on their booking |
| `POST /dashboard/booking/:id/pause` | — | Client pauses their project (`status: "paused"`); emails admin via `sendAdminPauseAlert`; blocked once already declined/completed/paused/archived |
| `POST /dashboard/booking/:id/nudge` | — | Client asks for an update; creates an `AdminNotification` (`type: "nudge"`) instead of emailing; rate-limited to 3 per booking per rolling hour (`429` JSON error past that) |
| `POST /dashboard/booking/:id/delete` | — | Client hard-delete: permanently removes the booking's `files/` folder via `hardDeleteBookingFiles()`, clears `uploadedFiles`, sets `filesDeleted: true` and `archived: true` (also moves the now-empty booking folder into `uploads/_archive/`); DB row and `booking.txt` are kept |
| `/dashboard/gallery` | File Gallery | Browse uploaded files across all of the client's projects, sortable newest/oldest |
| `GET /dashboard/uploads/:filename` | — | Protected file serving for the owning client only |
| `GET /dashboard/deliverables/:filename` | — | Final deliverable download for the owning client only, gated on `status === "completed"` |
| `/dashboard/notifications` | Notifications | In-app alerts (status changes, invoices sent, payments confirmed, project dismissed); marks all read on view |
| `POST /dashboard/notifications/mark-all-read` | — | Marks all notifications read, redirects back to the notifications page |
| `GET /api/notifications/poll` | — | Polling endpoint for live unread count + new items since a timestamp |
| `POST /api/notifications/mark-read` | — | Marks all notifications read (JSON response, used by poll-driven UI) |
| `/dashboard/account` | Account Settings | Edit profile (name, location, account type, external website/portfolio link — both optional, distinct from the per-booking `clientType`/`platforms` collected on `/hire`), change password, delete account |
| `/dashboard/messages` | Messages Inbox | List of every project thread with unread indicators, sorted by most recent activity |
| `/dashboard/messages/:id` | Project Thread | Real-time chat (Socket.IO) with admin on one booking; full page normally, thread-panel partial only on `X-Requested-With: XMLHttpRequest` (SPA-style thread switching); composer disabled with an explanatory placeholder until `chatUnlocked` |
| `POST /dashboard/messages/:id` | — | Send a chat message; up to 10 attachments and/or tagged existing project files per message; broadcasts `new-message` to the booking's socket room; 403s if the booking isn't `chatUnlocked` yet |
| `GET /dashboard/messages/attachments/:filename` | — | Owning-client-only chat attachment download/view |
| `POST /dashboard/messages/:id/:messageId/delete` | — | Soft-delete a message the client sent (clears body/attachments, tombstones the row); tagged project-file references are left untouched on disk |

## Admin (restricted to owner)

| Route | Page | Purpose |
|-------|------|---------|
| `/admin/login` / `/admin/logout` | — | Single shared admin password (`ADMIN_PASSWORD` env var), session-based |
| `/admin/notifications` | Admin Notifications | Latest 200 `AdminNotification` records (`nudge`, `payment`, `new_booking`); marks all read on view; bell badge + 15s poll + toast on every other admin page via `_notif-poll.ejs` partial |
| `GET /api/admin/notifications/poll` | — | Polling endpoint for live unread badge + new items since a timestamp (`?since=<ms>`) |
| `POST /api/admin/notifications/mark-read` | — | Marks all admin notifications read (JSON response) |
| `/admin` | Admin Dashboard | Active/Archived tab (`?view=archived`) bookings, server-side paginated (30/page) with debounced search (`q`/`field` query params) and status filter pills, total/pending counts |
| `/admin/booking/:id` | Booking Detail | Full booking info, status picker, admin notes, payment card (deposit due date, delivery date once paid), media links, revision list (mark reviewed) |
| `POST /admin/booking/:id/status` | — | Update booking status + create client notification (special-cased message for `declined`); server-enforced status gate (`isStatusChangeAllowed`) — `completed`/`declined` are terminal, forward moves capped at one step, backward moves and `declined` always allowed, `paused` only from `in-progress` |
| `POST /admin/booking/:id/notes` | — | Append an admin note (`adminNotes` array, admin-only, not client-visible) |
| `POST /admin/booking/:id/notes/:noteId/edit` | — | Edit the text of an existing admin note |
| `POST /admin/booking/:id/notes/:noteId/delete` | — | Remove an admin note |
| `POST /admin/booking/:id/send-deposit` | — | Create/reuse Stripe customer, send 30% deposit invoice with an admin-set due date (`due_date`), flips status to `accepted`, sends acceptance email; blocked (redirects with an error) while `status === "pending"` — booking must reach `in-review` first so the client gets a window to upload files before seeing a payment ask |
| `POST /admin/booking/:id/deposit-due-date` | — | Update (or clear) the deposit due date while `depositStatus === "pending"` |
| `POST /admin/booking/:id/delivery-date` | — | Set/clear the estimated delivery date, only allowed once `depositStatus === "paid"` |
| `POST /admin/booking/:id/send-final` | — | Send 70% final invoice once deposit is paid |
| `POST /admin/booking/:id/archive` / `POST /admin/bookings/bulk-archive` | — | Archive: sets `archived: true`, moves the booking's upload folder to `uploads/_archive/`, notifies client |
| `POST /admin/booking/:id/restore` | — | Un-archives a booking and moves its folder back out of `uploads/_archive/` |
| `POST /admin/booking/:id/revision/:revId/reviewed` | — | Marks a single client revision request as reviewed |
| `POST /admin/booking/:id/deliverables` | — | Upload finished output files (separate `multer` storage, `uploads/<crCode>/files/deliverables/`); notifies the client immediately if the project is already `completed` |
| `POST /admin/booking/:id/deliverables/:fileId/delete` | — | Remove a single deliverable file from disk and the booking record |
| `GET /admin/uploads/:filename` | — | Protected file serving (checks active and `_archive` paths, and both `uploadedFiles`/`deliverableFiles`); images inline, video/audio in-browser, download for all |
| `/admin/coupons` | Coupon Manager | List/create/toggle-active/delete coupon codes (percent or fixed discount, optional expiry) |
| `/admin/messages` | Messages Inbox | List of every project thread (one row per booking with a linked client) with unread indicators |
| `/admin/messages/:id` | Project Thread | Real-time chat (Socket.IO) with the client on one booking; full page normally, thread-panel partial only on `X-Requested-With: XMLHttpRequest`; composer disabled until `chatUnlocked` |
| `POST /admin/booking/:id/messages` | — | Send a chat message; up to 10 attachments and/or tagged existing project files (`uploadedFiles`/unlocked `deliverableFiles`) per message; 403s if the booking isn't `chatUnlocked` yet |
| `GET /admin/messages/attachments/:filename` | — | Admin-only chat attachment download/view |
| `POST /admin/booking/:id/messages/:messageId/delete` | — | Soft-delete a message admin sent |
| `POST /webhooks/stripe` | — | Stripe webhook (raw body, signature-verified) — advances `depositStatus`/`finalPaymentStatus` on `invoice.payment_succeeded`; deposit payment no longer auto-flips `status` (admin confirms manually, prompted by a `payment` `AdminNotification`); final payment still flips `status` to `completed`; notifies client + admin |

## Real-Time Messaging (Socket.IO)

Chat is a separate system from the `/dashboard`/`/admin` in-app `Notification`/`AdminNotification` alert feeds — it lives entirely under its own `/messages` inbox pages (not embedded on `dashboard-booking.ejs`/`admin/booking.ejs`), backed by a `Message` model (one document per chat message). Socket.IO rooms are scoped per booking (`project:<bookingId>`), authorized once at connect (admin: booking exists; client: owns booking); sending itself still goes through a normal session-checked HTTP POST (multer needs a real request to parse attachments) — the socket only broadcasts the saved message (`new-message` event) to whoever has that thread open. Unread-message badges are piggybacked onto the existing 15s notification-poll endpoints (`/api/notifications/poll`, `/api/admin/notifications/poll`) via a `messageItems` array, rather than a separate polling channel or persisted `Notification` documents.

Chat is gated behind the `chatUnlocked` virtual on `BookingRequest` (`accepted`/`in-progress`/`completed`/`paused` — not `pending`/`in-review`/`declined`), enforced on both send routes (403 if locked) and reflected in both thread panels (disabled composer, explanatory placeholder) and both list views (locked-state row copy instead of "No messages yet.").

## User Flow

```
Landing (#pricing) → /hire → Submit request (guest or logged-in client)
                       │
        guest ─────────┴───────────────────────── logged-in client
        → /hire/success (optional inline signup,    → /dashboard?submitted=<crCode>
          links booking to new account)                (booking auto-linked to account)
                       ↓
           Admin reviews in /admin → sets price + deposit due date → sends 30% deposit invoice via Stripe
           (status → accepted, acceptance email sent)
                       ↓
           Client pays deposit before due date (Stripe webhook) → depositStatus → paid,
           admin gets a "payment" AdminNotification and manually moves status → in-progress
           (status no longer auto-advances on payment); admin can now set a delivery date
           (shown on /track) — status is gated: forward moves capped at one step at a time
             — if unpaid past the due date, an hourly job (lib/invoiceExpiry.js) auto-declines
               the booking, voids the invoice, and emails client + admin instead
                       ↓
           Admin does the work → client may request revisions from /dashboard/booking/:id
                       ↓
           Admin sets a final due date → sends 70% final invoice via Stripe
             — if unpaid past that date, the same hourly job voids the invoice, resets
               finalPaymentStatus so a fresh one can be sent, and emails client + admin
               (status is left alone — project isn't declined, just unpaid)
                       ↓
           Client pays final (Stripe webhook) → status → completed
                       ↓
           Admin uploads finished output on /admin/booking/:id → client notified,
           downloads it from /track or /dashboard/booking/:id (gated on status === completed)
                       ↓
           Client tracks progress any time via /track (BR code or name + email),
           or via /dashboard if they have an account
                       ↓
           Admin may archive a booking (unclutters /admin, files moved to _archive/,
           restorable) — separate from a client permanently deleting their own files
```
