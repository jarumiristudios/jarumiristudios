# Journal

## 2026-07-04 — Admin Analytics Page

**What was built:**

- `GET /admin/analytics` (`server.js`) — the Growth-backlog "bookings per month, revenue by tier, most requested service type" item, scoped up during build into a fuller reporting page: a KPI row (total bookings, revenue collected, avg deal size, conversion rate), bookings-per-month and revenue-per-month over a `dateFrom`/`dateTo` range, revenue by pricing tier, bookings by service type, a pending → deposit-paid → completed funnel, a guest-vs-account-holder completion-rate comparison, coupon usage/discount totals, and a pipeline-status snapshot.
- All of it comes from a single `BookingRequest.aggregate([...])` using `$facet` so the eight breakdowns share one `$match`/`$addFields` pass instead of eight round trips. `revenue` per booking is computed in `$addFields` as 30% of `agreedPrice` if `depositStatus === "paid"` plus 70% if `finalPaymentStatus === "paid"` — matches the actual deposit/final split rather than assuming a booking's full price is "revenue" the moment it's booked.
- Date range defaults to the trailing 12 months (UTC month-aligned) if `dateFrom`/`dateTo` aren't supplied; reuses the existing `endOfDay()` helper for the upper bound, same as the `/admin` list's date filter. New `monthKeysBetween()`/`monthKeyLabel()` helpers fill in zero-count months so a quiet month shows as `0`, not a gap in the chart.
- Pipeline-status snapshot deliberately ignores the date range (always current, unfiltered by `dateFrom`/`dateTo`) — it's a live "what's in flight right now" view, not a historical one, so it wouldn't make sense to have it disappear when filtering to a past date range.
- Charts are plain HTML/CSS horizontal bar charts (`views/admin/analytics.ejs`) with a per-card table-toggle to see the underlying numbers — no charting library pulled in, consistent with the rest of the admin UI having no JS dependencies beyond vanilla fetch/DOM calls.
- Linked from the `/admin` dashboard header next to Coupons/Notifications.

**Decisions made:**
- Computed revenue from `depositStatus`/`finalPaymentStatus` rather than adding a new "revenue recognized" field — the 30/70 split and paid-status fields already fully describe how much of a booking's price has actually landed.
- Trust-tier completion-rate comparison (guest vs. account holder) added even though it wasn't in the original backlog wording, since the guest/account tiering shipped earlier today made "does tier affect follow-through" a natural, cheap-to-add question against the same aggregation.

---

## 2026-07-04 — Reliability: Graceful BR Code Collision Handling

**What was built:**

- `generateCrCode()` (`server.js`) was a `do...while` loop with no exit condition other than finding a free code — fine given the 36⁹ keyspace makes a real collision astronomically unlikely, but a bug or repeated `BookingRequest.exists()` failure had no bound and would spin forever or surface as an unhandled crash. Rewrote it as a bounded `for` loop (`CR_CODE_MAX_ATTEMPTS = 10`) that throws a plain `Error` if it exhausts its attempts without finding a free code.
- `preCrCode` middleware now wraps the `generateCrCode()` call in try/catch: on failure it logs the error server-side and renders `hire.ejs` with a clean user-facing message ("We couldn't process your request right now. Please try again in a moment.") instead of an unhandled rejection — same render pattern (`error`/`loggedInUser: null`/`lastBooking: null`) already used by `enforceGuestSubmissionQuota`, which runs immediately before it in the same middleware chain and faces the same "body not yet parsed by multer" constraint (no `formData` to echo back).

**Decisions made:**
- 10 attempts, not a larger number — at a 36⁹-code keyspace, hitting 10 consecutive collisions organically is effectively impossible; the cap exists to bound a *pathological* failure (e.g. `exists()` erroring or a logic bug always reporting a collision), not to accommodate real collision odds.
- Verified the retry cap in isolation (stubbed `exists()` forced to always collide → throws after exactly 10 attempts; stubbed to never collide → returns normally) and again against the real MongoDB connection with `BookingRequest.exists` monkey-patched to always return `true`, confirming the same bounded-throw behavior holds against the live DB client, not just the isolated logic.

---

## 2026-07-04 — Tiered Soft Limits on `/hire` (Guest vs. Account Holder)

**What was built:**

