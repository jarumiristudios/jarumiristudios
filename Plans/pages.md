# Pages & Routes

## Public (no login required)

| Route | Page | Purpose |
|-------|------|---------|
| `/` | Landing | Hero, reel, services, in-page `#pricing` section (Clip/Scene/Feature/Custom + add-ons), about, footer — no standalone `/pricing` route; "Careers" nav link points at `/career` (the old hardcoded `#career` homepage section was removed) |
| `/career` | Careers | DB-driven list of open `Role` postings; each card (and a generic "apply anyway" prompt) opens a shared application modal (`views/_application-modal.ejs`) — Name/Email/Message/optional file (up to 200MB, video/audio/image/PDF/archive) — posting to `POST /career/apply` |
| `/terms` | Terms of Service | Static legal page (`e496739`) — pricing/deposit/revision/final-payment terms, account & deletion behavior, content ownership rules, privacy, refunds, liability, governing law (jurisdiction placeholder, not yet filled in); sticky searchable table of contents with scroll-spy; linked from the footer on `/` and `/career` |
| `POST /career/apply` | — | Creates an `Application` (own `appCode`, same random-code pattern as a booking's `crCode`); rate-limited to 1 per rolling 24h per visitor cookie regardless of login state (applicants have no account concept); emails admin via `sendAdminNewApplicationAlert` |
| `/hire` | Request Form | Name, location, email, client type (Independent Creator/Agency/Studio/Brand-Business/Other, required), 1–3 required external platform links (Instagram/Twitter/TikTok/OnlyFans/Fansly/Fanview/MannyVids/Pornhub/Other), services, pricing tier + add-ons, coupon codes (up to 3, stackable/compounding), required ToS checkbox + optional email-updates consent checkbox (`tosAgreed`/`emailConsent`, both rejected/recorded server-side, 2026-07-12), project brief, media links (only shown once upload-trusted), direct file upload gated on `hasTrustedDepositHistory` (a prior paid booking) — untrusted first-time clients submit with no direct upload at all, large files go through Messages post-signup instead. Client type and platform links are editable widgets for guests, but for a logged-in client who's already saved them to their `User` account (see `/dashboard/account`) they're carried through as locked hidden inputs instead of re-asked. A logged-in account with an unused, unexpired signup discount (see `/signup` below) auto-applies it as a `WELCOME` coupon on submit and shows a "welcome discount" badge; a logged-out visitor instead sees a persistent "Get 15% off" incentive card on the price-estimate box (2026-07-12) |
| `GET /hire/success` | Post-submit | Shown to guests after submitting; offers inline account creation to track the booking going forward — the offer shows a live "Save $X on this project" preview (`signupDiscountPreview`, `bddbf7f`) when the triggering booking is still eligible for the signup discount to apply retroactively (see `/signup`) |
| `POST /hire/coupon/validate` | — | AJAX coupon validation for the `/hire` form |
| `POST /signup` | — | Inline signup, embedded on both `/hire/success` and `/track` (2026-07-11) — creates a `User`, links the relevant booking via `crCode`, logs in; redirects back to whichever page it was submitted from via a whitelisted `returnTo` field. If the booking is already linked to an account (`clientId` set), redirects to `/login?cr=` instead of processing signup at all (`ebb5766`) — prevents the same booking being repeatedly re-signed-up-for with fresh emails to hijack it and stack extra discount. Grants a one-time 15%-off "welcome discount" (`User.discountPercent`/`discountExpiresAt`, 15-day window, `ce11320`) to genuinely first-time emails only — an email with *any* prior `BookingRequest` under it, paid or not, account-linked or not, declined or not, doesn't get a second discount (`4db3d62`, broadened `ebb5766`) — normally redeemable on a later `/hire` submission, but if the triggering booking hasn't been priced yet (`!agreedPrice`) the discount is applied to it directly instead (retroactive application, `bddbf7f`), which is what actually makes it an acquisition incentive rather than a reward for some hypothetical next project. An hourly job (`lib/discountExpiry.js`) emails + in-app-notifies accounts whose unused discount is expiring within 3 days |
| `/track` | Project Tracker | Look up a booking by BR code or name + email combo; a standalone "Already have an account? Log In" card (`/login?next=/dashboard`) renders above the lookup forms regardless of whether a lookup has happened (2026-07-13, uncommitted). Once a booking is looked up: deposit due date notice while `depositStatus` is `pending`, estimated delivery date once admin sets it, and final deliverable downloads once `status === "completed"`. An unlinked booking (no `clientId`) also shows an account nudge (2026-07-11) — inline signup (with the same live signup-discount preview as `/hire/success`, `bddbf7f`), or a "log in to link" prompt if an account already exists for that email |
| `GET /track/:crCode/deliverables/:filename` | — | Public deliverable download — no session, gated on `status === "completed"` and the file belonging to that `crCode` (same trust model as the rest of `/track`: the BR code is the bearer token) |
| `/login` | Client Login | Existing client login; supports `?next=` redirect and `?cr=` to link a just-submitted booking on login |
| `/forgot-password` | Forgot Password | Requests a reset link by email; always renders the same neutral "submitted" response regardless of whether the email matches an account, to avoid leaking account existence |
| `/reset-password/:token` | Reset Password | Sets a new password from a mailed reset link; token is looked up by its sha256 hash with a 1-hour TTL (`PasswordResetToken` model) |

## Authenticated (client login required)

| Route | Page | Purpose |
|-------|------|---------|
| `/dashboard` | Client Dashboard | All submitted requests, statuses, payment progress |
| `/dashboard/new` | New Project | Gated on profile completeness (name, location, client type, and 1–3 platform links) before letting a client start a fresh `/hire` submission — client type/platforms are asked once here and then reused (locked) on every future submission instead of being re-collected per project. Same required ToS + optional email-updates consent checkboxes as `/hire` (2026-07-12), and shows the same "welcome discount" badge when eligible |
| `/dashboard/booking/:id` | Booking Detail | Full detail of one request; client can submit revision requests, delete the project; sidebar has a Messages card (links to the thread, unread-count badge) once `chatUnlocked` |
| `POST /dashboard/booking/:id/revision` | — | Client submits a revision request message on their booking |
| `POST /dashboard/booking/:id/pause` | — | Client pauses their project (`status: "paused"`); emails admin via `sendAdminPauseAlert`; blocked once already declined/completed/paused/archived |
| `POST /dashboard/booking/:id/nudge` | — | Client asks for an update; creates an `AdminNotification` (`type: "nudge"`) instead of emailing; rate-limited to 3 per booking per rolling hour (`429` JSON error past that) |
| `POST /dashboard/booking/:id/delete` | — | Client hard-delete: permanently removes the booking's raw uploads and chat attachments via `hardDeleteBookingFiles()`/`archiveAndWipeBookingFiles()`, clears `uploadedFiles`, sets `filesDeleted: true` and `archived: true` (also moves the booking folder into `uploads/_archive/`); DB row, `booking.txt`, and any delivered **`deliverableFiles`** are kept — only client-submitted content is wiped |
| `/dashboard/gallery` | File Gallery | Browse uploaded files across all of the client's projects — per-project card grid by default, or a flat file-grid view scoped to one type (video/audio/image/other) via a filter dropdown (replaced the old pill-button row; sort-by-oldest removed) |
| `GET /dashboard/uploads/:filename` | — | Protected file serving for the owning client only |
| `GET /dashboard/deliverables/:filename` | — | Final deliverable download for the owning client only, gated on `status === "completed"` |
| `/dashboard/notifications` | Notifications | In-app alerts (status changes, invoices sent, payments confirmed, project dismissed); marks all read on view; search bar + date-range/type filter dropdown (`9f74f49`) |
| `/dashboard/invoices` | Invoices | Every deposit/final/revision invoice across all of a client's projects, flattened into one list (`9f74f49`) — project code, status pill, due date, amount, Pay now/View link to the Stripe-hosted invoice; search by project code + status filter dropdown |
| `POST /dashboard/notifications/mark-all-read` | — | Marks all notifications read, redirects back to the notifications page |
| `GET /api/notifications/poll` | — | Polling endpoint for live unread count + new items since a timestamp |
| `POST /api/notifications/mark-read` | — | Marks all notifications read (JSON response, used by poll-driven UI) |
| `/dashboard/account` | Account Settings | Edit profile — name, location, client type, and 1–3 external platform links (`User.clientType`/`User.platforms`, the same fields collected once via the `/dashboard/new` gate and then reused/locked on every booking form), a notification-preferences toggle (`POST /dashboard/account/notifications`, gates non-essential reminder/status/promo emails — transactional email is unaffected, 2026-07-12), change password, delete account |
| `/dashboard/messages` | Messages Inbox | List of every project thread with at least one message, with unread indicators, sorted by most recent activity; search bar + read-state/project-status filter dropdown |
| `/dashboard/messages/:id` | Project Thread | Real-time chat (Socket.IO) with admin on one booking; full page normally, thread-panel partial only on `X-Requested-With: XMLHttpRequest` (SPA-style thread switching); composer disabled with an explanatory placeholder until `chatUnlocked` |
| `POST /dashboard/messages/:id` | — | Send a chat message; up to 10 attachments and/or tagged existing project files per message; broadcasts `new-message` to the booking's socket room; 403s if the booking isn't `chatUnlocked` yet |
| `GET /dashboard/messages/attachments/:filename` | — | Owning-client-only chat attachment download/view |
| `POST /dashboard/messages/:id/:messageId/delete` | — | Soft-delete a message the client sent (clears body/attachments, tombstones the row); tagged project-file references are left untouched on disk |
| `POST /dashboard/messages/:id/:messageId/edit` | — | Edit the text body of a message the client sent (text-only, no attachment edit); sets `edited: true`, broadcasts `message-edited` to the socket room |

## Editor / Associate Portal (individual associate login required)

Separate from both client accounts and the shared-password admin login — editors get individually-owned, bcrypt-hashed `Associate` accounts (`req.session.associateId`), created only by the superadmin via `/admin/associates`. An associate can only act on bookings currently `assignedTo` them (`requireAssignedBooking`, 403/redirect otherwise — archiving a booking also revokes an associate's access to it).

| Route | Page | Purpose |
|-------|------|---------|
| `/associate/login` / `GET /associate/logout` | — | Individual editor login, rate-limited the same way as `/login`/`/admin/login` |
| `/associate` | Associate Dashboard | "My projects" (assigned to this editor) + the unassigned pool available to self-claim |
| `POST /associate/booking/:id/claim` | — | Atomic self-claim of an unassigned, non-archived booking (`findOneAndUpdate` on `assignedTo: null` — two editors racing the same booking can't both win) |
| `/associate/booking/:id` | Booking Detail | Same shape as `admin/booking.ejs`, scoped to one assigned booking — status changes, deliverable upload/delete, deposit/final/revision Stripe invoices, delivery date, revision-reviewed toggle, chat (send/delete/mute) |
| `/associate/messages` / `/associate/messages/archived` | Messages Inbox | List of this editor's assigned-project threads with at least one message; same search/filter/live-insert behavior as the admin and client inboxes |
| `/associate/messages/:id` | Project Thread | Full-featured chat panel (lazy attachments, tagging, retry — same as admin/client), AJAX partial on `X-Requested-With` |
| `GET /api/associate/messages/poll` | — | 15s poll for a live unread badge + new-message toasts, scoped to this associate's own assigned bookings plus any unassigned-but-chat-unlocked booking (tagged `unclaimed: true`) so an unclaimed thread's messages aren't invisible to every editor |
| `GET /associate/messages/attachments/:filename` / `GET /associate/uploads/:filename` | — | Associate-only file serving, scoped to assigned bookings |
| `/associate/notifications` | Notifications | In-app alerts (`assignment`/`payment`/`files_added`) scoped to this associate; marks all read on view |
| `GET /api/associate/notifications/poll` | — | 15s poll for a live unread badge + new items since a timestamp |
| `POST /api/associate/notifications/mark-read` | — | Marks all associate notifications read (JSON response) |

## Admin (restricted to owner)

| Route | Page | Purpose |
|-------|------|---------|
| `/admin/login` / `/admin/logout` | — | Single shared admin password (`ADMIN_PASSWORD` env var), session-based |
| `/admin/notifications` | Admin Notifications | Latest 200 `AdminNotification` records (`nudge`, `payment`, `new_booking`); marks all read on view; bell badge + 15s poll + toast on every other admin page via `_notif-poll.ejs` partial |
| `GET /api/admin/notifications/poll` | — | Polling endpoint for live unread badge + new items since a timestamp (`?since=<ms>`) |
| `POST /api/admin/notifications/mark-read` | — | Marks all admin notifications read (JSON response) |
| `/admin` | Admin Dashboard | Active/Completed/Archived tabs (`?view=completed`/`?view=archived`) bookings, server-side paginated (30/page) with debounced search (`q`/`field` query params) and a status filter dropdown (Active tab only), total count |
| `/admin/booking/:id` | Booking Detail | Full booking info, status picker, admin notes (disabled while archived), payment card (deposit due date, delivery date once paid), revision invoices card, media links, revision request list (mark reviewed), assign/reassign to an `Associate` |
| `POST /admin/booking/:id/assign` | — | Assign, reassign, or unassign (`associateId` empty) an active `Associate` to this booking — independent of an editor self-claiming it from `/associate` |
| `POST /admin/booking/:id/status` | — | Update booking status + create client notification (special-cased message for `declined`); server-enforced status gate (`isStatusChangeAllowed`) — `completed`/`declined` are terminal, forward moves capped at one step, backward moves and `declined` always allowed, `paused` only from `in-progress` |
| `POST /admin/booking/:id/notes` | — | Append an admin note (`adminNotes` array, admin-only, not client-visible) |
| `POST /admin/booking/:id/notes/:noteId/edit` | — | Edit the text of an existing admin note |
| `POST /admin/booking/:id/notes/:noteId/delete` | — | Remove an admin note |
| `POST /admin/booking/:id/send-deposit` | — | Create/reuse Stripe customer, send 30% deposit invoice with an admin-set due date (`due_date`), flips status to `accepted`, sends acceptance email; blocked (redirects with an error) while `status === "pending"` — booking must reach `in-review` first so the client gets a window to upload files before seeing a payment ask |
| `POST /admin/booking/:id/deposit-due-date` | — | Update (or clear) the deposit due date while `depositStatus === "pending"` |
| `POST /admin/booking/:id/delivery-date` | — | Set/clear the estimated delivery date, only allowed once `depositStatus === "paid"` |
| `POST /admin/booking/:id/send-final` | — | Send 70% final invoice once deposit is paid |
| `POST /admin/booking/:id/send-revision-invoice` | — | Send an ad-hoc Stripe invoice for extra revision work, admin-set amount (defaults to the `"Extra revision"` add-on price, $30) and due date; unlike deposit/final there's no cap — appends to `revisionInvoices[]` rather than overwriting a single field; requires `stripeCustomerId` (a deposit invoice must have gone out at least once) |
| `POST /admin/booking/:id/archive` / `POST /admin/bookings/bulk-archive` | — | Archive: sets `archived: true`, moves the booking's upload folder to `uploads/_archive/`, notifies client |
| `POST /admin/booking/:id/restore` | — | Un-archives a booking and moves its folder back out of `uploads/_archive/` |
| `POST /admin/booking/:id/revision/:revId/reviewed` | — | Marks a single client revision request as reviewed |
| `POST /admin/booking/:id/deliverables` | — | Upload finished output files (separate `multer` storage, `uploads/<crCode>/files/deliverables/`); notifies the client immediately if the project is already `completed` |
| `POST /admin/booking/:id/deliverables/:fileId/delete` | — | Remove a single deliverable file from disk and the booking record |
| `GET /admin/uploads/:filename` | — | Protected file serving (checks active and `_archive` paths, and both `uploadedFiles`/`deliverableFiles`); images inline, video/audio in-browser, download for all |
| `/admin/coupons` | Coupon Manager | List/create/toggle-active/delete coupon codes (percent or fixed discount, optional expiry); `WELCOME` is a reserved code and can't be created here — it's the auto-applied signup discount (see `POST /signup`), excluded from this manager's list and from `/admin/analytics`'s coupon-usage stats |
| `/admin/roles` | Role Manager | Create/toggle-active/delete `Role` postings shown on the public `/career` page |
| `/admin/associates` | Associate Manager | Create editor accounts, toggle-active, reset password; no delete (`BookingRequest.assignedTo` can reference one — same reasoning as Coupons) |
| `/admin/messages` | Messages Inbox | List of every project thread with at least one message, with unread indicators; search bar + read-state/project-status filter dropdown. Not linked from the admin sidebar (day-to-day client chat is now the assigned associate's job — see `/associate/messages` above) but still fully functional as a fallback; also reachable per-booking via `admin/booking.ejs`'s Quick Actions |
| `/admin/messages/:id` | Project Thread | Real-time chat (Socket.IO) with the client on one booking; full page normally, thread-panel partial only on `X-Requested-With: XMLHttpRequest`; composer disabled until `chatUnlocked` |
| `POST /admin/booking/:id/messages` | — | Send a chat message; up to 10 attachments and/or tagged existing project files (`uploadedFiles`/unlocked `deliverableFiles`) per message; 403s if the booking isn't `chatUnlocked` yet |
| `GET /admin/messages/attachments/:filename` | — | Admin-only chat attachment download/view |
| `POST /admin/booking/:id/messages/:messageId/delete` | — | Soft-delete a message admin sent |
| `POST /admin/booking/:id/messages/:messageId/edit` | — | Edit the text body of a message admin sent (text-only, no attachment edit); sets `edited: true`, broadcasts `message-edited` to the socket room; same edit endpoint also exists at `/associate/booking/:id/messages/:messageId/edit`, scoped to the assigned associate |
| `POST /admin/booking/:id/chat-block` / `POST /admin/booking/:id/chat-unblock` | — | Mutes/unmutes the client on this project's chat (`chatBlocked`) — client keeps read access but can't send; independent of `chatUnlocked`; JSON response, triggered via `fetch()` from inside the chat panel |
| `POST /webhooks/stripe` | — | Stripe webhook (raw body, signature-verified) — advances `depositStatus`/`finalPaymentStatus`/matching `revisionInvoices[].status` on `invoice.payment_succeeded`; deposit payment no longer auto-flips `status` (admin confirms manually, prompted by a `payment` `AdminNotification`); final payment still flips `status` to `completed`; notifies client + admin |

A catch-all registered after every route above (`app.use((req, res) => res.status(404).render("404"))`, 2026-07-12) renders a branded `views/404.ejs` for any unmatched request, instead of Express's default plaintext 404.

## Real-Time Messaging (Socket.IO)

Chat is a separate system from the `/dashboard`/`/admin` in-app `Notification`/`AdminNotification` alert feeds — it lives entirely under its own `/messages` inbox pages (`/dashboard/messages`, `/admin/messages`, and now `/associate/messages`; not embedded on `dashboard-booking.ejs`/`admin/booking.ejs`), backed by a `Message` model (one document per chat message). Socket.IO rooms are scoped per booking (`project:<bookingId>`), authorized once at connect (admin: booking exists; client: owns booking; associate: booking's `assignedTo` matches their session); sending itself still goes through a normal session-checked HTTP POST (multer needs a real request to parse attachments) — the socket only broadcasts the saved message (`new-message` event) to whoever has that thread open. Unread-message badges are piggybacked onto each portal's own 15s poll endpoint (`/api/notifications/poll` for clients, `/api/admin/notifications/poll` for admin, `/api/associate/messages/poll` for associates) via a `messageItems` array, rather than a separate polling channel or persisted `Notification` documents. The shared client-side driver (`views/_message-thread-script.ejs`) reads a `messagesBase`/`bookingBase` pair off the composer's `dataset` rather than hardcoding `/admin/` paths, so the same script works unmodified across all three portals; the associate portal uses the same full-featured thread panel admin/client get (`views/associate/_message-thread-panel-rich.ejs`) inside its dedicated inbox, but a smaller, fixed-height variant (`views/associate/_message-thread-panel.ejs`) when embedded on the booking-detail page. Admin's general inbox isn't linked from its own sidebar anymore — see the `/admin/messages` row above — since ongoing client chat is meant to be handled by whichever associate the project is assigned to.

Chat is gated behind the `chatUnlocked` virtual on `BookingRequest` (`accepted`/`in-progress`/`completed`/`paused` — not `pending`/`in-review`/`declined`), enforced on both send routes (403 if locked) and reflected in both thread panels (disabled composer, explanatory placeholder) and both list views (locked-state row copy instead of "No messages yet.").

Separately, `chatBlocked` is an admin-only mute on top of that gate — the client keeps read access to a thread but their send route 403s until an admin unblocks them (`chat-block`/`chat-unblock`, above). The client composer shows a persistent banner (not just a placeholder) when blocked, and the admin thread header shows a "Client blocked" badge + toggle button. The client's composer reconciles this state live off the `chatBlocked` flag riding along on every `new-message` socket event (there's no dedicated push for a mute toggle), rather than only reading it once at page load.

A booking's first-ever message inserts a new row into both sidebars live (matching server-rendered markup) instead of requiring a reload — the inbox list only ever queries bookings with at least one `Message`, so a brand-new thread has no row to begin with.

A message can be replied-to (long-press or the bubble's reply action selects it, composer shows a reply-preview bar, sent message carries a `replyTo` snapshot — messageId/senderRole/body/attachmentSummary frozen at send time so a later edit or delete of the original doesn't retroactively change what the reply quote shows) and edited (own messages only, text-only — the composer switches into an edit mode with attachment-picking disabled, `PATCH`-style `.../messages/:messageId/edit` sets `edited: true` and broadcasts `message-edited`). Both reply and edit share the same long-press/tap selection-mode UI as delete; the reply/edit actions hide once more than one message is selected, since both only make sense against a single message.

Attachments the receiving party hasn't fetched yet ("lazy" — image/video, not the sender's own, not already `downloaded`) show a tap-to-download icon instead of loading eagerly. If a booking's files have been permanently deleted (`filesDeleted`, see the client-delete route above), that lazy state is skipped entirely — every attachment (any type, tagged or not) renders straight into a non-interactive "This file is no longer available" placeholder, since a download would only ever fail. The same placeholder also covers the general case of an individual file that fails to load for any other reason (`onerror` on the `<img>`/`<video>`), including neutralizing the enclosing link so it doesn't still try to open a file viewer or download.

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
               the booking, voids the invoice, archives it, and emails client + admin instead
                       ↓
           Admin does the work → client may request revisions from /dashboard/booking/:id
                       ↓
           Admin sets a final due date → sends 70% final invoice via Stripe
             — if unpaid past that date, the same hourly job voids the invoice, resets
               finalPaymentStatus so a fresh one can be sent, and emails client + admin
               (status is left alone — project isn't declined, just unpaid)
             — if still no fresh final invoice 3 days after that (`ae4471e`),
               the project is auto-archived the same way, with its own client + admin email
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
