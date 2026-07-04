# Pages & Routes

## Public (no login required)

| Route | Page | Purpose |
|-------|------|---------|
| `/` | Landing | Hero, reel, services, in-page `#pricing` section (Clip/Scene/Feature/Custom + add-ons), about, footer — no standalone `/pricing` route |
| `/hire` | Request Form | Name, location, email, Telegram (optional, for large file transfers), services, pricing tier + add-ons, coupon code, project brief, media links, direct file upload (≤250MB, ≤20 files) |
| `GET /hire/success` | Post-submit | Shown to guests after submitting; offers inline account creation to track the booking going forward |
| `POST /hire/coupon/validate` | — | AJAX coupon validation for the `/hire` form |
| `POST /signup` | — | Inline signup from `/hire/success` — creates a `User`, links the just-submitted booking via `crCode`, logs in |
| `/track` | Project Tracker | Look up a booking by BR code or name + email combo; shows deposit due date notice while `depositStatus` is `pending`, estimated delivery date once admin sets it, and final deliverable downloads once `status === "completed"` |
| `GET /track/:crCode/deliverables/:filename` | — | Public deliverable download — no session, gated on `status === "completed"` and the file belonging to that `crCode` (same trust model as the rest of `/track`: the BR code is the bearer token) |
| `/login` | Client Login | Existing client login; supports `?next=` redirect and `?cr=` to link a just-submitted booking on login |

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
| `/dashboard/account` | Account Settings | Edit profile (name, location, Telegram, account type, external link), change password, delete account |

## Admin (restricted to owner)

| Route | Page | Purpose |
|-------|------|---------|
| `/admin/login` / `/admin/logout` | — | Single shared admin password (`ADMIN_PASSWORD` env var), session-based |
| `/admin/notifications` | Admin Notifications | Latest 200 `AdminNotification` records (currently nudges only); marks all read on view; bell badge + 15s poll + toast on every other admin page via `_notif-poll.ejs` partial |
| `GET /api/admin/notifications/poll` | — | Polling endpoint for live unread badge + new items since a timestamp (`?since=<ms>`) |
| `POST /api/admin/notifications/mark-read` | — | Marks all admin notifications read (JSON response) |
| `/admin` | Admin Dashboard | Active/Archived tab (`?view=archived`) bookings, server-side paginated (30/page) with debounced search (`q`/`field` query params) and status filter pills, total/pending counts |
| `/admin/booking/:id` | Booking Detail | Full booking info, status picker, admin notes, payment card (deposit due date, delivery date once paid), media links, revision list (mark reviewed) |
| `POST /admin/booking/:id/status` | — | Update booking status + create client notification (special-cased message for `declined`) |
| `POST /admin/booking/:id/notes` | — | Append an admin note (`adminNotes` array, admin-only, not client-visible) |
| `POST /admin/booking/:id/notes/:noteId/edit` | — | Edit the text of an existing admin note |
| `POST /admin/booking/:id/notes/:noteId/delete` | — | Remove an admin note |
| `POST /admin/booking/:id/send-deposit` | — | Create/reuse Stripe customer, send 30% deposit invoice with an admin-set due date (`due_date`), flips status to `accepted`, sends acceptance email |
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
| `POST /webhooks/stripe` | — | Stripe webhook (raw body, signature-verified) — advances `depositStatus`/`finalPaymentStatus` on `invoice.payment_succeeded`, flips booking status, notifies client + admin |

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
           Client pays deposit before due date (Stripe webhook) → status → in-progress,
           admin can now set a delivery date (shown on /track)
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