- The "Rate limiting on `/hire`" backlog item (`june26-milestone.md`) was redefined during scoping from hard rate-limiting into **product-level trust tiering**: guests (no logged-in account) get a smaller file allowance — **3 files max, 25MB each** — and are limited to **1 `/hire` submission per rolling 24 hours**; logged-in account holders keep today's 20 files / 250MB with no submission cap.
- A new `assignVisitorId` middleware (global, ahead of `session(...)`) sets a long-lived (`jrmr_vid`, ~1 year, `httpOnly`, `sameSite: lax`) anonymous visitor cookie for every site visitor, not just guests, via `crypto.randomUUID()`. `BookingRequest` gained a matching `visitorId` field, populated on every booking (guest or account holder) — cheap to store universally and keeps the field meaningful if a future "returning client" tier gets added.
- `enforceGuestSubmissionQuota` — a new pre-upload middleware — checks `BookingRequest.exists({ visitorId, createdAt: { $gte: 24h ago } })` for guests only (`req.session.userId` bypasses it entirely) and renders `hire.ejs` with an error if one's already landed in the window. It runs *before* `preCrCode` and before multer touches the request, so an over-quota guest costs nothing — no BR code generated, no bytes uploaded, nothing to clean up on rejection.
- A second multer instance, `uploadGuest`, shares the existing `storage`/`fileFilter` but caps `limits.fileSize` at 25MB (multer's file-size limit is fixed at construction, so a distinct instance was needed for the tier); file *count* just uses a smaller `.array("files", N)` argument at the guest call site, no second instance required for that part. `POST /hire`'s multer-error branch now gives tier-specific messages ("Guests can upload up to 3 files... create a free account to upload more" vs. the existing member-tier text).
- Added `cookie-parser` as a new dependency — nothing previously parsed `req.cookies` (only `express-session` handled cookies internally, without exposing them).

**Decisions made:**

- Chose a dedicated anonymous cookie over keying the guest quota on email or IP — email is trivially varied and IP risks false positives on shared/office/NAT connections; a cookie is a deliberate soft deterrent, not hard security, and clearing it is an accepted way to reset the guest quota.
- Two tiers only for now (guest vs. account holder) — a "returning client" tier (e.g. ≥1 completed project) was discussed as a natural future extension but explicitly scoped out; all tier-dependent constants live in one block in `server.js` so adding a third tier later only touches that block plus the two decision points in the `POST /hire` chain (quota check, multer instance choice).
- No index added on `visitorId` — this codebase's only existing indexes are the `unique: true` on `crCode`/`email`; at current booking volume an unindexed `exists()` scan is negligible. Flagged a compound `{ visitorId: 1, createdAt: -1 }` index as an easy follow-up if volume grows.
- Verified end-to-end against the live dev server: fresh guest cookie set on first `/hire` load; guest submission with ≤3 files/≤25MB succeeds; immediate resubmission blocked with the 24h message before reaching multer; a 30MB file and a 4th file both correctly rejected with guest-specific messages; clearing the cookie resets the quota (by design); a logged-in account holder submitted twice in a row with no cap and successfully uploaded a 30MB file (under the 250MB member cap); `visitorId` confirmed present on both guest and account-holder bookings.

---

## 2026-07-04 — Admin Dashboard: Date Range Filter

**What was built:**

- `/admin` gained `dateFrom`/`dateTo` query params, filtering the same `BookingRequest.find(filter)` used by search/status/pagination on `createdAt`. `dateFrom` parses as UTC midnight of the typed day; `dateTo` reuses the existing `endOfDay()` helper (`server.js:17`) so the upper bound is inclusive of the whole selected day — consistent with how due dates are already parsed elsewhere in this file.
- Two native `<input type="date">` pickers added next to the search bar in `admin/dashboard.ejs`, wired to the existing `navigateSearch()` JS (no debounce — date pickers don't fire per-keystroke like the text search does). Each input's `min`/`max` is bound to the other's current value so an invalid inverted range can't be picked from the UI; a clear (×) button appears only when a range is active.
- `statusLink()` and `pageUrl()` (the URL-builders behind status pills and pagination) now also carry `dateFrom`/`dateTo`, so switching a status filter or page doesn't silently drop an active date range. The empty-state message ("No matching requests") now also triggers when a date filter yields zero rows, not just search/status.

**Decisions made:**
- Filtered on `createdAt` (submission date), not `updatedAt` — matches the backlog item's own wording ("filter bookings by submission date") and the column already shown as "Date" in the table.
- Reused `endOfDay()` rather than adding a new date-parsing helper, since the semantics (UTC end-of-day, same-day-typed = included) already matched what was needed here.

Verified against the live server: seeded booking created 2026-07-02; a `2026-07-01`–`2026-07-03` range and an exact same-day `2026-07-02`–`2026-07-02` range both correctly return it; `dateFrom=2026-07-03` alone and `dateTo=2026-07-01` alone both correctly return zero. Confirmed status-pill links and the date inputs' own values correctly retain the active range across navigation.

---

## 2026-07-03 — Deliverable Download: Review Fixes

**What was built:** A multi-angle review of the deliverable-download feature (same day, see entry below) surfaced two real bugs and several duplication/efficiency nits, all fixed:

- **Archived-booking upload blocked.** `attachCrCode` now also selects `archived` and redirects before `deliverableUpload` ever runs if the booking is archived — previously an admin could upload to an archived booking, writing into a fresh active-path folder while the real files sat under `uploads/_archive/`; restoring that booking later did a fire-and-forget `fs.rename` with no error handling, which on a platform where rename-into-an-existing-directory fails would silently leave the booking's files permanently split across both locations while the DB said `archived: false`. The "Final deliverables" upload form in `admin/booking.ejs` is now hidden (with a note to restore first) when `booking.archived`.
- **No-op guard on status resubmission.** `POST /admin/booking/:id/status` now fetches the current status first and redirects immediately if it matches the posted one, before touching the DB or creating notifications — previously resubmitting the same status (e.g. double-clicking the active pill) re-fired both the `status_change` and `deliverable_ready` notifications every time. Same pattern already used for due-date no-op guards elsewhere in this file.
- **Single gate predicate.** Added a `deliverablesUnlocked` virtual to `BookingRequest` (`this.status === "completed"`) and switched every place that gated deliverable visibility/download — both new download routes and all 4 views (`track.ejs`, `dashboard-booking.ejs`, `dashboard.ejs`, `admin/booking.ejs`) — to read it instead of repeating the literal status comparison 6 times. One place to update if the "done" rule ever grows beyond just `status`.
- **Deduplicated file-serving.** Extracted `trySendStoredFile(res, crCode, type, filename)` (tries the active path, then `_archive`, returns whether it sent) and pointed all 4 file-serving routes (`/admin/uploads`, `/dashboard/uploads`, `/dashboard/deliverables`, `/track/:crCode/deliverables`) at it instead of each re-implementing the same fallback block.
- **Deduplicated multer filename generator** (`uniqueFilename()`) shared between the client-upload and deliverable-upload `multer.diskStorage` configs.
- **Merged the two sequential DB queries** in `/admin/uploads/:filename` into a single `findOne({ $or: [...] })` across `uploadedFiles` and `deliverableFiles`.

Same commit also shipped the standalone **bulk status update** backlog item (`june26-milestone.md`, previously untracked in this journal): `POST /admin/bookings/bulk-status` updates every checked row via `updateMany` (skipping rows already at the target status), driven by a status dropdown next to the existing bulk-archive control on `/admin`. Notification dispatch was pulled out into a shared `notifyStatusChange(bookings, newStatus)` helper (`server.js:1137`) used by both this route and the single-booking `POST /admin/booking/:id/status`, so bulk updates fire the same `status_change`/`project_dismissed`/`deliverable_ready` notifications as a single-row change rather than a second, divergent notification path.

**Left as-is:** `deliverableFiles` staying a separate array/schema from `uploadedFiles` (rather than a `source` discriminator on one array) — the review flagged this as a real ongoing cost (every files-related feature now touches two arrays/folders) but also a defensible one, since the two have genuinely different gating/exposure rules (`deliverableFiles` gated + public on `/track`, `uploadedFiles` never gated, never exposed there). Not refactored.

Verified live: re-seeded a `completed` + `archived` test booking, confirmed the upload route now redirects without creating any folder or writing any file; confirmed resubmitting the same status leaves `updatedAt` untouched while a genuine status change still updates it; re-ran the full upload → `/track` render → download → admin-viewer path end to end against the consolidated helper and merged query.

---

## 2026-07-03 — Final Deliverable Download on `/track` + Client Dashboard

**What was built:**

- `BookingRequest` gained `deliverableFiles` — same shape as `uploadedFiles` (`originalName`/`storedName`/`size`/`mimetype`) plus an `uploadedAt` timestamp. A second `multer` disk storage (`deliverableStorage`/`deliverableUpload`, `server.js`) writes to `uploads/<crCode>/files/deliverables/` — a sibling of the existing `video/audio/image/other` type folders, kept as its own folder so admin-uploaded final output never mixes with client-submitted raw material in the same listing.
- Admin gets a "Final deliverables" card on `/admin/booking/:id` — multi-file upload form (`POST /admin/booking/:id/deliverables`, via a small `attachCrCode` middleware that looks up the booking's `crCode` before `multer`'s destination callback needs it) plus a per-file "Remove" action (`/deliverables/:fileId/delete`) that deletes from disk (active and archived path) and pulls the subdocument.
- Client-side download is gated on `booking.status === "completed"`, enforced server-side, not just hidden in the UI: `GET /track/:crCode/deliverables/:filename` (public — no session, same trust model as the rest of `/track` where the BR code itself is the bearer token) and `GET /dashboard/deliverables/:filename` (session + `clientId` ownership check) both 403 if the booking isn't completed or the file isn't attached to that booking. `/admin/uploads/:filename` was extended to also resolve `deliverableFiles` (falls back to it if the filename isn't found in `uploadedFiles`) so admin can preview/download its own uploads through the existing viewer.
- Rendered on `/track` (new card, amber-accented, only shown once completed), `dashboard-booking.ejs` (same gate, placed above "Submitted files" since it's the thing the client actually wants once a project wraps), and a "Download" icon action on `dashboard.ejs`'s project list (links to the booking detail page rather than a single file, since there can be more than one deliverable).
- New `Notification` type `deliverable_ready`. Fires in three places: (1) admin uploads files to a project that's already `completed`; (2) admin manually flips status to `completed` on a project that already has deliverables attached; (3) the `invoice.payment_succeeded` webhook completes a project via final payment — in that case it's folded into the existing payment-confirmed message rather than a separate notification, since one event fired one action.
- Client hard-delete (`POST /dashboard/booking/:id/delete`) now also clears `deliverableFiles: []` alongside `uploadedFiles: []` — the underlying `files/` folder (which `hardDeleteBookingFiles()` already removed wholesale) contained both, so the DB record needs to match.

**Decisions made:**

- Gate is `status === "completed"`, not `finalPaymentStatus === "paid"` — they're set together by the same webhook/status-change paths today, but status is what both `/track` and the dashboard already key their "is this project done" language off of, so it's the one source of truth to check.
- Public download route trusts the BR code alone (no extra token), matching the existing `/track` page itself — anyone who can already look up full project status and payment links via the BR code can also fetch the finished files once the project is marked done. Not a new trust boundary.
- Deliverables aren't split into video/audio/image subfolders the way client uploads are — that split exists to make sense of bulk, uncurated client submissions; a curated admin upload is small enough to live in one flat folder.
- Verified end-to-end against the live server: seeded a `completed` test booking, uploaded a file as admin, confirmed it rendered and downloaded correctly on `/track`, then flipped status to `in-progress` and confirmed the same download URL 403s and the UI stops rendering the section — then flipped back and confirmed the admin "Remove" action deletes the file from disk.

---

## 2026-07-03 — Admin Dashboard: Server-Side Search, Filter & Pagination

**What was built:**

- `/admin` used to load every non-archived (or archived) booking on each request and filter/search entirely client-side via `data-*` attributes on each row. Replaced with real pagination: `BookingRequest.find(filter).sort({ createdAt: -1 }).skip().limit()` at `ADMIN_PAGE_SIZE = 30` (`server.js:734`), with `page`/`totalPages` computed from a `countDocuments(filter)` on the same filter.
- Search and status-filter moved server-side too, via query params (`q`, `field`, `status`) instead of live DOM filtering — `ADMIN_SEARCH_FIELDS` (`server.js:735`) maps a `field` param (`crCode`/`name`/`email`/`location`/`services`/`package`/`status`) to its schema path; `field: "all"` (default) `$or`s across every mapped field with a case-insensitive, regex-escaped match on `q`.
- `views/admin/dashboard.ejs` reworked to reflect URL state on load (search box, field dropdown, and status pills all pre-filled from `q`/`field`/`statusParam`) and to navigate (not just re-render) on input — search debounces 400ms before triggering a page load; changing the field dropdown or a status pill navigates immediately. Pagination controls (prev/next + page numbers) added at the bottom of the table.

**Decisions made:**
- Went server-side now rather than waiting for it to become a problem — client-side filtering only worked because booking volume was still small enough to load every row on every `/admin` hit; that stops being true as bookings accumulate; this was already a tracked backlog item (`june26-milestone.md`).
- 400ms debounce on the search box specifically (not the field/status controls) since typing fires far more often than a dropdown/pill click — the field and status controls navigate on every change since there's no "typing" to wait out.
- Kept `total`/`pending` header counts computed against the full filtered set (not just the current page) via a separate `countDocuments` — `pending` in particular ignores the active filter/archived-view entirely, since it's meant as a global "needs attention" count, not a per-view one.

---

## 2026-07-03 — `/hire` Form UX: Brief Character Count + Mobile Upload Layout

**What was built:**

- Project brief textarea (`views/hire.ejs`) gained a live `X / 2000` counter (`updateBriefCount()`, fired on `oninput`) that turns amber approaching the limit and red once at it; backed by `maxlength="2000"` on the `<textarea>` and a matching server-side length check on `BookingRequest.projectBrief` in the `/hire` POST handler and the schema itself, so the limit holds even if the client-side attribute is bypassed.
- File upload drop zone and file-list rows reworked for narrow viewports (sub-480px): drop zone padding and icon size shrink, and each file-list row now wraps filename/size onto their own line above the remove button instead of squeezing all three into one row — the remove button also got a larger tap target.

**Decisions made:**
- Enforced the 2000-char cap in three places (client `maxlength`, client counter, server validation) rather than relying on `maxlength` alone — the counter is UX (so the client sees it coming), the server check is the actual guarantee, `maxlength` is just the first line of defense.

---

## 2026-07-03 — Minimum 3-Day Lead Time on Due Dates

**What was built:**

- Due-date validation across all four routes (`send-deposit`, `deposit-due-date`, `send-final`, `final-due-date`) previously only rejected dates in the past (`<= new Date()`) — a same-day or next-day due date was accepted. Added a shared `minDueDate()` helper (`server.js:25`, `MIN_DUE_DATE_LEAD_DAYS = 3`) computing today's UTC midnight + 3 days; all four routes now reject anything earlier than that, with an error message stating the requirement.
- Added a matching `min` attribute (client-side only, same 3-day computation) to all five date `<input>`s that feed those routes — the two `send-deposit` forms (main panel + "Accept & send deposit invoice" modal, both post to the same route), `send-final`, and the two due-date-edit forms — so the date picker itself won't offer an invalid date, though the server-side check is what actually enforces it.

**Decisions made:**
- Applied the 3-day minimum to invoice *creation* (`send-deposit`/`send-final`) as well as *editing*, even though the reported bug was specifically about editing — the same validation function backs both, and there's no reason a freshly-sent invoice should be allowed a shorter runway than an edited one.
- Verified against the live server: `Jul 5` (2 days out from "today" = Jul 3) correctly rejected with the new error; `Jul 6` (exactly 3 days out) correctly accepted — confirms the boundary is inclusive of exactly 3 days, not stricter.

---

## 2026-07-03 — No-Op Guard on Unchanged Due-Date Edits

**What was built:**

- The due-date "Update" buttons in `admin/booking.ejs` (deposit and final) are now `disabled` by default and only re-enable via `oninput` once the date picker's value differs from a `data-initial` attribute holding the currently-saved date — clicking "Update" with no actual change is no longer possible from the UI.
- Backed by a server-side guard in both `/admin/booking/:id/deposit-due-date` and `/final-due-date`: if the posted date matches the stored `depositDueDate`/`finalDueDate` exactly, the route redirects immediately, before the void/recreate/notify flow runs. This covers the button-disabling being bypassed (back/forward nav, resubmission) — a same-date submit is a true no-op, no Stripe calls, no client notification.

**Decisions made:**
- Both a client-side (UX) and server-side (correctness) guard, since the whole point was avoiding false "due date updated" notifications reaching the client — a client-only disabled-button fix doesn't survive a form resubmit.

---

## 2026-07-03 — 24-Hour Due-Date Reminders

**What was built:**

- `BookingRequest` gained `depositReminderSent`/`finalReminderSent` (bool, default `false`). `lib/invoiceExpiry.js` gained two more checks in the same hourly job: `checkUpcomingDepositReminders`/`checkUpcomingFinalReminders` find bookings whose due date falls within the next 24h (and hasn't already been reminded), flip the reminder flag first via an atomic `findOneAndUpdate` guard (same race-safe pattern as the expiry checks), then send a reminder email (`sendDepositReminderEmail`/`sendFinalReminderEmail` in `lib/mailer.js`, same "pay from your tracking page/dashboard" copy as the acceptance/due-date-updated messages) and an in-app `Notification` (new `due_date_reminder` type) if the booking has a linked account.
- Both due-date-edit routes (`deposit-due-date`, `final-due-date`) reset the corresponding `*ReminderSent` flag to `false` when they void+recreate the invoice, so moving a due date further out doesn't skip the reminder for the new date.
- Icon/color mapping for `due_date_reminder` added to `dashboard-notifications.ejs` and `_notif-poll.ejs` (alarm icon, same amber family as the other invoice-related types).
- Verified against the real DB with the mailer functions stubbed (to avoid emailing the test booking's placeholder address): set a due date 5 hours out, confirmed the job fires exactly once (flag set, notification created, email call recorded) and does not re-fire on a second run.

**Decisions made:**
- Reminder window is checked on the same hourly cadence as the expiry job rather than a separate cron, since "within 24h, hasn't fired yet" only needs coarse granularity and reuses the existing `setInterval` infrastructure.
- Reminder flags reset on due-date edit (not on payment) — once paid, the booking falls out of the `depositStatus`/`finalPaymentStatus: pending` query filter entirely, so no explicit reset is needed there.

---

## 2026-07-03 — Due-Date Timezone Fix + Stripe Invoice Sync on Edit

**What was built:**

- `endOfDay()` (`server.js:17`) parsed the admin-picked date as **server-local** time (`T23:59:59` with no offset). On the EDT-hosted server that pushed the stored instant into the next UTC calendar day (e.g. picking "Jul 10" produced `2026-07-11T03:59:59Z`), which our own pages rendered back correctly via local-time formatting but which Stripe's dashboard — reading the UTC calendar day — displayed as "Jul 11". Fixed by parsing as UTC (`T23:59:59Z`) so the stored instant's UTC day always matches what was typed.
- Separately found (while chasing a due-date-not-updating report) that `/admin/booking/:id/deposit-due-date` and `/final-due-date` only ever updated the `BookingRequest` fields in Mongo — they never touched the Stripe invoice at all, so Stripe kept showing the original due date no matter what admin changed locally.
- Confirmed against the live Stripe test API that `stripe.invoices.update()` unconditionally rejects **any** field change on a finalized/sent invoice ("Finalized invoices can't be updated in this way") — not due-date-specific, a blanket rule. So both routes were rewritten to **void the existing invoice and create+finalize+send a new one** with the new due date (same pattern `lib/invoiceExpiry.js` already uses on auto-expiry), updating `depositInvoiceId`/`depositInvoiceUrl` (and the final equivalents) to point at the new invoice.
- Verified end-to-end against the real Stripe test account: old invoice flips to `void`, new invoice's `due_date` matches the typed date exactly, Mongo stays in sync.

- `Notification` gained a `due_date_updated` type; both due-date routes now notify the client (if `clientId` is set) with the new date after the void+recreate succeeds. Icon/color mapping added everywhere notification types are rendered: `dashboard-notifications.ejs` and the live-poll partial `_notif-poll.ejs` (amber calendar-clock icon, grouped with the other invoice-related types) — previously unmapped types fell through to a red "dismiss" icon, which would've been misleading for a neutral date change.

**Decisions made:**
- Void + recreate rather than trying to special-case due-date-only edits, since Stripe doesn't offer a narrower path — this also means the old Stripe-hosted invoice link (e.g. from the original email) goes dead the moment admin edits the due date. Paired with an in-app notification (rather than a new email) since the client dashboard/`/track` already show the *current* invoice URL — the notification just tells them to go look, rather than duplicating Stripe's own invoice email.

---

## 2026-07-03 — Stripe Payment Button on `/track`

**What was built:**

- `BookingRequest` gained `depositInvoiceUrl` and `finalInvoiceUrl`, populated from Stripe's `finalized.hosted_invoice_url` at the same point `depositInvoiceId`/`finalInvoiceId` are set in `send-deposit`/`send-final` (`server.js`). `finalInvoiceUrl` is reset to `null` alongside `finalInvoiceId` when `checkExpiredFinalInvoices` voids a stale final invoice (`lib/invoiceExpiry.js`).
- `/track`'s booking lookup `.select()` now includes both URL fields. While adding them, found `finalPaymentStatus` and `finalDueDate` were never in that `.select()` either, despite `track.ejs` already reading them for its final-payment-due banner — that banner has been silently dead since it was added; fixed as part of the same change.
- "Pay deposit now" / "Pay final invoice now" buttons added to the existing due-date banners on `/track`, linking directly to the stored Stripe hosted invoice URL.
- Same pattern extended to the client's own account views, which already had "Invoice sent — check your email" copy with no way to act on it: `dashboard-booking.ejs` (project detail sidebar) gets the same "Pay deposit now"/"Pay final invoice now" buttons under each line item; `dashboard.ejs` (project list) gets a green "Pay now" icon action in the row's CTA cluster (`/dashboard` route's `populate` select gained `depositInvoiceUrl`/`finalInvoiceUrl` to support it). Neither route needed a new query — `/dashboard/booking/:id` already fetched the full document.
- `sendAcceptanceEmail` (`lib/mailer.js`) copy updated to mention the `/track` fallback (and `/dashboard` too, if the booking has a linked `clientId`) as a way to pay the deposit if the Stripe invoice email itself gets lost.

**Decisions made:**
- Store the hosted invoice URL at invoice-creation time rather than fetching it from Stripe on each `/track` request — it's static until the invoice is paid or voided, and this avoids an extra Stripe API call on every page load.
- Deposit expiry (`checkExpiredDeposits`) doesn't reset `depositInvoiceId`/`depositStatus` on decline (pre-existing behavior), so `depositInvoiceUrl` is left alone there too for consistency — it's harmless since the button is gated on `status === 'accepted'`, which flips to `declined` on expiry.

---

## 2026-07-03 — In-App Admin Notifications, Nudge Rate Limiting, Client Booking Page Overhaul

**What was built:**

- New `AdminNotification` model (`bookingId`, `crCode`, `type` (currently only `"nudge"`), `message`, `read`) replaces the old email-based nudge alert. `POST /dashboard/booking/:id/nudge` now writes an `AdminNotification` instead of calling `sendAdminNudgeAlert` (removed from `lib/mailer.js` entirely).
- Nudge rate limiting: max 3 nudges per booking per rolling hour, counted via `AdminNotification.countDocuments` on `type: "nudge"` + `createdAt` in the last hour. Over the limit returns `429` with a JSON error message; client dashboard JS (single and bulk nudge) surfaces it instead of a generic failure.
- Admin notification bell: `/admin/notifications` (lists latest 200, marks all read on view), `GET /api/admin/notifications/poll?since=<ts>` (unread count + new items since a timestamp), `POST /api/admin/notifications/mark-read`. A shared `views/admin/_notif-poll.ejs` partial polls every 15s, updates an unread-count badge next to a "Notifications" link, and toasts new nudges in real time; included on `admin/dashboard.ejs`, `admin/booking.ejs`, and `admin/coupons.ejs`. An `app.use("/admin", ...)` middleware injects `res.locals.adminUnreadCount` on every admin request.
- Session store switched from the default in-memory `express-session` store to `connect-mongo` (`MongoStore.create({ mongoUrl: process.env.MONGO_URI })`) — sessions now survive server restarts/redeploys instead of forcing re-login.
- Client dashboard booking detail page (`views/dashboard-booking.ejs`) reworked into a two-column layout: main content left, sticky payment/status sidebar right (was a single centered column with payment status inline near the top). Submitted files section is now collapsible and grouped by media type (Video/Audio/Image/Other) instead of one flat list.
- `POST /dashboard/booking/:id/delete` (client hard-delete) now also sets `archived: true` and moves the booking's upload folder into `uploads/_archive/` in addition to the existing `hardDeleteBookingFiles()` call — a deleted project also drops out of the active admin view rather than lingering there with its files gone.

**Decisions made:**
- In-app + polling over email for nudges — email was already the fallback for guests, but for account-linked admin alerts a persisted, rate-limited record is cheaper to spam-guard than an inbox and gives a visible history (`/admin/notifications`).
- Rate limit is per-booking, not global — a client hammering nudge on one stuck project shouldn't affect their (or anyone else's) ability to nudge on a different one.
- `AdminNotification.type` is an enum with only `"nudge"` today — left room to add more admin-facing event types later without a schema migration.

---

## 2026-07-02 — Pause/Nudge Routes, Final Invoice Expiry, Stale-Payment Webhook Guard

**What was built:**

- Fixed the dead "Pause project" / "Nudge admin" buttons found last session: `POST /dashboard/booking/:id/pause` (sets a new `paused` status, emails admin) and `/nudge` (emails admin, no status change) now exist. `paused` styling/labels added across client dashboard, admin dashboard, admin booking status picker, and `/track`.
- `BookingRequest` gained `finalDueDate`, mirroring `depositDueDate`. `POST /admin/booking/:id/send-final` now requires an admin-chosen due date (was hardcoded `days_until_due: 7`); editable afterward via `POST /admin/booking/:id/final-due-date`. Shown to the client on `/track`.
- `lib/depositExpiry.js` renamed to `lib/invoiceExpiry.js` and gained `checkExpiredFinalInvoices`: past `finalDueDate` with `finalPaymentStatus: pending`, it voids the Stripe final invoice and resets `finalPaymentStatus`/`finalInvoiceId`/`finalDueDate` to `none`/`null` (unlike the deposit path, it does **not** touch `status` — project stays wherever it was, e.g. `in-progress`) so admin can send a fresh invoice without a dead end.
- Hardened the `invoice.payment_succeeded` webhook: it used to blindly set `status` to `in-progress`/`completed` on any matching invoice ID. Now it checks whether the booking is `archived`/`declined`/`paused` first — if so, the payment is still recorded but `status` is left alone and admin gets a distinct `sendAdminUnexpectedPaymentAlert` instead of the normal payment alert, so a payment landing on a stale link (e.g. paused/declined *after* the invoice was sent but before it expired) doesn't silently resurrect the project.

**Decisions made:**
- Void-on-expiry over allow-late-payment for final invoices too, for consistency with the deposit flow.
- Final invoice expiry doesn't decline the project (unlike deposit expiry) — by the time a final invoice exists, work is already done/in progress, so "declined" doesn't fit. Just void + reset + let admin decide.
- Didn't add proactive invoice-voiding on manual status changes (admin declining, client pausing) — the webhook guard covers the resulting risk (money already moved, so voiding after the fact doesn't help anyway) without adding that extra wiring. Flagged as a possible follow-up, not built.

---

## 2026-07-01 — Deposit Due Date, Delivery Date, Auto-Decline Job

**What was built:**

- `BookingRequest` gained two fields: `depositDueDate` (set by admin when sending the deposit invoice) and `deliveryDate` (only settable once `depositStatus === "paid"`)
- The deposit invoice's Stripe `due_date` is now the admin-chosen date instead of the old hardcoded `days_until_due: 7`; editable afterward via `POST /admin/booking/:id/deposit-due-date` while still pending
- `POST /admin/booking/:id/delivery-date` lets admin set/clear a delivery estimate once the deposit is paid; shown to the client on `/track`
- `lib/depositExpiry.js` — an hourly in-process `setInterval` job (started from the `mongoose.connect().then()` callback, no external cron) that finds bookings still `accepted`/`depositStatus: pending` past their `depositDueDate`, auto-declines them, voids the Stripe deposit invoice, and emails both client (`sendDepositExpiredEmail`) and admin (`sendAdminDepositExpiredAlert`)
- Client dashboard: renamed "Cancel" → "Delete" everywhere (it always hard-deleted files, the label was just wrong); added an `archived` status pill; bulk "Pause"/"Nudge" actions now filter to `manageableIds` (excludes archived/declined/completed rows) before firing

**Decisions made:**
- Redefined the old vague "deadline / delivery date field" backlog item into two separate concepts — a deposit deadline that protects the admin from unpaid-but-accepted bookings sitting in limbo, and a delivery estimate that's meaningless to promise before the deposit lands
- No work starts and no delivery estimate is shown without the 30% deposit landing first

**Found while documenting, not yet fixed:** the client dashboard's "Pause project" and "Nudge admin" buttons (single-row and bulk) call `POST /dashboard/booking/:id/pause` and `/nudge`, but no such routes exist in `server.js` — this predates this session's work. Logged in `june26-milestone.md`.

---

## 2026-07-01 — Admin Notes, Archive Rename, Client File Deletion

**What was built:**

- `BookingRequest` gained `adminNotes` (array of `{ text }`) and `filesDeleted` (bool)
- Admin notes: `POST /admin/booking/:id/notes` (add), `/notes/:noteId/edit`, `/notes/:noteId/delete` — internal, per-booking, never shown to the client
- Admin's soft-delete action was renamed delete → **archive**: `POST /admin/booking/:id/archive` and `/admin/bookings/bulk-archive` (was `/delete` and `/bulk-delete`); adds `POST /admin/booking/:id/restore` and an Active/Archived tab on `/admin` (`?view=archived`) so archived bookings stay reachable instead of disappearing
- Client-side hard delete: `POST /dashboard/booking/:id/delete` — the client's own "Delete project" action now actually destroys the uploaded files (`hardDeleteBookingFiles()`), clears `uploadedFiles`, sets `filesDeleted: true`; the booking row and `booking.txt` snapshot are kept as a permanent record
- Same commit reconciled `pages.md`, `landing-page.md`, `june26-milestone.md`, `stack.md` against the `server.js` state as of 2026-06-30 (see reconciliation entry below) — but did not catch its own new routes (notes/archive rename/restore/client-delete) in that pass, so those went undocumented until this entry

**Decisions made:**
- Two separate removal actions, not one: admin "archive" only unclutters `/admin` and is always reversible; only the client can trigger a real, permanent deletion of their own files. See `project_delete_vs_archive` memory for the full reasoning.
- No scheduled purge job for `uploads/_archive/` — archived files must stay retrievable indefinitely.

---

## 2026-06-30 — Planning Docs Reconciled With Implementation

**What was found:** `pages.md`, `landing-page.md`, and `june26-milestone.md` had drifted well behind `server.js` — several full subsystems existed in code with no record in the plans:

- Client account system (`User` model, `/login`, `/signup`, `/dashboard/*`) — bookings can be submitted as a guest and optionally linked to a persistent account
- `/dashboard/new`, `/dashboard/gallery`, `/dashboard/account`, `/dashboard/notifications` pages, plus client-submitted revision requests on `/dashboard/booking/:id`
- `Notification` model + `/api/notifications/poll` live-badge system
- `Coupon` model + `/admin/coupons` CRUD, applied on `/hire`
- Soft-delete/archive flow for bookings (`archived` flag + `uploads/_archive/` move) instead of hard deletion
- Direct file upload via `multer` (250MB/file, 20 files) replaced the originally-planned Telegram-only delivery model from `stack.md`; Telegram is now just a fallback for oversized files
- No standalone `/pricing` route — pricing lives in the `#pricing` section of `/`
- Landing page also has `#process` (How It Works) and `#career` (recruiting) sections never recorded in `landing-page.md`

**What changed:** Updated all four docs to match current `server.js`/model/view state. No code changes made.

---

## 2026-06-30 — Upload Directory Reorganization

**What was built:**

- File uploads are now organized by BR code: `uploads/<brCode>/files/<type>/` — each booking gets its own folder with subfolders for `video/`, `audio/`, and `image/`
- A `booking.txt` plain-text snapshot of the project brief is written to `uploads/<brCode>/` at submission time — quick reference without hitting the DB
- BR code is generated in the route handler before the multer upload runs so the destination callback can resolve the correct folder path at upload time

**Decisions made:**
- `uploads/<brCode>/files/<type>/` structure makes it trivial to delete an entire project's files atomically when a booking is removed
- `booking.txt` lives alongside `files/` rather than inside it to keep admin-written meta separate from client-uploaded assets
- Legacy flat files in the `uploads/` root from before the migration are left in place; new bookings all use the organized structure

---

## 2026-06-28 — Stripe Payment Flow

**What was built:**

- `POST /admin/booking/:id/send-deposit` — creates a Stripe customer for the client, posts a 30% invoice item, creates + finalizes + sends the hosted invoice; stores `agreedPrice`, `stripeCustomerId`, `depositInvoiceId` on the booking and sets `depositStatus: pending`
- `POST /admin/booking/:id/send-final` — reuses the existing Stripe customer, posts the remaining 70% invoice item, finalizes + sends; stores `finalInvoiceId` and sets `finalPaymentStatus: pending`
- `POST /webhooks/stripe` — registered before `express.json()` (uses `express.raw`) to allow Stripe signature verification; handles `invoice.payment_succeeded`; looks up booking by `metadata.crCode`; on deposit paid → `depositStatus: paid`, `status: in-progress`; on final paid → `finalPaymentStatus: paid`, `status: completed`
- BookingRequest schema extended with `agreedPrice`, `stripeCustomerId`, `depositInvoiceId`, `finalInvoiceId`, `depositStatus` (none/pending/paid), `finalPaymentStatus` (none/pending/paid)
- Admin booking payment card — full UI state machine in `/admin/booking/:id`: price input + "Send Deposit Invoice (30%)" (disabled until price > 0 and booking status ≥ in-review) → awaiting deposit → deposit received + "Send Final Invoice (70%)" → awaiting final → "All payments received"; JS validates price input live before enabling the submit button

**Decisions made:**
- Deposit button is gated on booking status being `in-review`, `accepted`, or `in-progress` — prevents accidentally invoicing a still-`pending` submission
- Stripe `collection_method: send_invoice` with `days_until_due: 7` — Stripe handles emailing the client the hosted payment link automatically, so no custom email needed for the payment step

---

## 2026-06-15 — Admin, Tracking & File Viewing

**What was built:**

- `/track` page — clients can look up their request by BR code or by name + email combo; both methods toggle with a link below the form
- `/admin` dashboard — table of all bookings with live client-side search (any field: BR code, name, email, location, services, package, status) and status filter pills; search uses a custom-styled dropdown, not native `<select>`
- `/admin/booking/:id` — full booking detail: client info, project brief, status picker (post form), media links, quick actions (email / Telegram)
- Admin file viewer — files stored in `uploads/` are now served via a protected route `/admin/uploads/:filename`; images render inline, videos and audio play in-browser, everything has a download button
- Renamed CR Code (Client Request Code) → BR Code (Booking Request Code) everywhere: views, copy, labels
- Hero CTA on landing page changed from "Check Out Recent Projects" (anchor) to "Track a Project" → `/track`

**Decisions made:**
- File serving is admin-only (`requireAdmin` middleware) with `path.basename()` to block path traversal
- Alternate track lookup (name + email) uses case-insensitive regex on name + lowercase email match
- Admin search is fully client-side — all rows carry `data-*` attributes; no server round-trip per keystroke

---

## 2026-06-13 — Initial Planning Session

Defined the full concept and stack for Jarumiri Studios.

**What we decided:**
- Video editing studio site — allow clients to hire me as an editor
- Built with Express + EJS + Tailwind + MongoDB Atlas + Railway hosting
- Stripe for payments, Telegram for raw file delivery
- No third-party auth, no self-hosted storage for v1
- Clean and minimal design direction

**What we ruled out and why:**
- React — unfamiliar, overkill for now
- Supabase / Firebase — don't want data in third-party hands
- Self-hosted MongoDB — uptime depends on PC being on
- Self-hosted file storage (external drive / NAS / MinIO) — home upload bandwidth is the bottleneck, not storage hardware
- Torrenting for file delivery — too technical for average clients
- VPS for storage — cost

**Reference files created:**
- `stack.md` — full tech stack and reasoning
- `pages.md` — all routes and user flow
- `landing-page.md` — landing page section breakdown
