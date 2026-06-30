# June 2026 Milestone

## Pending

- [ ] Add `og:image` and `twitter:image` meta tags — needs a logo or cover image asset first
- [x] Fix How It Works connector line alignment — the `h-px` absolute line may break on certain screen widths
- [x] Email confirmation to client on booking — send BR code via email (Nodemailer) so client doesn't lose it if they close the tab
- [x] Email notification to admin on new booking — same Nodemailer setup, two birds one stone
- [ ] Admin notes field on `/admin/booking/:id` — internal textarea for per-request notes, stored in DB, admin-only
- [ ] **Acceptance email to client** — triggered when admin sets status to `accepted`; includes confirmation, next steps, and a heads-up that a deposit invoice is on its way (blocked on **Stripe live API key** — `sendAcceptanceEmail` is only called inside the `send-deposit` route after Stripe invoice creation succeeds; without a live key the entire route errors out before the email fires; domain purchase is a secondary concern affecting link URLs only)
- [ ] **Deposit received notification** — email to admin + client when deposit lands; confirms work begins
- [ ] **Final payment received notification** — email to admin + client when final invoice is paid
- [x] Organize uploads by BR Code — BR code generated pre-save in the route handler; multer places files into `uploads/<brCode>/files/<type>/`; a `booking.txt` brief snapshot is written alongside
- [ ] Delete cleanup — when a booking is deleted, remove the booking's `uploads/<brCode>/` folder from disk to prevent accumulation
- [ ] Deadline / delivery date field — admin sets it on acceptance, client sees it on `/track`
- [ ] Admin dashboard pagination — avoid loading all bookings at once as volume grows
- [ ] `/hire` form UX improvements — live character count on project brief textarea, better mobile layout for the file upload area

## Future Tasks

### Client-facing
- [ ] Stripe payment button on `/track` — show it when status is `accepted` so clients who lose the acceptance email can still pay
- [ ] Final deliverable download on `/track` — admin uploads finished files; client downloads them from their tracking page once work is complete

### Admin QoL
- [ ] Admin notes field on `/admin/booking/:id` — internal textarea for per-booking context (e.g. rush delivery, special instructions), stored in DB
- [ ] Bulk status update on dashboard — update multiple bookings at once as volume grows
- [ ] Date range filter on dashboard — filter bookings by submission date

### Reliability
- [ ] Rate limiting on `/hire` — prevent spam submissions
- [ ] Server-side file type validation on upload — currently only file size is checked; restrict to allowed MIME types
- [ ] Graceful BR code collision handling — surface a clean error if the pre-save loop somehow fails instead of crashing

### Growth
- [ ] Analytics page under `/admin` — bookings per month, revenue by tier, most requested service type

## Completed

- [x] Add favicon — 🎬 emoji favicon via SVG data URI
- [x] Add JSON-LD structured data — marked as `ProfessionalService` with name, description, contact, and service types
- [x] Build the `/hire` booking form — name, location, email, project brief, file upload (up to 250 MB), Telegram fallback, BR code on submission
- [x] Build `/track` page — lookup by BR code; alternate method via name + email combo; toggle between both methods
- [x] Build `/admin` dashboard — lists all bookings, status filter pills, live search by any field (BR code, name, email, location, services, package, status) with custom dropdown
- [x] Build `/admin/booking/:id` detail page — full booking info, status picker, contact quick actions, media links
- [x] Admin file viewer — uploaded files served via `/admin/uploads/:filename` (admin-only); images preview inline, videos play in-browser, audio plays in-browser, all files have a download button
- [x] Renamed CR Code → BR Code (Booking Request Code) across all views and copy
- [x] Hero CTA — replaced "Check Out Recent Projects" button with "Track a Project" linking to `/track`
- [x] **Stripe Invoice — deposit (30%)** — `POST /admin/booking/:id/send-deposit`; creates Stripe customer, posts invoice item, creates + finalizes + sends invoice; stores `agreedPrice`, `stripeCustomerId`, `depositInvoiceId` on booking; sets `depositStatus: pending`
- [x] **Stripe Invoice — final (70%)** — `POST /admin/booking/:id/send-final`; reuses existing Stripe customer, posts 70% invoice item, finalizes + sends; stores `finalInvoiceId`; sets `finalPaymentStatus: pending`
- [x] **Stripe webhook** — `POST /webhooks/stripe` registered before `express.json()` with raw body; verifies signature; on `invoice.payment_succeeded` advances `depositStatus`/`finalPaymentStatus` to `paid` and flips booking `status` to `in-progress` / `completed`
- [x] **BookingRequest schema additions** — `agreedPrice`, `stripeCustomerId`, `depositInvoiceId`, `finalInvoiceId`, `depositStatus` (none/pending/paid), `finalPaymentStatus` (none/pending/paid)
- [x] **Admin booking UI — payment card** — full state machine: price input + "Send Deposit Invoice (30%)" (disabled until price entered and status ≥ in-review) → "Deposit invoice sent, awaiting payment" → "Deposit received + Send Final Invoice (70%)" → "Final invoice sent, awaiting payment" → "All payments received"
