# Journal

## 2026-07-16 — Ran R2 Folder-Reorganization Migration Against Production, Hardened Script for Missing Objects

**What was built:** `scripts/reorganize-r2-folders.js` run against production with `--execute`, the last open item from `Plans/july26-milestone.md`'s R2 migration section. A dry run first found exactly one leftover flat-keyed object (a chat attachment on `Message`, booking `I07-TI2-QJK`). The real `--execute` pass failed to copy it — "the specified key does not exist" — because that booking had been client-hard-deleted (`filesDeleted: true`, `archived: true`) in the time between building the plan and executing it; the client's hard-delete flow wipes the booking's entire R2 prefix but deliberately leaves `Message.attachments[]` metadata alone (the read path already gates on `filesDeleted` to show a "no longer available" placeholder rather than serving the file). Copy-before-delete meant the failed copy aborted cleanly with nothing corrupted or lost — production simply has zero real flat-keyed objects left.

- **Script hardened against this exact case.** `main()`'s per-item loop (`scripts/reorganize-r2-folders.js`) now does a `headObject(oldKey)` existence check before attempting `copyObject` — if the source is already gone, it logs `SKIP` and moves on (tracked in a new `missing` counter) instead of a scary `FAIL`. Same non-issue, but a future re-run against any new pre-migration leftovers won't misreport a legitimate already-deleted source as an error.

**Decisions made:**
- Left the dangling `Message.storageKey` reference untouched rather than trying to null it out — the app's own `filesDeleted`-gated read path already treats it correctly, and scrubbing it would be scope creep beyond what this cosmetic migration script is for.

---

## 2026-07-15 — Ran R2 Upload Migration Against Production

**What was built:** No code changes. Confirmed the 5 R2 env vars were already mirrored onto the Railway `jarumiristudios` service (`railway variables --kv` matched local `.env` exactly), then ran `scripts/migrate-uploads-to-r2.js upload`/`backfill`/`verify` against production, the last open step from `Plans/july26-milestone.md`'s R2 migration section.

- **`railway run` doesn't reach the container.** The script's own header comment said to run it via `railway run node scripts/...`, but `railway run` executes the command *locally* with Railway's env vars injected — it has no access to the container's persistent `/app/uploads` volume, which is where the script actually needs to read from. Used `railway ssh` instead (installed/registered a local ed25519 keypair via `railway ssh keys add`, since none existed) to exec directly inside the running container.
- **Windows/Git Bash path mangling.** Git Bash's automatic POSIX-path conversion rewrote `/app/uploads` into a Windows path mid-command when passed through `railway ssh --`. Fixed by prefixing invocations with `MSYS_NO_PATHCONV=1`.
- **Result: production had zero legacy local files.** `upload` found 0 paths under `/app/uploads` (only empty `_archive/<crCode>` dirs remained — `lost+found` is an ext4 artifact, not app data), `backfill` updated 0 records, `verify` confirmed 0 `BookingRequest` docs still reference `backend:"local"`. Two `Message` docs still carry `backend:"local"`, but they're empty attachment placeholders (`backend` defaults to `"local"` per `models/shared/fileMetadata.js`; these two have no `storedName`/`size`/`mimetype` at all) rather than real files — not something this script is meant to touch.

**Decisions made:**
- Treated the milestone doc's bake-period item as moot rather than waiting it out — a bake period exists to de-risk a live cutover of files still being actively read from local disk, but there was never any such cutover here since nothing was left on `backend:"local"` by the time this ran. Legacy local-disk code (soft-archive/bulk-archive/restore) is now safe to remove whenever convenient, pending a quick re-check of `backend:"local"` counts first in case new activity landed since.
- Left `scripts/reorganize-r2-folders.js --execute` (folder-key tidiness for pre-existing flat-keyed objects) as a separate, still-open item — it wasn't part of what was asked for this session and isn't required for correctness.

---

## 2026-07-14 — Standalone Signup Page for Brand-New Clients

**What was built:** Shipped in `ebb3885`. The only way to create a `User` account was previously `POST /signup` with a required `crCode` tying the new account to an existing booking — but the Free/Clip tier gate (`enforceFreeTierGates`, `f1b8718`) requires a logged-in account just to submit a booking in the first place, a catch-22 for a genuinely brand-new visitor with no booking yet. `POST /signup` now treats `crCode` as optional (`standalone = !crCode`) — without one it skips the booking lookup, booking-linking, and retroactive-discount logic entirely and just creates a bare `User` (still granted the normal `discountPercent`/`discountExpiresAt` welcome-discount window, redeemable on their first real `/hire` submission). New `GET`/`POST`-backed `/signup` page (`views/signup.ejs`, mirrors `login.ejs`'s layout/style) takes an optional `?next=` redirect target validated as an internal path (`next.startsWith("/")`), rather than the `returnTo`/`crCode` whitelist the embedded-form flow uses. Linked from `/login`'s "sign up" line and from the Free-tier account-required error on `/hire` (`needsSignup` flag renders a "Create a free account" prompt above the form). The nav's "Log In" pill relabeled to "Log In / Sign Up" across `index.ejs`/`hire.ejs`/`career.ejs`/`terms.ejs`.

**Decisions made:**
- Standalone signups render their own inline error (`backTo(error)` re-renders `signup.ejs`) rather than going through `safeSignupReturnTo`'s redirect dance — that whitelist exists only to send embedded-form submitters (on `/hire/success`/`/track`) back to whichever page they came from, which doesn't apply to a page that only signup itself renders.

---

## 2026-07-14 — Round Add-On Prices Up to Whole Cents

**What was built:** Shipped in `669c548`. `addonPriceForTier()` (`server.js`, plus its duplicated inline copies in `admin/booking.ejs`, `associate/booking.ejs`, `dashboard-booking.ejs`, `dashboard-new.ejs`, `dashboard.ejs`, and the landing page's inline pricing script) rounded the tier-scaled add-on price (base × 1.5/2.5, from the `f1b8718` tier-pricing work) to the nearest cent via `Math.round(... * 100) / 100`, which rounds a X.5-cent amount down half the time. Switched to `Math.ceil(base * multiplier)`, which always rounds a fractional result up instead of risking undercharging.

---

## 2026-07-13 — Interactive Pricing Card Add-On Price Display

**What was built:** Shipped in `e1ee335`. `views/index.ejs`'s public `#pricing` section previously showed a single flat "from $X" add-on price list with a static footnote explaining the Scene/Feature multipliers — disconnected from the real tier-scaled add-on pricing shipped earlier the same day (`f1b8718`, next entry below). Add-on prices are now computed client-side and shown live: clicking any of the three pricing cards (`.pricing-card`, new class) highlights it (`tier-selected`, amber ring) and updates every add-on's displayed price via `selectPricingTier(tier, card)` — mirroring the server's `TIER_ADDON_MULTIPLIERS`/`FREE_TIER_EXCLUDED_ADDONS` constants in a small inline `<script>` (`HOME_ADDON_PRICES`/`HOME_TIER_MULTIPLIERS`/`HOME_FREE_EXCLUDED_ADDONS`) — showing "Not included" (in place of a price) for the three add-ons excluded on the Free/Clip tier. Defaults to Scene selected on page load, matching the "Popular" badge.

**Decisions made:**
- Add-on price math duplicated in an inline `<script>` rather than exposed via an API — the landing page's pricing section is static server-rendered markup with no existing round trip, and duplicating three small constant objects is cheaper than adding an endpoint just to avoid it.

---

## 2026-07-13 — Free Tier Replaces $79 Clip Package, Tier-Scaled Add-On Pricing

**What was built:** Shipped in `f1b8718`.

- **Clip package replaced with a gated free tier.** The old $79 Clip package is no longer offered; `pricingTier: "Free"` (still labeled "Clip" in the UI) is a new $0 tier with real gating instead of an open flat price — requires a logged-in account (`enforceFreeTierGates`, `server.js`, a new middleware run before `preCrCode`/multer on `POST /hire`, same cost-nothing-if-blocked pattern as `enforceGuestSubmissionQuota`), capped at one Free-tier submission per rolling 7 days per client (`FREE_TIER_SUBMISSION_WINDOW_MS`), and requires exactly 3 platform links (every other tier still just wants 1-3) so admin can manually vet audience reach before accepting. The historical `"Clip"` enum value stays on `BookingRequest.pricingTier`/`PRICING_TIERS` for old $79 bookings and revenue-by-tier analytics history — new submissions can only ever create `"Free"`, never a fresh `"Clip"`.
- **Testimonial-or-gallery-rights obligation.** Completing a Free-tier booking sets `User.pendingTestimonialObligation`/`pendingTestimonialBookingId` (`notifyStatusChange()`, `server.js`) — the client is blocked from submitting another Free-tier request until they either write a testimonial or grant gallery/distribution rights for the completed one (`POST /dashboard/booking/:id/testimonial`, new route; either field alone satisfies it), which clears the obligation. Surfaced on `/dashboard` as an amber banner with an inline form when pending. Only one obligation can ever be pending at a time by construction — a new Free submission is blocked while one's outstanding, so a second can't be created to stack.
- **Add-on prices now scale by tier.** `addonPriceForTier()`/`addonTotalForTier()`/`isAddonAllowedForTier()` (`server.js`) replace flat `ADDON_PRICES` lookups everywhere pricing is computed — `booking.txt`, the admin new-booking notification, the signup-discount retroactive preview on both `/hire/success` and `/track`, and `/hire`'s own POST handler. Scene is +50%, Feature +150%; Free and Custom stay at the 1x base. Captions, Intro/outro bumper, and Extra revision aren't offered on Free at all — `allowedAddOns` filters them server-side before persisting even if a client-side glitch let one through the form.
- **Bug fixes from the tier rename.** Admin/associate-facing pricing logic previously branched on "does `TIER_PRICES` have an entry for this tier" to decide "unpriced, don't show an add-on breakdown" (the `Custom` case) — since the trimmed `TIER_PRICES` object also has no entry for `Free`, it silently fell into the same unpriced branch across the client-facing estimate, the deposit-amount prefill, and admin's new-booking notification, hiding real (if $0-base) add-on charges. Fixed by branching on `pricingTier !== "Custom"` explicitly instead, now that `Free` legitimately prices at $0 base + a real add-on total.

**Decisions made:**
- Old `"Clip"` enum value kept rather than migrated or removed — it's load-bearing for every already-shipped $79 booking and for revenue-by-tier analytics history; `"Free"` is a deliberately distinct value so a query or report can't accidentally conflate the two.
- Free tier requires an account rather than being guest-eligible — both the weekly cap and the testimonial obligation need to key off something a client can't just clear (an anonymous visitor cookie can), the same reasoning `hasCompletedProjectHistory`'s guest-vs-account trust tiering already established elsewhere in the app.
- Testimonial/gallery-rights modeled as an "either satisfies it" pair, not two separate requirements — it's a trade for a free edit, not a mandatory content contribution; a client uncomfortable giving a public testimonial can grant rights instead, or vice versa.

---

## 2026-07-13 — Track Page Login Invite Card

**What was built:** Shipped in `6adfd74`. `/track` gained a standalone "Already have an account? Log In" card (`views/track.ejs`), placed right after the two lookup-method forms and before any lookup has run. Links straight to `/login?next=/dashboard`. Distinct from the existing per-booking account nudge (`trackAccountNudge()`, 2026-07-11 entry below) — that one only renders after a successful lookup and only for the specific booking's email, so a returning client who just wants to log in (and doesn't want to hunt down a BR code or retype their name/email first) previously had no way in from this page at all.

**Decisions made:**
- Rendered unconditionally, ahead of the lookup forms, rather than folded into `trackAccountNudge()` — that helper only runs once a booking is loaded and is scoped to whether that specific email has an account; this card doesn't need a lookup to have happened at all.

---

## 2026-07-12 — Signup Discount Eligibility Gate Broadened, Booking-Hijack Guard

**What was built:** Shipped in `ebb5766`. Two correctness fixes to the signup welcome discount's abuse gating, prompted by a walkthrough of what happens when an anonymous client submits repeatedly without ever creating an account.

- **`returningEmail` broadened from "ever owned an account" to "ever submitted a booking under this email at all."** The `4db3d62` version of this check (see below) only disqualified an email if a past booking under it had `clientId` set — so a guest who submitted and even fully paid/completed a project as a pure guest (deposit + final invoice paid via emailed Stripe links, no account ever created) still read as "not returning" and could claim the welcome discount on a later signup. Worse, a guest who submitted one unpaid booking, abandoned it, and came back later with a second booking under the same email also still qualified as "new," since the first booking's `clientId` was still `null`. All three call sites that read this check — `POST /signup`, `trackAccountNudge()` (used by `GET /track`), and `GET /hire/success` — now query `BookingRequest.exists({ email, _id: { $ne: booking._id } })` with no `clientId` filter, so *any* prior submission under that email (paid, unpaid, declined, or completed) disqualifies it. Confirmed with the client that a declined/spam-rejected first attempt should still count as disqualifying — no separate carve-out for it.
- **Booking-hijack / discount-stacking bug closed.** `retroactiveEligible` never checked whether the *booking itself* already had a `clientId`, and `POST /signup` had no ownership guard before this fix — so the same `crCode` could be POSTed to `/signup` repeatedly, each time with a fresh, never-before-seen email. Since `returningEmail` is evaluated against the *new* email's history, not the booking's, each repeat pass read as eligible again, stacking another 15%-off coupon onto the same booking's `discountAmount` and silently reassigning its `clientId` to the newest account. `POST /signup` now redirects to `/login?next=/dashboard&cr=<crCode>` up front if `booking.clientId` is already set, reusing the same "you already have an account, log in to link this" flow the GET pages already show for linked bookings, instead of ever re-processing a claimed booking.

**Decisions made:**
- Declined bookings still count as a disqualifying prior submission — client's explicit call, keeping the literal "brand new = never submitted before" rule rather than carving out an exception for rejected first attempts.
- Disposable-email farming across genuinely separate bookings (submit as guest, sign up with a fresh throwaway email each time) left open — closing it would mean keying eligibility off `visitorId` instead of/in addition to email, which risks false-blocking legitimate users on shared devices/networks or after a cleared cookie; deferred pending a separate design conversation rather than rushed into this patch.
- Booking-hijack guard implemented as an early redirect to the existing login flow rather than adding `!booking.clientId` into the `retroactiveEligible` condition — the latter would silently no-op the discount but still let the re-signup attempt through and steal the booking's `clientId`; the real correct action for an already-linked booking is logging into the account that owns it, which `/login?cr=` already supports.

---

## 2026-07-12 — Retroactive Signup Discount Application, Pre-Signup Incentive Cards, UI Polish Pass

**What was built:** Shipped in `bddbf7f`, two batches bundled in one working session — a follow-up to the signup welcome discount (`ce11320`/`4db3d62`, both below) and a cosmetic pass across the public/dashboard/admin/associate views.

- **Retroactive discount application.** The welcome discount previously only applied to a booking submitted *after* signup (i.e. you needed an account already to see it auto-apply on `/hire`). Now `POST /signup` — called from both `/hire/success` and `/track`'s inline signup form — applies the 15% discount directly to the triggering booking at signup time if it's still eligible (`retroactiveEligible`: no returning-email match, `!booking.agreedPrice` — admin hasn't priced it yet — and not `declined`/`completed`). This is what actually makes it an acquisition incentive ("sign up now, save 15% on *this* project") rather than only a reward discovered on some hypothetical next one. Once a booking has `agreedPrice` set, editing `couponCodes`/`discountAmount` has zero real billing effect (Stripe invoices are keyed off `agreedPrice` alone), so that's the natural, abuse-proof cutoff. `User.discountUsed` is set `true` immediately when applied this way (`discountAppliedRetroactively`), so the same account can't also redeem it on a later `/hire` submission.
- **Pre-signup preview cards.** `GET /hire/success` and `GET /track` (via `trackAccountNudge()`) now run the same eligibility/amount check ahead of time and pass a `signupDiscountPreview` (`{ eligible, amount }`) into the view — the "create an account" card swaps its generic copy for "Save $X on this project" when eligible, so the offer shown matches what signing up will actually apply (same subtotal/discountAmount math as the real `/signup` handler, factored into a shared `calcPercentDiscount(base, percent)` helper). `/hire`'s in-progress price-estimate box also gained a persistent "Get 15% off" incentive card for logged-out users, with the live-computed amount injected into `#signup-incentive-amount` alongside the existing subtotal recompute.
- **UI polish pass**, unrelated to the discount work, across most public/dashboard/admin/associate views: arrow glyphs (`→`/`←`) stripped from button/link copy site-wide in favor of `capitalize` styling, except where an arrow still adds real affordance (view-project links, empty-state CTAs, back-links) — those got an actual `iconify-icon` glyph instead of a text arrow. `rounded-2xl`/`rounded-xl` card corners tightened to `rounded-md` in several spots (`hire.ejs`'s success-page cards, price-estimate box, identity strip). Em-dashes (`—`) used as placeholder/empty values swapped for plain hyphens (`admin/_results-table.ejs`, `dashboard.ejs`'s money columns). `hire.ejs`/`dashboard-new.ejs`'s ToS/email-consent checkboxes restyled from native checkboxes to `iconify-icon` check/uncheck glyphs toggled via a `peer`/`sr-only` pattern.
- **Submit button gated on ToS agreement.** Both `/hire` and `/dashboard/new`'s final-step submit button now starts `disabled` and only enables once the `tosAgreed` checkbox is checked (`updateSubmitState()`), matching the server-side requirement (`4db3d62` already rejected the POST without it) with an equivalent client-side affordance instead of letting the click round-trip to a validation error.
- **`hire.ejs`'s price-estimate box now repositions itself per step** (`placePriceEstimate()`) — it used to sit in one fixed spot in the DOM, but the new per-step `id="step-N-actions"` markup needs it to always render directly above whichever step's Back/Continue row is currently visible.

**Decisions made:**
- Retroactive-eligibility math duplicated (not factored into one shared function) across `trackAccountNudge()`, `GET /hire/success`, and `POST /signup` — each call site already has a different subset of the booking loaded/selected, and the calculation itself is three short lines built on the same `calcPercentDiscount` helper, so sharing more than that would mean passing awkward partial-booking objects around instead.
- Arrow-to-icon swap applied selectively, not blanket-removed — links that navigate to another view (view project, back to list, empty-state CTA) kept a directional glyph since it's real affordance there, while plain step-navigation buttons (Continue, Back, Apply, Done) just lost the arrow since the button's position/label already implies direction.

---

## 2026-07-12 — Signup Discount Bug Fixes, Booking Consent Checkboxes, Notification Preferences, 404 Page

**What was built:** Shipped in `4db3d62`, closing several correctness bugs introduced by the signup welcome discount (`ce11320`, next entry below) plus three unrelated additions bundled into the same commit.

- **Signup-discount bug fixes:**
  - **Double-apply race closed.** The discount was previously read-then-flip-later (a `User.findById` eligibility check, then a `discountUsed: true` write after the booking saved) — two concurrent submissions from the same account could both pass the read before either write landed, applying the discount twice. Now claimed atomically up front via `User.findOneAndUpdate({ discountUsed: false, ... }, { discountUsed: true })` (`discountClaimPromise`), run in parallel with the manual-coupon lookups since it doesn't depend on their result.
  - **$0-discount burn fixed** — if the claimed discount computes to $0 (e.g. a manual coupon already zeroed the running subtotal), the claim is released (`discountUsed: false` rolled back) instead of permanently burning the one-time discount for no benefit. Same rollback added in the `catch` block if the booking save itself fails.
  - **`WELCOME` coupon-code collision** — a manually-typed coupon code of literally `WELCOME` is now skipped (`rawCode === SIGNUP_DISCOUNT_CODE`) since that string is reserved for the auto-applied signup discount; `POST /admin/coupons` also now rejects creating a real coupon with that code.
  - **"Coupon (WELCOME)" mislabeling** and **analytics KPI pollution** — the auto-applied discount was previously indistinguishable from a real coupon in `/admin/analytics`'s coupon-usage stats; the analytics aggregation now filters `couponCodes` down to `realCouponCodes` (excluding `code === "WELCOME"`) before computing `hasCoupon`/`totalDiscount`.
  - **Redundant Mongo round-trips** collapsed — the eligibility check and the claim used to be two separate queries; now one `findOneAndUpdate`.
  - **Unescaped name in the reminder email** — `sendSignupDiscountReminderEmail`'s `Hi ${user.name}` interpolation is now HTML-escaped.
  - **Re-signup-after-deletion loophole closed.** Deleting an account (`POST /dashboard/account/delete`) hard-deletes the `User` but leaves past bookings' `clientId` intact — previously a client could delete their account and sign up again under the same email to re-earn the discount. `POST /signup` now checks `BookingRequest.exists({ email, clientId: { $ne: null }, _id: { $ne: booking._id } })` (`returningEmail`) and skips granting `discountPercent`/`discountExpiresAt` on the new `User` if any past booking under that email was ever account-linked.
- **Booking consent checkboxes.** `/hire` and `/dashboard/new` both gained a required "I agree to the Terms of Service" checkbox (`tosAgreed`, rejected server-side alongside the existing field validation) and an optional "Send me occasional email updates" checkbox (`emailConsent`). `BookingRequest` gained `tosAgreedAt`/`emailConsent` fields recording the submission-time consent.
- **Notification preferences.** `User.notificationPreferences.emailUpdates` (defaulted from the booking's `emailConsent` at signup time) gates non-essential reminder/status/promo emails; a new toggle on `/dashboard/account` (`POST /dashboard/account/notifications`) lets a client change it later. Transactional email (invoices, password reset, etc.) is unaffected by the flag.
- **404 page.** A catch-all `app.use((req, res) => res.status(404).render("404"))` (registered after every real route) renders a new branded `views/404.ejs`, replacing whatever Express's default plaintext 404 was serving.
- **Sidebar link/label text lightened** for readability on both `admin/_sidebar.ejs` and `associate/_sidebar.ejs`.

**Decisions made:**
- Discount eligibility check split into a display-only helper (`welcomeDiscountEligible()`, used just to decide what to show) vs. the atomic claim at actual booking-save time — showing the discount and consuming it are different operations, and only the consuming one needs race protection.
- `returningEmail` keyed on "any past booking under this email was ever account-linked," not on "a `User` currently exists for this email" — the latter is trivially false right after a self-delete, which is exactly the loophole being closed.

---

## 2026-07-12 — Signup Welcome Discount

**What was built:** Shipped in `ce11320` (bugs found and fixed the same day in `4db3d62`, previous entry above). A first-booking acquisition incentive: signing up grants a 15%-off coupon usable on the next `/hire` submission.

- **`User` schema gained `discountPercent`/`discountExpiresAt`/`discountUsed`/`discountReminderSent`.** Every new signup (`POST /signup`) gets `discountPercent: 15`, `discountExpiresAt: now + 15 days`.
- **Auto-applied on `/hire`'s POST handler** — if the logged-in account has an unused, unexpired discount, it's pushed onto `couponCodes[]` as a `WELCOME`-coded entry on top of whatever manual coupons were applied, and `discountUsed` flips `true` once the booking saves.
- **`GET /hire` shows a "welcome discount" badge** (`welcomeDiscount: { percent }`) when eligible, both on first load and on re-render-after-a-validation-error.
- **`lib/discountExpiry.js` (new), an hourly job** (`startDiscountExpiryJob()`, same cadence/pattern as `lib/invoiceExpiry.js`) — finds accounts with an unused discount expiring within 3 days that haven't been reminded yet, emails `sendSignupDiscountReminderEmail` and creates a `due_date_reminder` `Notification`, marking `discountReminderSent` so it only fires once per account.

**Decisions made:**
- 15% / 15-day window chosen as the initial offer parameters (`SIGNUP_DISCOUNT_PERCENT`/`SIGNUP_DISCOUNT_WINDOW_MS`) — a first-pass acquisition incentive, easy to tune later since both are top-level constants.
- Reminder job mirrors `invoiceExpiry.js`'s existing hourly-poll-plus-flag pattern rather than a scheduled cron entry — keeps the "in-process interval job driven off Mongo-backed state" convention this codebase already uses, instead of introducing a second job-running mechanism.

---

## 2026-07-12 — Dashboard Invoices Page, Notifications Search/Filter, Attachment Preview Privacy Fix

**What was built:** Shipped in `9f74f49`, three unrelated changes bundled in one working session.

- **`/dashboard/invoices` (new route + `views/dashboard-invoices.ejs`).** The sidebar already linked here (from an earlier commit) but the page didn't exist. Flattens every booking's deposit (30%), final payment (70%), and any ad-hoc `revisionInvoices[]` entries into one list, newest-first by due/created date, each row showing project code (links to `/dashboard/booking/:id`), a status pill (`pending`/`paid`/`void`), due date (pending only), amount, and a Pay now/View link out to the Stripe-hosted `invoiceUrl`. Same search (by project code) + status-filter-dropdown pattern as the messages/notifications inboxes, with separate mobile-card and desktop-table layouts. Archived-and-files-deleted bookings (`filesDeleted: true`) are excluded from the query.
- **Notifications page search/filter.** `views/dashboard-notifications.ejs` gained the same search-input-plus-filter-dropdown treatment already used on messages/invoices — two independent axes (date range: all/today/this week/this month; notification type: status update/invoice sent/payment confirmed/due date updated/due date reminder/deliverable ready), a filter-count badge, and a dedicated "no notifications match" empty state distinct from the true-empty state. The static page header ("Notifications" / "Updates on your projects.") was removed to make room.
- **Attachment previews now show a file-type label instead of the filename.** `attachmentTypeLabel(mimetype)` (`server.js`, plus an inline-arrow-function duplicate in each EJS template that doesn't have server-side access to the helper) maps a mimetype to `Image`/`Audio`/`Video`/`File`. Replaces the original filename in every place a message preview is shown out of context: thread-list last-message previews (admin/associate/client `messages.ejs`), the reply-preview quote block and its live-inserted equivalent (`_message-thread-panel.ejs` × 3 portals, `_message-thread-script.ejs`), and `buildReplySnapshot()`'s frozen `attachmentSummary`. A sent filename could be identifying or sensitive on its own (e.g. a client's real name or project detail baked into a file they uploaded) and was never actually useful in a list row anyway — knowing "an image was sent" is enough context, the file itself is one tap away.

**Decisions made:**
- `attachmentTypeLabel` duplicated inline in each EJS template rather than centralized in one shared JS file — matches the existing pattern already used for other tiny cross-portal helpers in this codebase (e.g. the reply-attachment-summary logic itself, pre-existing), and avoids adding a new shared client-side script just for a 4-line regex switch.
- Invoices page reuses the message/notification inbox's search+filter dropdown pattern verbatim (same markup/JS shape) rather than inventing a new UI for a third list page — keeps all "search a list of project-scoped things" pages feeling identical.

---

## 2026-07-12 — Unify Local/R2 Upload Folder Layout

**What was built:** Shipped in `e580943`. Both storage backends now share one folder shape: `<crCode>/{raws,finals,chats/clients,chats/associate}` — replacing R2's previously-flat `<crCode>/<storedName>` keys and local disk's differently-nested (`files/<type>/`, further split by staff identity per the commit below) layout. `raws` is client-submitted files (no more video/audio/image/other split), `finals` is delivered deliverables (no more per-staff split), and chat attachments now split only client-vs-staff (`chats/clients/` or `chats/associate/`, the latter shared by admin and every associate) rather than by individual account.

- `createR2Storage`/`createLocalStorage` (`lib/r2MulterStorage.js`/`lib/localMulterStorage.js`) both take a `getFolder(req, file)` function now, resolving to the same four folders on either backend.
- Since folder is now part of the R2 object key (previously DB-only metadata), "save chat attachment to project files" is no longer a no-op DB update — `moveStoredFile` (`server.js`) performs a real R2 copy+delete via a new `copyObject` (`lib/r2.js`).
- `scripts/reorganize-r2-folders.js` (new) — dry-run-by-default migration to move existing R2 objects (and their DB `storageKey`) from the old flat scheme onto the new nested one, deduplicating by object key so a file referenced by both a `Message` attachment and a `BookingRequest` file entry is only copied once. **Not yet run against production** — validated against the local dev DB and a live R2 bucket in isolation, but production's actual database lives elsewhere and this local machine can't safely target it (see `Plans/july26-milestone.md`).
- Every read/delete path resolves a file by its stored `storageKey` directly rather than recomputing it, so old flat-keyed docs keep working unchanged whether or not the migration script is ever run — this is a console-tidiness migration, not a functional requirement.

**Decisions made:**
- Chat attachments split client-vs-staff only, not per individual associate — the R2-console-tidiness goal doesn't need per-editor granularity, superseding the previous commit's per-associate-ID local split.
- Migration script defaults to dry-run and wasn't executed here — production data lives on a separate Mongo instance this session can't see; running the real copy+delete against local dev records risked permanently breaking live download links for documents production's DB still references by the old key.

---

## 2026-07-12 — Fix Stray Empty-State Placeholder on First Chat Message

**What was built:** Shipped in `bd2afb0`. `renderMessage()` appended a new bubble straight into `#message-list` without removing the server-rendered "No messages yet" placeholder — that placeholder is `h-full`, so it pushed a freshly-sent first message out of the visible chat flow (present in the DOM, just scrolled out of view). Fixed across all three thread-panel templates (client/admin/associate) by removing the placeholder the first time a message renders into the list.

---

## 2026-07-12 — Split Local Chat/Deliverable Storage by Uploader Identity

**What was built:** Shipped in `ff9764c`. Local-disk uploads (`STORAGE_BACKEND=local`, see the entry below) were dumping every chat sender (client/admin/associate) and every deliverable uploader (admin/associate) into one shared folder each — harmless for R2, where folder was DB metadata only, but not representative of any real per-account separation. `Message.senderAssociateId` (new) and the shared file-metadata schema's `uploadedByAssociateId` now drive per-account subfolders under `uploads/<crCode>/files/{chat,deliverables}/<client|admin|associate-id>/`. R2 keys were untouched by this — folder is metadata there, never part of the object key (until the next commit changed that).

**Decisions made:**
- Scoped to local disk only — R2's flat-key/DB-metadata design at the time didn't need this, and the split was superseded by the next commit's shared-key-scheme change anyway.

---

## 2026-07-12 — Associate Notifications, Download-Tracking Fix, Local Dev Storage Backend

**What was built:** Shipped in `e2a3f31`.

- **`AssociateNotification` model** (`assignment`/`payment`/`files_added` types) + `/associate/notifications` page, `/api/associate/notifications/poll` (unread count + new items since a timestamp), `/api/associate/notifications/mark-read` — same pattern as the existing admin/client notification feeds. Fired on: a Stripe deposit/final payment landing on an assigned booking, a client adding files to an assigned booking (alongside the existing admin `files_added` alert), and being newly assigned/reassigned a project (`/admin/booking/:id/assign`).
- **Unclaimed threads surfaced to every associate.** `unclaimedChatUnlockedBookingIds()` — a project nobody's claimed yet still has chat unlocked once accepted (purely status-based), so its unread client messages are now folded into every associate's unread-message poll/badge (`/api/associate/messages/poll`, the `/associate` `res.locals` middleware) alongside their own assigned bookings, tagged `unclaimed: true` so the UI can distinguish "yours" from "anyone's to grab."
- **Fixed the file-viewer sidebar over-marking attachments "downloaded."** The viewer's sidebar grid (added in `a806f0f`, below) silently pre-fetches every project attachment as a thumbnail, which was hitting the same `/admin|associate|dashboard/messages/attachments/:filename` route the real download link uses — flipping `downloaded: true` on files nobody had actually opened. Both routes now only flip it when the request explicitly carries `?downloaded=1`, sent only by the real open/download links, not the sidebar's silent pre-fetch. The sidebar also now blurs not-yet-downloaded images/videos, matching the chat bubble's existing lazy-load treatment.
- **`STORAGE_BACKEND=local` dev switch.** New `lib/localMulterStorage.js` (mirrors `r2MulterStorage`'s `_handleFile`/`_removeFile` callback shape) lets all four multer instances (`upload`/`deliverableUpload`/`chatUpload`/`applicationUpload`) write to local disk instead of R2 when the env var is set (in the gitignored `.env`) — avoids needing live R2 credentials or hitting R2's presigned-URL CORS restrictions during local dev. Never set in the deployed environment, so production is unaffected.

**Decisions made:**
- Unclaimed-thread visibility implemented as "fold into every associate's badge count," not a separate inbox section — keeps the existing poll/badge plumbing as the single source of truth for "do I need to look at something."
- `downloaded` gated on an explicit query param rather than trying to distinguish request intent server-side some other way — cheap, and the sidebar was the only caller that needed to opt out.

---

## 2026-07-12 — Message Editing, Reply-Quote Bug Fix, Viewer Zoom/Pan

**What was built:** Shipped in `a806f0f`. Follow-up polish on top of the reply-to feature shipped in `ddc8a10` (next entry below).

- **Message editing.** `Message.edited` (boolean, new field). `POST .../messages/:messageId/edit` added on all three send surfaces (`/admin/booking/:id/messages/:messageId/edit`, `/associate/booking/:id/messages/:messageId/edit`, `/dashboard/messages/:id/:messageId/edit`) — sender-and-not-deleted only, text-only (rejects an empty body unless the message still carries an attachment), sets `body`/`edited: true`, broadcasts `message-edited` to the socket room. Client-side, `window.editMessage()` puts the composer into an edit mode (attachment picking disabled for the duration, since there's no attachment-edit endpoint) with an amber "Editing message" bar mirroring the existing reply-preview bar; submitting posts to the new edit route instead of sending a new message, and both the sender's own optimistic update and the `message-edited` socket event on the other party's screen go through the same `applyMessageEdited()` to patch the bubble's text and stamp an "edited" label next to the timestamp.
- **Fixed a reply-quote bug from `ddc8a10`.** All three thread-panel templates guarded the reply-quote block on `if (m.replyTo)`, but Mongoose always hydrates a single-nested-schema path as an object (never `undefined`) on a non-`.lean()` document — so every message, reply or not, rendered as if it had a quote. Changed to check a real sub-field (`m.replyTo && m.replyTo.messageId`) in both the server-rendered EJS and the client-side `buildThreadRowHtml()`.
- **File viewer: every chat-sent file is now browsable, not just the project's own uploads.** The viewer's file list previously only pulled from `booking.uploadedFiles`; it now also walks every non-deleted message's attachments, deduped by `storedName` against the project files (a tagged attachment is both — the project-files URL wins for those).
- **File viewer gained zoom/pan on images** — scroll-wheel zoom (continuous, proportional to scroll magnitude, not fixed steps), click-to-zoom-to-2.5x/click-to-reset, and drag-to-pan once zoomed, all driven by a single CSS `translate()+scale()` transform on the image rather than resizing it or relying on native scroll (which only has room to move on whichever axis overflows for a given aspect ratio). Resets on every file switch.
- **Thread-list thumbnail reverted to always show the project's own uploaded file**, never the most recent chat attachment — the previous "most recent media attachment, falling back to project file" logic in `admin/associate/dashboard`'s `messages.ejs` thread-row rendering is gone; a chat attachment is one-off content, not representative of the project.
- **Selection-mode UI reworked.** The per-message select radio and action buttons (delete/reply/edit) now render with a visible background at all times instead of fading in via `opacity` only while `#message-list.selecting` — makes them discoverable without first triggering selection mode, especially on touch where there's no hover to reveal them. Multi-selecting more than one message now hides the reply and edit actions (both only make sense against a single message) via `#message-list.multi-selecting`.
- **Flash-highlight (jump-to-message via a reply quote) reworked** from a `box-shadow` animation on `.bubble` to a background color ribbon behind the whole row (`.bubble-row::before`), since the box-shadow version was easy to miss against the bubble's own background. The "theirs" bubble's background is only 6% opacity, so it needed an opaque backing added just while highlighted or the ribbon would bleed straight through it.
- **Bug fix: an attachment's caption could force the whole bubble too wide.** The caption span wasn't participating in the bubble's `fit-content` width calculation the way the image itself was (post-shrink), so a caption wider than the image would stretch the bubble and strand the image with a gap. Scoped `contain: inline-size` fix to `.bubble:has(.attachment-badge) .bubble-body-text` only — tagged-file chips render as a small inline icon+filename and shouldn't be affected.

**Decisions made:**
- Edit is text-only (no attachment editing) — there's no attachment-edit endpoint, and the composer's attachment-picking UI is simply disabled while `editState` is active rather than trying to support swapping attachments on an existing message.
- `edited` is a separate boolean flag rather than inferred from `updatedAt !== createdAt` — explicit and avoids false positives from any other future field getting touched on `.save()`.
- Selection-mode discoverability (backgrounds always visible) traded a small amount of visual quietness for touch-device usability, now that edit is a third action stacked into the same per-message button row.

---

## 2026-07-12 — Message Reply-To With Quote Display, Gallery Filter Overhaul

**What was built:** Shipped in `ddc8a10`.

- **Reply-to.** `Message.replyTo` — a frozen snapshot (`messageId`, `senderRole`, `body`, `attachmentSummary`) written at send time via a new `buildReplySnapshot()` helper (`server.js`), wired into all three message POST routes (admin/associate/client). Frozen rather than a live-populated ref so a later edit or delete of the original message doesn't retroactively change what an existing reply's quote displays. Selecting a message and hitting its reply action shows a reply-preview bar above the composer; the sent message renders a clickable reply-quote block inside its bubble that scrolls/flashes to the original when clicked (`window.scrollToMessage()`).
- **Thread panels moved from delete-on-hover to a selection mode** — long-press (mouse-hold or touch-hold, 500ms) a bubble to select it and reveal its actions (delete/reply, now also edit — see the entry above), replacing the old hover-only delete icon. Reply is hidden once more than one message is selected since it only makes sense against a single message.
- **Gallery overhaul** (`dashboard-gallery.ejs`) — the pill-button type filter (`All`/`Video`/`Audio`/`Image`/`Other`) replaced with a dropdown, and selecting a specific type now switches to a flat file-grid view (every matching file across every project, one tile each) instead of just re-filtering within each project's card. Sort-by-oldest option removed (newest-first only, matching how the rest of the app already defaults). Gallery modal gained a responsive mobile layout (file panel moves below the media player under 767px instead of squeezing beside it).
- **Cosmetic:** the mobile hamburger menu icon is now always white instead of gray-then-white-on-hover, across every dashboard/admin/associate page — a small consistency fix bundled into this commit.

**Decisions made:**
- `replyTo` frozen at send time rather than a live ref — matches the reasoning already used for `Application.roleTitle` (see the 2026-07-11 associate-portal entry): a reference should still show what it pointed at even after the original changes or disappears.
- Selection mode (long-press to reveal actions) replaces hover-to-reveal — hover has no equivalent on touch devices, and a growing number of per-message actions (delete, reply, and soon edit) don't stack cleanly as always-hover-visible icons at bubble width.

---

## 2026-07-11 — Terms of Service Page

**What was built:** Shipped in `e496739`. A standalone `/terms` route (`server.js`) rendering a new `views/terms.ejs` — a full Terms of Service page (25 sections: eligibility/age requirements, how requests/pricing/deposits/revisions/final payment work, account and deletion behavior, content ownership and the hard line on content the studio won't work with, platform responsibility, privacy, refunds, liability, governing law) styled to match the public site's dark/amber look, with a sticky searchable table of contents (client-side substring filter over each section's text, not just its heading) and scroll-spy active-section highlighting. Linked from the footer nav on both `views/index.ejs` and `views/career.ejs` (`/dashboard`/admin footers untouched).

**Decisions made:**
- Written as a standalone EJS page with its own `<head>`/nav/footer rather than reusing a shared layout partial — matches how `career.ejs`/`index.ejs` are already each fully self-contained rather than composed from a shared shell.
- Governing-law jurisdiction left as an explicit `[jurisdiction to be specified]` placeholder rather than guessed — a legal detail that needs the client's actual input, not one to invent.

---

## 2026-07-11 — Returning-Client Trust Tier, Stale-Final-Invoice Auto-Archive, Track Page Account Nudge

**What was built:** Shipped in `ae4471e`.

- **"Returning client" trust tier, shipped** — the exact nice-to-have flagged as deferred in `Plans/july26-milestone.md` when the guest/account upload-trust system first went in. `hasTrustedDepositHistory(userId)` (`server.js`) is now `hasCompletedProjectHistory(userId, visitorId)` — instead of only trusting a logged-in account with a past `depositStatus: "paid"` booking, it now matches on `$or: [{ clientId }, { visitorId }]` with `status: "completed"`. Two changes from the original gate at once: the bar moved from "paid a deposit" to "actually finished a project" (a paid-then-abandoned/declined project no longer earns trust), and the check now also recognizes an anonymous repeat visitor via the long-lived visitor cookie, not just an account holder — matching this app's existing pattern of extending account-gated privileges to recognized anonymous visitors (see the guest-quota tiering). Wired into `enforceGuestSubmissionQuota` (exempt from the 1-per-24h guest quota), and the upload-trust gate on `/hire` GET/POST and `/dashboard/new`. Copy on `hire.ejs`/`dashboard-new.ejs`'s "uploads locked" notice updated to describe both routes to trust ("once you've completed a project with us before, or once this request has been approved") instead of only the approval path.
- **Compound index `{ visitorId: 1, createdAt: -1 }` added on `BookingRequest`** (`models/BookingRequest.js`) — the exact follow-up flagged 2026-07-04 when the guest-quota `exists()` check was first noted as an unindexed scan. The same index was also added on `Application` (`models/Application.js`), since `enforceApplicationSubmissionQuota` does the identical visitorId+createdAt scan and had the same gap.
- **Stale-after-final-expiry auto-archive.** New `checkStaleAfterFinalExpiry()` (`lib/invoiceExpiry.js`), run hourly alongside the existing deposit/final expiry checks. `checkExpiredFinalInvoices` deliberately stopped nulling `finalDueDate` when it flips an expired invoice to `finalPaymentStatus: "none"` (previously cleared) — it stays as the anchor timestamp the new check waits 3 days (`FINAL_EXPIRY_ARCHIVE_GRACE_MS`) past before archiving the booking (`archived: true`) if no fresh final invoice has superseded it. On archive: `sendProjectArchivedEmail`/`sendAdminProjectArchivedAlert` (`lib/mailer.js`, new) go out, plus a `project_dismissed` `Notification` for account holders. `archiveBookingFolder(crCode)` (`lib/uploadUtils.js`, new) was extracted from what used to be inline `fs.rename` logic duplicated across the single and bulk admin-archive routes in `server.js` — now shared by those two routes and both automated archive paths. The existing deposit-expiry auto-decline (`checkExpiredDeposits`) also now sets `archived: true` and calls the same helper (previously left the booking merely `declined`, un-archived) — a declined-for-nonpayment project's files come off active storage immediately instead of waiting on a manual archive.
- **Track page account nudge.** A booking on `/track` with no linked `clientId` now shows a card (`views/track.ejs`) — "log in to link this booking" if a `User` already exists for that email (`trackAccountNudge()`, `User.exists`), otherwise an inline create-account form (email prefilled read-only, password only) posting straight to `/signup`. `/signup` (`server.js`) generalized to redirect failures back to whichever page it was actually submitted from via a new `returnTo` field — `safeSignupReturnTo()` whitelists `returnTo === "track"` (+ `crCode`) against the prior hardcoded `/hire/success?cr=` fallback, since `returnTo` is client-supplied and blindly trusting it would be an open-redirect risk.
- **Admin archived-tab status filtering.** `/admin`'s status filter dropdown (`views/admin/_filter-summary.ejs`) was previously hidden entirely whenever `archivedView` was true; now shown (only `completedView` still suppresses it), and its self-generated links now preserve `view=archived` so switching status while already on the Archived tab doesn't silently bounce back to Active. Matters now that an archived booking can carry a distinct, filterable status (declined via the auto-decline path above, or completed-then-tidied-away).
- **Archived-vs-declined branch order fixed** on both `views/track.ejs` and `views/dashboard-booking.ejs` — the archived-status branch was checked before the declined one, so a booking that's both (now possible via the deposit-expiry auto-archive above) would show generic "archived" copy instead of "request declined." Declined now takes priority.
- **`dashboard-booking.ejs`'s "Due by" line** now also requires `finalPaymentStatus === 'pending'`, not just a truthy `finalDueDate` — needed because `finalDueDate` is deliberately no longer cleared on expiry (see above), so without this an expired invoice would keep showing a "due by" date for a deadline that already passed.
- **`hire.ejs` nav header polish** — the plain "← Back to site" link replaced with Login / Book a Project pill buttons, matching the header treatment used elsewhere in the app.

**Decisions made:**
- Returning-client trust keyed on `status: "completed"` rather than `depositStatus: "paid"` (the prior bar) — a paid-but-later-abandoned or declined project shouldn't earn upload trust, only one that actually finished.
- Checked by visitorId OR clientId rather than requiring an account — the original deferred note framed the tier as "≥1 completed project," not "≥1 completed project on an account," and anonymous-but-recognized trust is already how the guest quota itself works.
- `finalDueDate` left un-cleared on expiry instead of adding a new "expired at" field — every other read site was audited and gated on `finalPaymentStatus` alongside it, so the field could be safely repurposed as the grace-period anchor.
- `archiveBookingFolder` extracted once a third call site needed the same `fs.rename` logic — same "extract on second/third duplication" pattern already used for the Stripe invoice-creation functions (see the 2026-07-11 associate-portal entry below).
- `returnTo` whitelisted against known values (`"track"`) rather than trusted as a raw redirect target — avoids turning a convenience field into an open redirect.

---

## 2026-07-11 — Cloudflare DNS Zone Export

**What was built:** Shipped in `8857eec`. Added `jarumiristudios.com.txt`, a BIND-format DNS zone export from Cloudflare for the client's domain (NS/SOA/CNAME-to-Railway/MX/TXT records including DKIM and the Railway domain-verification TXT) — an informational/archival snapshot of the current DNS configuration, not a config file the app reads.

**Decisions made:**
- Committed as a plain archival snapshot rather than wired into any infra-as-code tooling — this project has no DNS-as-code setup, so the export's purpose is a point-in-time backup/reference for the client handoff (see `Plans/july26-milestone.md`'s Handoff section), not a live-managed file.

---

## 2026-07-11 — Sidebar Nav for Admin/Associate, Associate Messages Inbox, Admin Completed Tab

**What was built:** Shipped in `257e558`. Follow-up polish on top of the associate portal shipped in `058f53e` (next entry below).

- **Sidebar componentization.** Both the admin and associate portals moved from a horizontal top-header nav to a persistent left sidebar (`views/admin/_sidebar.ejs`, `views/associate/_sidebar.ejs`, both new), matching the pattern the client dashboard has used all along — mobile hamburger + overlay, same `.sidebar-link` styling (new shared class added to `src/input.css`'s `@layer components`). Every admin/associate page (`dashboard`, `analytics`, `booking`, `coupons`, `associates`, `roles`, `notifications`, `messages`) now `<%- include('_sidebar', { active: '...' }) %>`s instead of duplicating header markup, and wraps its `<main>` in `lg:ml-55` to make room for the fixed sidebar.
- **Associate Messages inbox built out to parity with admin/client.** New routes `GET /associate/messages`, `/associate/messages/archived`, `/associate/messages/:id` (`server.js`) backed by `associateMessageThreads(associateId, { archivedOnly })` — scoped to bookings `assignedTo` that associate, same "only list threads with at least one message" rule the admin/client inboxes already follow. New `views/associate/messages.ejs` (full inbox+thread-panel layout, copied from the admin/client messenger shell) and `views/associate/_message-thread-panel-rich.ejs` — the same full-featured panel admin/client get (lazy attachment loading, tagged-file picker, cancel/retry uploads), used here instead of the smaller `views/associate/_message-thread-panel.ejs` that's still embedded on the booking-detail page where screen space is tighter. `views/associate/_message-poll.ejs` (new) mirrors `admin/_notif-poll.ejs`'s 15s-poll-for-badge-and-toast pattern, hitting a new `GET /api/associate/messages/poll` endpoint scoped the same way.
- **Shared chat script generalized off hardcoded `/admin/` paths.** `buildThreadRowHtml()` and `window.toggleChatBlock()` (`views/_message-thread-script.ejs`) previously assumed the only two callers were admin and client, branching on `myRole`. Both now read a `messagesBase`/`bookingBase` value off the composer's `dataset` instead (set per-template — `data-messages-base="/admin/messages/"` etc.), so the same script correctly builds thread rows and hits the right mute-toggle endpoint from the associate context too, without a third hardcoded branch. `views/associate/_message-thread-panel.ejs` gained a `fullHeight` flag so the same embeddable panel can flex to fill the page in the new inbox instead of always rendering at a fixed 520px inside the booking-detail card.
- **Messaging visibility moved off the general admin nav.** The admin sidebar's "Messages" link, its unread-count badge, the per-row unread dot on the `/admin` bookings table, and the toast-on-new-message logic in `admin/_notif-poll.ejs` were all removed, along with the server-side plumbing that fed them (`adminUnreadMessageCount`, `unreadMessageBookingIds`, `messageItems` all dropped from `/api/admin/notifications/poll` and the `/admin`/`/admin/booking/:id` routes). `/admin/messages` and its routes still exist and still work — `admin/booking.ejs`'s Quick Actions "Messages" link still points there — they're just no longer surfaced as a primary nav item or badge, now that each project's day-to-day client chat belongs to whichever associate it's assigned to.
- **Admin dashboard gained a "Completed" tab** (`?view=completed`, `server.js`'s `/admin` route) alongside the existing Active/Archived, and the status filter (`admin/_filter-summary.ejs`) changed from a row of pill buttons to a dropdown (`toggleStatusFilterDropdown()`), matching the sidebar's more compact visual language. "Status" was also dropped from the searchable-field dropdown on `admin/dashboard.ejs` since it's now covered by the tab/filter instead.

**Decisions made:**
- The associate inbox reuses the full "rich" thread-panel component rather than the smaller embedded one — editors handling client chat as their actual day-to-day job need the same lazy-loading/tagging/retry tooling admin and clients already have; the compact embedded panel stays reserved for the booking-detail page where it's one card among several.
- Admin's general Messages nav/badge was removed rather than left running alongside the new associate-scoped inbox — once every active project has (or will have) an assigned associate, a second "every project's messages" surface for the shared admin login would just be a duplicate inbox nobody checks day-to-day; the route stays reachable per-booking as a fallback rather than being deleted outright.
- `messagesBase`/`bookingBase` read off `dataset` instead of adding a third `myRole` branch to the shared chat script — keeps `_message-thread-script.ejs` from needing to know about every portal that might embed it going forward.

---

## 2026-07-11 — Careers Page & Associate Portal

**What was built:** Shipped in `058f53e`. Two related features in one commit: a real careers page replacing the hardcoded homepage section, and a full second portal for individual editors distinct from both client accounts and the shared admin login.

- **`Role` model + `/career` page.** `models/Role.js` (`title`/`emoji`/`description`/`requirements[]`/`active`/`order`) replaces the two hand-written role cards that used to live in `views/index.ejs`'s `#career` section — that section (and its "Send Your Work" Telegram link, the last Telegram reference left in the app after the 2026-07-07 removal pass) was deleted outright, and every "Careers" nav link site-wide now points at the standalone `GET /career` route instead of an in-page anchor. `scripts/seedRoles.js` one-time-seeds the two prior hardcoded roles as real `Role` docs so the page isn't empty on first load. Admin CRUD lives at `/admin/roles` (`views/admin/roles.ejs`) — create/toggle-active/delete, no ownership constraints since nothing else references a `Role` by ID except an `Application`'s optional `roleId`.
- **Job applications.** `models/Application.js` — `appCode` (same `XXX-XXX-XXX` random-code generator pattern as `BookingRequest.crCode`, via a `pre("save")` hook), `visitorId`, optional `roleId`/`roleTitle` snapshot (kept even if the role posting is later deleted or closed), `name`/`email`/`message` (2000-char cap), optional `file`. Submitted via a shared `views/_application-modal.ejs` partial (Name/Email/Message/optional file, opened from either a specific role card or a generic "Apply anyway" prompt on `/career`) posting to `POST /career/apply`. Rate-limited to one submission per rolling 24h per `visitorId` cookie (`enforceApplicationSubmissionQuota`) — unlike the booking-side guest quota, this applies unconditionally since applicants have no account concept to key off instead. File upload (`applicationUpload`, 200MB cap) additionally accepts PDF resumes on top of the existing video/audio/image/archive allowlist (`restrictToApplicationFileTypes`). `sendAdminNewApplicationAlert` (`lib/mailer.js`) emails admin on each new submission.
- **`Associate` model + individual editor accounts.** `models/Associate.js` — `name`/`email`/`password` (bcrypt-hashed via a `pre("save")` hook, same pattern as `User`), `active` flag. Deliberately separate from both the client `User` accounts and the single shared-password `req.session.isAdmin` login — editors log in individually at `/associate/login` (`req.session.associateId`, rate-limited via the same `isRateLimited` helper as `/login`/`/admin/login`). Superadmin-managed only, via `/admin/associates` (`views/admin/associates.ejs`) — create, toggle-active, reset-password; **no delete route**, since `BookingRequest.assignedTo` can reference an `Associate` and deactivating avoids leaving that reference dangling (same reasoning already applied to `Coupon`).
- **Project assignment + self-claim.** `BookingRequest` gained `assignedTo` (ref `Associate`, default `null`). An editor can self-claim any unassigned, non-archived booking from their `/associate` dashboard (`POST /associate/booking/:id/claim`) — implemented as an atomic `findOneAndUpdate({ assignedTo: null, ... }, { assignedTo: associateId })` rather than read-then-write, so two editors racing the same unclaimed booking can't both end up "owning" it. Superadmin can also assign/reassign/unassign any booking at any time from the existing `admin/booking.ejs` detail page (`POST /admin/booking/:id/assign`), independent of self-claim.
- **Associate booking detail gets near-full parity with admin's own.** `requireAssignedBooking` (`server.js`) is the ownership guard — 403/redirect unless the booking is currently `assignedTo` that associate *and* not archived (archiving revokes an associate's access, same as it revokes most admin actions). On their own assigned bookings, an associate can: change status (reusing the existing `isStatusChangeAllowed`/`getStatusGate` gate), upload/delete deliverable files, send/reissue deposit, final, and revision Stripe invoices, set delivery dates, mark revision requests reviewed, and chat with the client (mute/unmute included) — essentially every admin booking-detail action except archiving/restoring and the initial accept-with-invoice-from-pending gate.
- **Stripe invoice logic deduplicated.** `createDepositInvoice`/`reissueDepositInvoice`/`createFinalInvoice`/`reissueFinalInvoice`/`createRevisionInvoice` (`server.js`) were extracted from what used to be admin-only inline route handlers into shared functions (throwing a plain `Error` on validation/Stripe failure, caught by each caller and turned into a `?error=` redirect) — both the `/admin/booking/:id/*` and `/associate/booking/:id/*` invoice routes now call the same functions instead of the associate routes duplicating ~150 lines of Stripe wiring.
- **Socket auth extended for the third session type.** The Socket.IO connection handler (`server.js`) already branched on `session.isAdmin`/`session.userId` to authorize joining a booking's `project:<bookingId>` room; it now also checks `session.associateId` against that booking's `assignedTo`, so an editor's open thread gets live `new-message` pushes the same as admin/client.
- **`createR2Storage` generalized.** `lib/r2MulterStorage.js`'s storage factory used to hardcode `req.crCode` as the R2 key prefix; it now takes an optional `getPrefix(req)` function (defaulting to the old behavior), so `applicationUpload` can key application files under `req.appCode` instead — applications aren't bookings and have no `crCode`.

**Decisions made:**
- Associates get individually-owned, bcrypt-hashed accounts (a third, separate session key) rather than sharing the admin password or being modeled as a special `User` — the self-claim/assignment model needs to know *which* editor did what, which a shared login can't express.
- Self-claim is an atomic conditional update, not a read-then-write — booking assignment is exactly the kind of race two people hitting "claim" within the same second could hit.
- `Associate` has no delete route, deactivate only — identical reasoning to `Coupon`: another document (`BookingRequest.assignedTo`) can reference it by ID, and deleting would either orphan that reference or require a cascading cleanup that deactivation avoids needing.
- `roleTitle` snapshotted onto `Application` at submit time rather than only storing `roleId` — an application should still show what role it was for even after admin closes or deletes that posting later.
- Deposit/final/revision invoice creation pulled into shared functions the moment a second caller (associate routes) needed the same logic — avoided forking the Stripe flow into two copies that could drift.

---

## 2026-07-11 — Live Chat-Mute Sync, Auto-Created Thread Rows, Profile/Links Merge

**What was built:** Shipped in `e76b0ef`.

- **Chat-mute state now reconciles live.** The client's composer previously only learned whether it was `chatBlocked` (admin's per-project mute, see the 2026-07-10 entry below) from the initial page render — an admin toggling the mute mid-conversation had no way to push that to an already-open client tab. `applyChatBlockedState()` (`views/_message-thread-script.ejs`) now runs on every incoming `new-message` socket event (the `chatBlocked` flag rides along on the message payload), diffing against the composer's current `dataset.chatBlocked` and, on a change, disabling the attach button/file input/textarea/submit and inserting or removing a red "You've been restricted from sending messages on this project." banner — no page reload needed either direction.
- **Disabled-button cursor fix.** Chromium ignores the CSS `cursor` property on a native `disabled` `<button>`, so a disabled Send button still showed the pointer cursor. Fixed by moving the `cursor-not-allowed` styling onto the button's wrapping `<span>` instead (`views/_message-thread-panel.ejs`, applied in both the initial render and `applyChatBlockedState()`); `cursor: pointer` was also made the default for all enabled buttons site-wide (`src/input.css`) so this class of bug is less likely to recur elsewhere.
- **First-ever-message threads now insert live, not just update.** The messages inbox list only ever queried bookings that already had at least one `Message` doc, so a booking's very first message required a full reload before its row appeared in either sidebar. `buildThreadRowHtml()` + an `updateThreadRow()` fallback path (`views/_message-thread-script.ejs`) now synthesize and insert a new row matching the server-rendered markup when `updateThreadRow` can't find an existing one for that `bookingId`, hiding the "no conversations yet" empty state as needed. Insertion targets the top of the actual `.thread-row` siblings rather than the list container's `firstElementChild`, since the client dashboard's search bar is a sibling in that same container (unlike admin's, which has a dedicated scroll wrapper) and would otherwise get displaced above the search box.
- **Search/filter re-scans instead of using a stale snapshot.** The search/filter script added the day before (`views/admin/messages.ejs`, `views/dashboard-messages.ejs`) captured `document.querySelectorAll('.thread-row')` once at page load into a local `rows` array — a row inserted afterward (via the new auto-insert above) was invisible to it. The filter logic moved to a `window.applyThreadFilters()` global that re-queries `.thread-row` fresh on every call, invoked both on input/filter-menu changes and from `updateThreadRow()` whenever a row is added or updated.
- **Account page cleanup.** The account page's separate "External links" card was merged into "Profile" (`views/dashboard-account.ejs`) — they're logically the same identity data set on the account since the 2026-07-10 profile-gate work below. The old single free-text "Website / Portfolio" field (`User.externalLink`) was dropped from the UI entirely; the New Project flow only ever asked for the multi-platform `platforms[]` widget, so the legacy field was dead weight nobody filled in through the current forms. `models/User.js` field itself untouched (still exists, just unused going forward).

**Decisions made:**
- Chat-mute reconciliation piggybacks on the existing `new-message` socket event rather than a dedicated `chat-block-changed` push — mute/unmute has no visible effect on a thread with no new activity, so there's no correctness gap in waiting for the next message to carry the updated flag, and it avoids a second socket event type for a rare admin action.
- Synthesized thread rows are built to exactly match server-rendered markup (`buildThreadRowHtml()`) rather than triggering a client-side fetch-and-re-render of the whole list — cheaper, and the only data needed (crCode, booking name, status bucket) is already sitting in the composer's `dataset` from the initial page load.

---

## 2026-07-11 — Messages Search/Filter, Mobile Project Cards, File Upload Preview Rework

**What was built:** Shipped in `835d179`.

- **Messages inbox search + filter (admin and client).** Both `views/admin/messages.ejs` and `views/dashboard-messages.ejs` gained a search input (matches against each `.thread-row`'s full text content) and a filter dropdown with two independent axes — read state (`all`/`unread only`, keyed off a `data-unread` count already rendered per row) and project status bucket (`all`/`active`/`completed`/`archived`, keyed off a new `data-status` attribute computed server-side per thread). Threads with zero messages are no longer listed at all (previously showed a "No messages yet."/"Not accepted yet." placeholder row) — the inbox is now framed purely as a list of actual conversations, with a dedicated `#thread-list-empty` (no conversations at all) vs. `#thread-list-no-match` (search/filter excluded everything) empty state.
- **Client dashboard-booking gained a Messages card** in the right sidebar (`views/dashboard-booking.ejs`) — links to the thread when `chatUnlocked`, showing an unread-count badge (`locals.bookingUnreadMessageCount`, a new per-booking count injected alongside the existing global unread badge) or a chevron when caught up; renders as a disabled, tooltipped span (matching the existing Quick Actions pattern on the admin side) when chat isn't unlocked yet.
- **File upload rework on the client dashboard's extra-files uploader** (`views/dashboard-booking.ejs`) — previously a single "Choose files" button + a plain "No files selected" label + one submit button. Now selecting files renders a per-file preview list (`renderExtraFilesList()`): a thumbnail (image `<img>`, video/audio type icon), filename, size (`fmtFileSize()`), and for media files a duration read off `loadedmetadata` (`fmtDuration()`/`onExtraMediaMeta()` — videos seek to `0.1s` first so the thumbnail isn't a black first frame). Each row gets its own upload progress bar and its own remove/abort control: before a batch upload starts, the × removes that file from the queue; once uploading, every row's remove button locks except the one actively in flight, which becomes an "Abort" button wired to that file's own XHR (`setExtraFileAbortable`/`disableExtraFileRemove`/`restoreExtraFileRemove`) — avoids index drift between the frozen upload queue and a mid-batch removal re-render.
- **Mobile card layout for the admin-facing project tables is now also on the client dashboard home** (`views/dashboard.ejs`) — the desktop `<table>` of projects gets a parallel card-per-row layout below `lg:` breakpoint, with bulk-select checkboxes kept in sync between whichever layout is currently visible (checking a card's box also checks/reflects the corresponding desktop row's, and vice versa) so the existing bulk-delete flow doesn't silently only see one half of the selection.
- **Mobile header consistency pass** — every dashboard page's mobile top bar (`dashboard.ejs`, `dashboard-account.ejs`, `dashboard-booking.ejs`, `dashboard-gallery.ejs`, `dashboard-messages.ejs`, `dashboard-new.ejs`, `dashboard-notifications.ejs`) moved the hamburger menu button to before the brand wordmark (previously trailed it) and expanded the abbreviated "Jarumiri." to the full "Jarumiri Studios." to match the desktop sidebar.
- Project action buttons on `dashboard-booking.ejs` (Pause / Send nudge / Delete project) go full-width and stack vertically below `lg:`, rather than wrapping as same-row pills that could get cramped on a narrow screen.

**Decisions made:**
- Read-state and status filters are two independent axes (not a combined single dropdown of preset combinations) — a search across "unread AND archived" is a legitimate combination an admin might want, so keeping them orthogonal covers more cases than a flat preset list would.
- Per-file abort locks the *other* rows' remove buttons during upload rather than allowing arbitrary mid-batch removal — the upload queue is a plain array walked by index; letting a different row be spliced out mid-flight would desync that index against whichever XHR is currently in progress.

---

## 2026-07-10 — Profile-Completion Gate for Client Type / External Links, Plus Follow-Up Fixes

**What was built:** Shipped across three commits — `8f2b714`, `4ae0c20`, `7568080`.

- **`clientType` and `platforms[]` moved from `BookingRequest` onto `User`** (`models/User.js`) — clients were re-typing their "you are a(n)" answer and social-platform links on every single project submission even though that information doesn't change per-project. `User.clientType` (same 5-value enum as the booking-level field) replaces the old, unused, and mismatched `accountType` string field; `User.platforms[]` mirrors the existing booking-level shape (`platform` enum, `handle`, capped at `MAX_PLATFORM_LINKS = 3`).
- **`/dashboard/new`'s existing profile-completion gate extended** to collect both fields up front (once per account, not per project) alongside whatever it already asked for. Once saved, `/hire` and `/dashboard/new`'s actual booking forms render the two fields as read-only/locked — carried through as hidden inputs rather than re-prompting — with a link back to `/dashboard/account` to change them. Guests without an account (no `User` to attach the fields to) keep the original always-editable widget, unchanged.
- **`POST /dashboard/account/profile`** (`server.js`) — the account page's Profile section and its (now-merged, see the next day's entry) links section are separate `<form>`s on the same page, so the platforms array is only touched when the submitting form actually included the links widget (gated on a `platformsSubmitted` hidden marker field) — otherwise saving one section would silently null out the other's data.
- **Follow-up fix (`4ae0c20`):** the locked-field confirmation block ("You are a(n): Agency" / an "External links" recap card) that rendered once these fields were account-locked was noise once the identity strip's "Edit profile" link already covers changing them — removed in favor of pure hidden inputs, no visible re-display of already-known information.
- **Follow-up fix (`7568080`), a real breakage:** collapsing the `clientType` field to a silent hidden input in the previous commit dropped its `id="clientType"` attribute. `validateStep(1)` in `dashboard-new.ejs`/`hire.ejs` called `document.getElementById('clientType').value` unconditionally — with no element to find, that threw and aborted the rest of the guarded `<script>` block before `selectOption()` (used by every other custom dropdown on the page, including Package/Service) was ever defined, silently breaking every dropdown below it. Found and fixed via a scripted Playwright run driving signup → profile gate → Package/Service selection → submission end-to-end. The same repro also surfaced two pre-existing, unrelated null-reference bugs on the same code path: `dashboard-new.ejs`'s file-upload dropzone script assumed `#drop-zone` always exists, but it's only rendered once a client has trusted deposit history — never true on a brand-new account's first project, exactly the path the new profile gate leads into; and `hire.ejs`'s success page threw on `projectBrief`/`pricingTier` lookups that don't exist in that particular render state. All three now null-guard instead of throwing.
- **Latent bug also fixed in `8f2b714`:** `dashboard-new.ejs`'s entire booking-form `<script>` was wrapped in an "if `#booking-form` exists" guard that the new gate-form widgets (which render on the same page but outside that specific form during the gate step) fell outside of — pulled the shared dropdown/platform-widget JS out to load unconditionally regardless of which step is currently showing.

**Decisions made:**
- Fields moved to the account rather than duplicated-but-prefilled per booking — once saved they're conceptually properties of the client, not the project; re-asking (even pre-filled) invited the exact kind of confirmation-block noise `4ae0c20` had to walk back.
- Guests keep the fully editable per-booking widget rather than being pushed toward account creation — an account is still optional for submitting a booking at all (see `Plans/stack.md`'s Authentication section), so the locked/read-only treatment only applies once there's actually an account record to lock against.
- Verified this arc end-to-end via Playwright (signup → gate → dropdowns → submit) rather than just manual spot-checking, since the breakage was a silent one (no error surfaced to the user, just dead dropdowns) that a quick glance wouldn't have caught.

---

## 2026-07-10 — Regroup Anonymous Bookings Under an Account on Login/Signup

**What was built:** Shipped in `b3e6260`.

`linkOrphanedBookings(user)` (`server.js`) — previously, logging in or signing up only linked the one booking whose `crCode` happened to be passed through the URL (e.g. from a "create an account to track this" prompt right after a guest submission). A client who'd submitted several guest requests over time before ever creating an account had all their earlier ones stay permanently orphaned (`clientId: null`), invisible on their dashboard even after they did eventually sign up. The new function sweeps in **every** still-unclaimed `BookingRequest` matching the account's email in one `updateMany`, not just the one from the current flow, and is called from both `POST /login` (replacing the old single-booking `crCode` linking block) and `POST /signup` (added as a new call, on top of the existing single-booking link that flow already did).

**Decisions made:**
- Fires only after proven ownership (a successful password check on login, or a brand-new signup) — never at anonymous submission time — since matching purely on email string equality isn't proof of identity, and linking someone else's guest booking to your account by typing their email would be a real (if minor) information-disclosure bug.
- Implemented as an unconditional sweep on every login/signup rather than a one-time migration — cheap (`clientId: null` bookings are a small, shrinking set) and self-healing for any future orphaned booking without needing a scheduled job.

---

## 2026-07-10 — Restyle Transactional Emails with a Branded HTML Layout

**What was built:** Shipped in `cc5cbbb`. Every email sent via `lib/mailer.js` (`sendMail()`) had been raw unstyled `<p>` tags since the app's first mailer implementation. Added a shared table-based HTML layout — dark header with the Jarumiri wordmark, amber accent color, pill-shaped call-to-action buttons, monospace "code chip" styling for BR codes, and bordered detail tables for line-item-style content (invoice amounts, due dates) — and rebuilt all 14 existing templates (booking confirmation, new-booking alert, acceptance email, invoice-sent alert, payment-confirmed alert, deposit-expired notice + auto-decline alert, password reset, and others) on top of it. Table-based layout specifically for email-client compatibility (Outlook and other clients still route mail HTML through table-based rendering engines that don't reliably support modern CSS layout).

**Decisions made:**
- One shared layout function/partial rather than restyling each of the 14 templates independently — keeps the brand look consistent and means a future palette/logo change is a one-file edit instead of 14.

---

## 2026-07-10 — Email Delivery: Gmail SMTP → Resend, Forgot-Password Polish

**What was built:** Spans five commits (`6b43250`, `0c90389`, `2c14d2b`, `d3b7292`, `9c3811b`), tracking down and finally fixing production email delivery, plus incidental UI polish on the reset-password flow.

- **`6b43250` — force IPv4 for outbound SMTP.** Railway containers have no outbound IPv6 route, but `smtp.gmail.com` resolves an `AAAA` record too — without `family: 4` on the nodemailer transport options, every mail send (password resets, booking confirmations, invoices) was silently failing with `ENETUNREACH`. First attempt at fixing production email delivery.
- **`0c90389` — switched off Gmail SMTP entirely, onto Resend.** The IPv4 fix from the previous commit turned out not to be enough: Railway blocks outbound raw SMTP altogether (port 465 connections still timed out with `ETIMEDOUT` even after the routing fix), so nothing sent via nodemailer was ever actually reaching Gmail from production — this had been a silent, total email outage in prod despite working locally. Replaced nodemailer/Gmail with the `resend` npm package (`lib/mailer.js`), which sends over HTTPS and sidesteps the SMTP port block entirely. Domain `jarumiristudios.com` verified on Resend so `MAIL_FROM` can send as an on-domain address rather than a Resend-provided default. `sendMail()`'s public signature (`{ to, subject, html }`) is unchanged, so no caller elsewhere in the app needed touching.
- **`2c14d2b` — surface the rate limit on `/forgot-password`.** The route always rendered the same neutral "check your inbox" message regardless of what actually happened (per the existing enumeration-safe design, see the 2026-07-09 password-reset entry) — including when the request was silently dropped by the existing 3-per-hour rate limit, making it look to the user like mail delivery itself was broken. The rate-limit check now runs (and its result is shown) before the account-lookup branch, which is still safe to surface without leaking whether the email is registered, since the limit is keyed on the submitted email string, not on account existence.
- **`d3b7292` — show/hide password toggle on reset-password fields**, matching the existing eye-icon pattern already used on `/login`, `/hire`, and `dashboard-account`.
- **`9c3811b` — post-reset login confirmation switched to the shared toast system** (`showToast()`) instead of a one-off inline green banner, consistent with how every other transient confirmation in the app is surfaced.

**Decisions made:**
- Resend over continuing to debug Gmail SMTP further — Railway's outbound SMTP port block is infrastructure-level, not something fixable from the app side; an HTTP-based transactional email provider was the only way to reliably deliver from a Railway-hosted service.
- Left `MAIL_FROM`/the public `sendMail()` interface unchanged across the provider swap — kept the blast radius of the migration to `lib/mailer.js`'s internals only.

---

## 2026-07-10 — Revision Invoices, Chat Client-Blocking, Deliverable Preservation on Delete, Chat Attachment Availability Fixes

**What was built:** Shipped in `8ad371e`. A mixed bag of admin-requested chat/billing features plus a correctness fix for how chat attachments behave once their underlying files are gone.

- **Revision invoices.** `BookingRequest.revisionInvoices[]` (`models/BookingRequest.js`) — unlike deposit/final (capped at one each), a project can rack up several of these over its life, so it's an array (`invoiceId`/`invoiceUrl`/`amount`/`dueDate`/`status`/`createdAt`) rather than a single field. New `POST /admin/booking/:id/send-revision-invoice` (`server.js`) creates and sends a Stripe invoice (`collection_method: send_invoice`) the same way `send-deposit`/`send-final` do, gated on `stripeCustomerId` already existing (a revision charge only makes sense once a deposit's gone out at least once) and the project not being archived. Amount defaults to `ADDON_PRICES["Extra revision"]` ($30, the same constant `/hire`'s "Extra revision" add-on already uses) but the admin can type any value; due date is admin-picked (7-day default, 3-day minimum, same `endOfDay`/`minDueDate` validation as deposit/final) rather than hardcoded. The Stripe webhook (`invoice.payment_succeeded`) now also checks `revisionInvoices` for a matching invoice ID (after the existing deposit/final checks) and marks that entry `"paid"`. `admin/booking.ejs` gained a "Revision invoices" card — list of past invoices (amount, date, paid/pending/void, "Due by" for pending ones, link to the hosted Stripe invoice) plus the send form — shown once `stripeCustomerId` exists.
- **Chat client-blocking.** `BookingRequest.chatBlocked` (`models/BookingRequest.js`) — an admin-only mute, independent of `chatUnlocked` (project-phase gating): the client keeps read access to the thread but can't send. New `POST /admin/booking/:id/chat-block` / `chat-unblock` (JSON response, not a redirect, since it's triggered via `fetch()` from inside the chat panel like the other in-thread actions). Enforced server-side in `attachCrCodeForClient` (403 if `chatBlocked`) — confirmed there's no socket-based send path that could bypass it (sockets are push-only for broadcasting). Admin thread header (`admin/_message-thread-panel.ejs`) gained a "Client blocked" badge and a Block/Unblock toggle button; client's composer (`_message-thread-panel.ejs`) disables (attach button, textarea, send) and shows a persistent red banner above the composer when blocked, not just a placeholder hint.
- **Client-initiated delete now preserves delivered final files.** Previously `archiveAndWipeBookingFiles`/`hardDeleteBookingFiles` wiped everything under a booking's `files/` folder and R2 prefix — including deliverables the admin had already handed over. Now `hardDeleteBookingFiles` (`server.js`) skips the `deliverables` subfolder locally, and a new `deleteObjectsByPrefixExcept(prefix, keepKeys)` (`lib/r2.js`) does the R2-side equivalent, passed the booking's `deliverableFiles[].storageKey`s so those specific objects survive the batch-delete. Both delete routes (`/dashboard/booking/:id/delete`, the account-delete cascade) no longer clear `deliverableFiles` in the DB update. `admin/booking.ejs`'s "Final deliverables" card is now hidden entirely once `filesDeleted` (its upload form/remove buttons made no sense post-deletion anyway), and the red deletion banner text updated to say deliverables remain on record. Also disabled while archived: the "Add note" form and the "Send Deposit Invoice" button (`canSendDeposit` now requires `!booking.archived`), each with an accurate reason shown instead of the previous generic/misleading hint.
- **Chat attachment availability fixes.** Three related bugs, all stemming from the same root cause — attachments that render eagerly (the sender's own uploads, or ones already marked `downloaded`) had no `onerror` handler, so a file the underlying storage no longer has just spun forever:
  - `window.handleMediaLoadError` (`_message-thread-script.ejs`) now swaps a failed `<img>`/`<video>` for a "This file is no longer available" placeholder (icon-only on the small 13px tagged badge, icon + text on the big 320px preview) instead of leaving the loading spinner stuck — wired via `onerror` on every eager-load call site, both the JS-built ones and the server-rendered initial page load (`_message-thread-panel.ejs`, `admin/_message-thread-panel.ejs`).
  - That placeholder is non-clickable: `handleMediaLoadError` also walks up to the enclosing `<a class="attachment-badge">`/`<a class="tagged-inline-badge">` and strips `href`/`download`, no-ops `onclick`, and adds a new `.attachment-unavailable` class resetting the cursor — previously the placeholder looked inert but the surrounding link still tried to open the file viewer or download.
  - For a booking with `filesDeleted: true` (client hard-delete — see above), attachments that were never downloaded by the viewer used to still show the "tap to download" lazy-load icon, implying a download that could only ever 404. Both panel templates now compute `filesGone = !!booking.filesDeleted` and short-circuit *before* the media-type branching: every attachment type (image/video/audio/tagged/generic) renders as a dimmed, non-interactive "no longer available" badge immediately, no network request attempted, no misleading affordance shown — this applies uniformly to tagged and non-tagged attachments since it's one shared check ahead of the existing `isTagged` branch.
  - Also added (separately, same session): a cancel button (spinning ring + centered ✕) for in-flight *eager* loads, via `window.cancelEagerMediaLoad` — previously only the lazy tap-to-download flow had a cancel option.
- **Admin UI polish, bundled into the same commit:**
  - Admin booking-notification bar (`admin/notifications.ejs`, `admin/_notif-poll.ejs`): the whole row is now a link to the booking (was just a small "View project →" sub-link), and the `new_booking` message is built as HTML server-side (`notifyAdminNewBooking`, `server.js`) with the client name in quotes and the package/price bold + amber — `escapeHtml()` added to `server.js` since the message field is now rendered raw (`<%-`) instead of escaped (`<%=`), so `booking.name`/the cost label must be pre-escaped to avoid reopening a stored-XSS hole.
  - Admin login errors (`admin/login.ejs`) now go through the existing toast system instead of a static red banner, matching how every other error in the app surfaces.
  - Admin booking's "External links" rows gained a copy-to-clipboard button (always copies the full untruncated value) and character-based truncation (first 8 + last 8 chars) for long handles/URLs, replacing pure CSS overflow-ellipsis.
  - Icons added to the client dashboard's Pause/Send nudge/Delete project buttons; several solid-amber "primary" buttons (Upload, Submit revision request, and the new Send revision invoice) restyled to the same amber-outline "secondary" look already used by Pause project, since none of them are the single primary action on their page.
  - Removed the redundant client name/email/location `<h1>` header from the top of `admin/booking.ejs` (duplicate of the existing "Contact" sidebar card) — the status-picker card now takes the full row width instead of being pinned to a narrow `min-w-[220px]` box on the right.

**Decisions made:**
- Revision invoices modeled as an array, not a single field like deposit/final — revisions aren't a one-time gate in the project lifecycle, a client can request (and be billed for) several over a project's life.
- Revision invoice due date is admin-picked (like deposit/final) rather than silently hardcoded — the first pass hardcoded 14 days out, changed after feedback that admin should control it the same way as the other two invoice types.
- Chat blocking is per-project (`chatBlocked` on `BookingRequest`), not per-client-account — a client could have several projects, and being disruptive on one thread doesn't necessarily warrant muting every thread they have open.
- Deliverables excluded from the wipe by storage key (R2) / folder name (local), not by re-uploading or copying them elsewhere first — cheaper and avoids a window where they're briefly unavailable during the delete operation.
- The "no longer available" placeholder is skipped (not attempted-then-failed) once `filesDeleted` is known — no reason to let the browser issue a doomed request when the server already knows the answer.

---

## 2026-07-09 — Cloudflare R2 File Storage Migration (shipped in `8e13ef4`)

**What was built:** Direct file uploads move off the Railway server's local disk onto Cloudflare R2 (S3-compatible object storage), since Railway's disk is ephemeral/non-persistent across redeploys — a growing correctness risk for an app whose whole product is "receive and deliver client files." Full rollout plan tracked in `Plans/july26-milestone.md`'s R2 section.

- **Shared file-metadata schema.** `models/shared/fileMetadata.js` exports one `fileMetadataFields` object (`originalName`/`storedName`/`size`/`mimetype`/`folder`/`blurDataUrl`/`storageKey`/`backend`), spread into `BookingRequest.uploadedFiles`/`deliverableFiles` and `Message.attachment`/`attachments` (`models/BookingRequest.js`, `models/Message.js`) instead of each redeclaring the same shape. `backend: "local"|"r2"` is the field that lets old and new files coexist during rollout.
- **R2 client + custom multer storage.** `lib/r2.js` wraps the AWS S3 SDK (`@aws-sdk/client-s3`, `@aws-sdk/lib-storage`, `@aws-sdk/s3-request-presigner`) against R2's S3-compatible endpoint: `putObject`/`streamUpload` (upload), `getPresignedDownloadUrl` (short-lived signed read URL), `deleteObject`/`deleteObjects`/`deleteObjectsByPrefix` (single, batch, and whole-booking-prefix delete — R2 has no recursive delete, so the prefix wipe is list-then-batch-delete), `headObject`/`listObjectKeys`. `lib/r2MulterStorage.js` implements multer's `_handleFile`/`_removeFile` storage-engine interface against it: images are buffered in memory (small, and the same buffer feeds `sharp()` for the existing blur-preview generation) while everything else streams straight through via a byte-counting `PassThrough`, so a 250MB video never fully lands in RAM or on disk. All three multer instances (`upload`, `deliverableUpload`, `chatUpload`, `server.js`) switched from `multer.diskStorage` to `createR2Storage()`.
- **Flat keys, folder as metadata.** R2 object keys are `<crCode>/<storedName>` only — the `video`/`audio`/`image`/`other`/`deliverables`/`chat` distinction that used to be a disk subfolder is now purely a Mongo `folder` field. This means "promote a chat attachment to a project file" (an existing feature) no longer needs any object-storage operation at all, just a DB update — `moveStoredFile()` (`server.js`) now short-circuits to `true` immediately for `backend: "r2"` files.
- **Read path.** `trySendStoredFile()` was replaced with `redirectToStoredFile()` (`server.js`) — takes the file's own Mongo subdocument, 302-redirects to a presigned R2 URL if `backend === "r2"`, otherwise falls back to the original active-path-then-`_archive` disk lookup. Presigned URLs support Range requests natively, so video scrubbing keeps working without Express having to proxy bytes or implement Range handling itself.
- **Delete paths made R2-aware.** `archiveAndWipeBookingFiles()` (client hard-delete) now also calls `deleteObjectsByPrefix(`${crCode}/`)` alongside the existing local-disk wipe, so a booking's R2 objects are actually removed rather than orphaned. `softDeleteMessage()` and the single-deliverable-delete route branch per-file on `backend` (R2 delete vs. the old `fs.rm`).
- **`uniqueFilename`/`fileTypeFromMime` extracted** to `lib/uploadUtils.js` — previously private helpers inside `server.js`, now shared with `lib/r2MulterStorage.js`.
- **`generateBlurDataUrl()` signature changed** from taking a file path (read off disk) to taking the already-uploaded image buffer directly — the R2 storage engine already buffers images in memory for the R2 `putObject` call, so this reuses that buffer instead of a second disk/network read.
- **Migration script.** `scripts/migrate-uploads-to-r2.js` — three phases (`upload`/`backfill`/`verify`), run manually via `node scripts/migrate-uploads-to-r2.js <phase>`, resumable via a local `scripts/migration-manifest.json` (gitignored) keyed by `storedName`. `upload` walks the local `uploads/` tree (both active and `_archive`), streams each file to R2, and verifies the upload by comparing `HeadObjectCommand`'s `ContentLength` against the local file size before marking it `"verified"` in the manifest — persisted after every single file so a crash loses at most one file's progress. `backfill` then writes `storageKey`/`folder`/`backend: "r2"` onto every matching `BookingRequest`/`Message` file-metadata subdocument. `verify` is read-only reconciliation (local file count vs. manifest vs. Mongo `backend:"r2"` doc count). Never deletes local files — that's a deliberate later step once a bake period passes.
- **Found and fixed while wiring this up: `dotenv.config()` ordering bug.** `server.js` used to call `dotenv.config()` partway down the file, after several `require()`s — harmless before, because nothing at module-load time read `process.env`. `lib/r2.js` does (`const BUCKET = process.env.R2_BUCKET_NAME` etc. at the top level), and it's required (transitively, via `lib/r2MulterStorage.js`) before that old `dotenv.config()` call ran — so R2's env vars would've been `undefined` at client-construction time. Fixed by moving `dotenv.config()` to the very first line of `server.js`, before any other `require()`.

**Decisions made:**
- Flat R2 keys (no folder in the key) over mirroring the local `files/<folder>/` layout — makes the existing "tag/promote a file between folders" feature free (DB-only) instead of requiring an R2 copy+delete, and R2/S3 doesn't benefit from directory-style key nesting the way a filesystem does.
- `backend` field per-file (not a global cutover flag) — lets the migration proceed booking-by-booking/file-by-file with local and R2 files coexisting indefinitely if needed, rather than requiring one atomic flip.
- Presigned-redirect reads (not proxying bytes through Express) — keeps Range-request support (video scrubbing) working for free and avoids Express holding open a long-lived stream per download.
- Migration script never deletes local files, even after a successful `verify` — local disk is kept as a safety net through a bake period; local-disk cleanup is a deliberate, separate, not-yet-taken step.
- Not yet run against production — needs the 5 R2 env vars mirrored onto the Railway `jarumiristudios` service first (see `Plans/july26-milestone.md`).

---

## 2026-07-09 — Gate Deposit Invoice on In-Review Status; Coupons & Discounted Total on Client Dashboard

**What was built:** Shipped in `e1ceca8`.

- **Deposit invoice blocked from `pending`.** `POST /admin/booking/:id/send-deposit` (`server.js`) now redirects with an error ("Move status to In Review first...") unless `booking.status` is already `in-review`, `accepted`, or `in-progress`. Previously admin could accept-and-invoice straight from `pending`, which flips status to `accepted` and puts a payment ask in front of the client before they'd had any chance to upload files via their dashboard.
- **Coupon breakdown surfaced on the client dashboard.** `dashboard-booking.ejs`'s pricing card now lists each applied `couponCodes[]` entry with its discount amount, and subtracts the total `discountAmount` from the displayed total — previously the dashboard showed the pre-discount `agreedPrice` with no visibility into which coupons applied or how much they saved, even though `/hire`'s own coupon chip UI already showed this at submission time.
- **Informational card for `pending` bookings** added to the client dashboard, explaining the review-before-upload flow (why there's no payment ask or upload option yet) — pairs with the new send-deposit gate so the client isn't left wondering why nothing's happening.

**Decisions made:**
- Gate keyed on `status` (not a new flag) — `in-review` already exists as a distinct pipeline stage and is the natural signal that admin has looked at the request; no new field needed.

---

## 2026-07-09 — Production Build/Start Scripts for Tailwind CSS

**What was built:** Shipped in `ab6783d`. `public/output.css` is gitignored and only ever produced locally by the `npm run tw` watch process — Railway's deploy had nothing generating it, so the live site was serving unstyled HTML. Added a one-shot `build` script (Nixpacks auto-runs `npm run build` on deploy) that runs a minified Tailwind CLI build instead of the watch mode. `@tailwindcss/cli` also moved from `devDependencies` to `dependencies`, since Nixpacks installs with `NODE_ENV=production`, which skips `devDependencies` entirely.

**Decisions made:**
- Minified one-shot build for production rather than shipping the watch process — a long-running watcher has no purpose once there's no local file-editing loop to react to.

---

## 2026-07-09 — Forgot/Reset Password Flow, Trust Proxy for Prod Cookies

**What was built:** Shipped in `792192e`.

- **New `PasswordResetToken` model** — `userId`, `tokenHash` (sha256 of a random 32-byte token; the raw token is only ever emailed, never stored), and a TTL index expiring the doc after 1 hour. `GET/POST /forgot-password` (`server.js`) always renders the same neutral "submitted" response whether or not the email matches an account, so the endpoint can't be used to enumerate registered emails — the actual token-creation-and-email branch only runs internally if a matching `User` exists.
- **Reset rate-limited** at 3 attempts/hour per submitted email, via the same `LoginAttempt`-backed rolling-window pattern already used for `/login` — `isLoginLocked` was generalized into `isRateLimited(key, max, windowMs)` so both `/login` and `/forgot-password` share one implementation with different caps/windows.
- **`GET/POST /reset-password/:token`** looks the token up by its hash, checks the 1-hour window server-side (not just relying on the TTL index, which is a background sweep and not instantaneous), and on success updates `user.password` (re-hashed by the existing `User` pre-save hook) and deletes all of that user's outstanding reset tokens.
- **Trust proxy + secure cookies for prod.** `app.set("trust proxy", 1)` added — Railway/Cloudflare terminate TLS in front of the app, so without this, `req.secure` and Express's own protocol detection would always see plain HTTP from the app's perspective. Both the session cookie and the `jrmr_vid` visitor-id cookie gained `secure: process.env.NODE_ENV === "production"` so they're marked `Secure` in production (sent over HTTPS only) but still work over plain HTTP in local dev.

**Decisions made:**
- Neutral response on `/forgot-password` regardless of match — standard practice to avoid account-existence enumeration via a password-reset form.
- Token stored as a hash, not the raw value — same rationale as password hashing itself: a DB read (backup leak, injection, etc.) shouldn't hand over usable reset tokens.
- Reused the `LoginAttempt` model/pattern for reset rate-limiting instead of a new collection — same rolling-window shape, just a different key prefix (`reset:` vs `login:`) and different cap/window constants.

---

## 2026-07-07 — Gate Chat Behind Booking Acceptance

**What was built:** Shipped in `99b22e3`, on top of the `clientType`/`platforms` work below. `BookingRequest` gained a `chatUnlocked` virtual (`models/BookingRequest.js`) — `true` for `accepted`/`in-progress`/`completed`/`paused`, `false` for `pending`/`in-review`/`declined`. Chat was previously reachable the moment a booking had a linked client account, with no status gate at all.

- **Server-side enforcement, not just UI.** `attachCrCodeForClient` (`server.js`) now 403s with `{ error: "Chat opens once this project is accepted." }` if `!booking.chatUnlocked`, blocking the client's own send route before multer touches the request. The admin send route (`POST /admin/booking/:id/messages`, `server.js:1536`) got the same `chatUnlocked` check (403, "This project hasn't been accepted yet.") so admin can't message into a thread the client can't yet see as active either.
- **Composer disabled, not hidden.** Both thread panels (`_message-thread-panel.ejs`, `admin/_message-thread-panel.ejs`) disable the attach button, file input, textarea, and send button when `!booking.chatUnlocked`, with placeholder copy explaining why ("Chat opens once this project is accepted." / admin's "This project hasn't been accepted yet."). The empty-state message swaps to the same explanation instead of "No messages yet."
- **List views and quick actions reflect the lock too.** `admin/messages.ejs` and `dashboard-messages.ejs` thread-list rows show "Not accepted yet." / "Chat opens once accepted." instead of "No messages yet." / "Say hello." for locked threads. `admin/booking.ejs`'s "Quick actions" card replaces the "Messages" link with a disabled, tooltipped span when the booking has a linked client but isn't yet accepted.
- **Cosmetic.** `admin/notifications.ejs` read rows now dim slightly (`.notif-row.read { opacity: 0.82 }`, full opacity restored on hover) so a glance down the list distinguishes read from unread beyond just the background tint.

**Decisions made:**
- Locked at `pending`/`in-review`/`declined` only — `paused` stays unlocked (chat was already open before a project got paused, no reason to yank it) and there's no unlock-then-relock path once a project reaches `accepted`.
- Enforced on both send routes (client and admin) rather than just the client's — an admin could otherwise open an old bookmarked thread URL and message into a not-yet-accepted project, which the client couldn't see or reply within their own gated UI.
- Shipped and verified live as part of `99b22e3`.

---

## 2026-07-07 — Chat: Message Deletion, Lazy Attachment Loading, File Viewer

**What was built:** Continuation of the messaging feature (see the three entries below). Shipped in `896cf36` alongside login rate-limiting and the trust-gated upload changes documented in that commit's message (own entry not separately journaled — see `git show 896cf36` for the full list: `LoginAttempt` TTL-indexed brute-force protection on `/login`/`/admin/login`, `hasTrustedDepositHistory` trust gate replacing the flat guest upload tier, `archiveAndWipeBookingFiles` for client-initiated irreversible delete, `retrySync` for Windows Defender file-lock retries).

- **Soft-deletable messages.** `Message` gained a top-level `deleted` boolean (`models/Message.js:34`). `softDeleteMessage()` (`server.js:462`) clears `body`/`attachment`/`attachments` and deletes any `chat`-folder files from disk (both active and `_archive` paths) but leaves tagged project-file attachments alone, since those still belong to the project regardless of the message. New routes `POST /admin/booking/:id/messages/:messageId/delete` (`server.js:1437`) and `POST /dashboard/messages/:id/:messageId/delete` (`server.js:2112`), each scoped to the sender's own `senderRole` so you can only delete your own messages. Broadcasts a `message-deleted` socket event to the room so the other party's open thread updates live; both thread scripts (`_message-thread-script.ejs`) render deleted rows as an italic "This message was deleted" tombstone with the delete button removed.
- **Lazy attachment downloads + blur previews.** New dependency `sharp` (`package.json`) generates a 32×32, heavily-blurred base64 JPEG (`generateBlurDataUrl()`, `server.js:532`) for every image uploaded anywhere in the app (chat attachments, `/hire` uploads, admin deliverables) — stored as `blurDataUrl` on `BookingRequest.uploadedFiles`/`deliverableFiles` (`models/BookingRequest.js`) and on `Message.attachments` (`models/Message.js:15`). Image/video attachments the *receiving* party hasn't fetched yet render as the blurred still behind a download button instead of eagerly loading the real file; clicking downloads via XHR with a cancelable progress ring (`startAttachmentDownload`/`cancelAttachmentDownload`, `_message-thread-script.ejs`). A per-attachment `downloaded` flag (`models/Message.js:19`) is set server-side the first time the non-sender actually hits the attachment-serving GET route (`server.js:1481`/`2122`), so it stays "already seen" across reloads and new socket pushes.
- **Upload progress, cancel, and retry.** Composer sends now go through `postWithProgress()` (XHR, not `fetch`, since `fetch` has no upload-progress event or abort hook) with a real byte-level progress ring on the optimistic "sending" bubble. A cancelled or failed send doesn't disappear — it flips to a "Not sent — tap to retry" state (`markPendingFailed`/`retryPendingUpload`) that resends the exact same body/files/tagged-file payload, since the composer's own draft is cleared the instant Send is pressed.
- **Chat attachment cap raised 25 MB → 1 GB** (`CHAT_ATTACHMENT_MAX_SIZE`, `server.js:615`), with a matching client-side `MAX_ATTACHMENT_SIZE` check before files are even queued, so an oversized file never gets uploaded only to be rejected by multer after the fact.
- **"Add to project files."** A chat-uploaded (not tagged) attachment can now be promoted into the booking's real `uploadedFiles` array without re-uploading: `POST /admin/messages/attachments/:filename/save-to-project` (`server.js:1498`) and the client equivalent (`server.js:2145`) call `moveStoredFile()` (`server.js:281`) to physically move the file from `files/chat/` into the matching `files/<type>/` subfolder, push it onto `uploadedFiles`, and update the message's own attachment record so it renders as "already in project" afterward.
- **Full-screen file viewer.** Clicking any attachment thumbnail now opens a modal (`#file-viewer-modal`, both thread panels) showing the file full-size alongside a grid of the rest of the booking's `uploadedFiles`, with next/prev browsing and an inline "Add to project files"/"✓ In project files" action per file (`openFileViewer`/`selectViewerFile`, `_message-thread-script.ejs`).

**Decisions made:**
- Tagged (already-project) attachments are exempt from deletion's disk cleanup — a chat message is just a pointer to them, not their owner; only fresh chat-composer uploads are actually owned by the message and safe to delete from disk.
- Lazy-loading only applies to the *receiving* party — the sender already has the file locally (still on their machine, just uploaded) so their own bubble always renders the real thumbnail immediately, never the blurred/download-gated version.
- Blur previews are images-only, no video-frame extraction — avoids pulling in an `ffmpeg` dependency for a nice-to-have; a video attachment just shows a plain download icon with no preview.
- Raised the chat cap to 1 GB now that attachments can be promoted into real project files — a 25 MB chat-only cap made sense when chat attachments were disposable previews, but now that "share a file in chat" and "upload it as a project file" are converging into one action, the cap needed to match the main upload system more than the old "quick preview" framing.
- Retry keeps the same pending bubble/pendingId rather than requiring the user to retype the message — a cancelled multi-hundred-MB upload is expensive enough to redo that losing the composed message on top of it would be a bad experience.

---

## 2026-07-07 — `/hire`: Client Type + Required External Links, Site-Wide Telegram Removal

**What was built:** Shipped in `99b22e3`, on top of `896cf36`, spanning both booking-submission forms (`hire.ejs` for guests/first-time visitors, `dashboard-new.ejs` for logged-in clients — both post to the same `POST /hire` handler).

- **`clientType` (required).** `BookingRequest` gained a required enum field (`models/BookingRequest.js`): `"Independent Creator" | "Agency" | "Studio" | "Brand / Business" | "Other"`. Rendered as a new "You are a(n)" custom-select in step 1 of both forms, each option carrying a short description (e.g. Agency: "Managing this project on behalf of a client"). Validated client-side (`validateStep(1)`) and server-side in the existing required-field check in `POST /hire` (`server.js`).
- **`platforms[]` (required, 1–3 entries).** New subdocument array on `BookingRequest` — `{ platform, handle }`, `platform` enum'd to `Instagram | Twitter | TikTok | OnlyFans | Fansly | Fanview | MannyVids | Pornhub | Other`, schema-validated to 1–3 entries (`MAX_PLATFORM_LINKS = 3`, `server.js`). UI is a platform-picker dropdown + handle/URL text input that commits each pair (Enter key or the check button, `addPlatformEntry()`) into a removable chip list — duplicated near-identically between `hire.ejs` and `dashboard-new.ejs` (`selectPlatformOption`/`addPlatformEntry`/`removePlatformEntry`/`renderPlatformBadges`/`linkPreview`/`linkHref`/`PLATFORM_DOMAINS`/`handlePath`). `POST /hire` parses parallel `platformNames[]`/`platformHandles[]` arrays into `platforms`, deduping nothing but capping at 3 and dropping any pair missing a platform or handle.
- **Admin surfacing.** `admin/booking.ejs` gained an "External links" card rendering each platform as a badge, linking out via a `PLATFORM_BASES` map when the stored value isn't already a full URL (TikTok's path gets a re-added `@`); falls back to non-linked plain text for a platform with no known base domain. A "Client type" row was added to the existing contact-info grid. `writeBookingTxt()` (`server.js`) appends a `Type:` line and an `EXTERNAL LINKS` section to the plaintext booking dump.
- **Returning-client prefill got stricter.** The `hire.ejs` shortcut that skips a logged-in client straight to step 2 (reusing their last booking's name/email/location) used to fire on `loggedInUser && lastBooking` alone. Now gated behind a new `hasReusableProfile` check that also requires the last booking to actually have `clientType` and a non-empty `platforms` array — a client whose only prior booking predates this schema change now falls through to the full step-1 form instead of hidden-inputting missing required fields. `GET /dashboard/new` was updated to fetch the same `lastBooking` (`clientType`/`platforms`) for prefill parity with `/hire`.
- **Media links gated behind trust, not shown as the untrusted fallback anymore.** The optional "Media links" (YouTube/Drive/Dropbox) field — previously shown to every client, including untrusted new ones, as their stand-in for direct uploads — is now only rendered when `canUploadNow` is true. The new mandatory external-links field takes over that "give us something to look at" role for untrusted first-timers. Upload-gate copy reworded on both forms: "we'll open uploads for this project once it moves to review" → "uploads open after approval" / "first-time clients can upload files once their request has been approved."
- **Telegram removed site-wide.** `index.ejs`: the "large files" step-1 copy switched from "send that BR code on Telegram" to "send them through Messages once you're signed in" (pointing at the chat system shipped in `91fdbc4`/`e932dda`); the production-step copy dropped "or Telegram"; the footer's Telegram link/handle was deleted outright; the bottom "Get in Touch on Telegram →" CTA now points at `/hire` as a plain "Get in Touch →".
- **Cosmetic.** Form-input/dropdown/drop-zone border-radius on `hire.ejs` tightened from a mix of 8–16px down to a uniform 6px, continuing the "square corners" pass called out in `896cf36`'s commit message.

**Known gap:** `"Fanview"` is a selectable option in both forms' platform dropdown, but it's missing from every base-URL map — client-side `PLATFORM_DOMAINS` (`hire.ejs`/`dashboard-new.ejs`) and admin's `PLATFORM_BASES` (`admin/booking.ejs`) both stop at Instagram/Twitter/TikTok/OnlyFans/Fansly/Pornhub/MannyVids. A Fanview handle entered as a bare `@handle` (not a full URL) renders as unlinked plain text everywhere — badge preview, admin card — since none of those maps know its domain. Not fixed yet.

**Decisions made:**
- `clientType` and `platforms` required (not optional) on every booking, guest or account holder — read as a vetting/context step for admin reviewing a new request, not just a nice-to-have.
- Platform link href-building only trusts a small hardcoded domain map or a URL the visitor typed themselves — never fabricates a domain for a platform it doesn't recognize (see the Fanview gap above), to avoid ever generating a wrong or misleading outbound link.
- Shipped and verified live as part of `99b22e3`.

---

## 2026-07-07 — Upgrade Chat to Multi-File Attachments with Tagged-File Multi-Select

**What was built:**

- `Message.attachments` (`models/Message.js`) replaces the single `attachment` field as the primary storage — `attachment` is kept on the schema purely so pre-upgrade messages still render, but every new message is written to `attachments` only. A shared `attachmentFields` object (same shape: `originalName`/`storedName`/`size`/`mimetype`/`folder`) backs both the legacy singular field and the new array. `messageAttachments(m)` (`server.js`) normalizes either shape into a plain array for every place that reads a message's files.
- Both send routes (`POST /admin/booking/:id/messages`, `POST /dashboard/messages/:id`) switched from `chatUpload.single("attachment")` to `chatUpload.array("attachments", CHAT_MAX_ATTACHMENTS)` — up to **10 files per message** (`CHAT_MAX_ATTACHMENTS = 10`, `server.js`). A new `resolveTaggedAttachments()` (`server.js`) parses a JSON-encoded array of `{ id, source }` tag requests (vs. the old single `taggedFileId`/`taggedFileSource` fields) and resolves each through the existing `resolveTaggedAttachment()`, returning `null` (→ 400) if any referenced file can't be tagged.
- Composer UI (`_message-thread-script.ejs`, both client and admin) replaced the single-file name preview with a chip list (`renderPreview()`/`buildChip()`) — each pending file or tagged reference gets its own removable chip with a thumbnail. The "attach a file" modal's project-file picker changed from single-click-and-close to toggle-based multi-select (`toggleTagged()`, `.media-pick-selected` styling) with an explicit "Done" button (`attach-modal-done`) instead of auto-closing on pick.
- Rendered attachments got a distinct style split: freshly-uploaded files use the existing boxy `attachment-badge`/`badge-thumb`; tagged (already-on-the-project) files now render as a smaller, pill-shaped `tagged-inline-badge` with a truncated filename (`truncateTaggedName()` — keeps first/last 4 chars around the extension) so a long tagged filename doesn't blow out the bubble width. Video thumbnails (`<video muted preload="metadata">`) and a distinct audio badge style (`badge-thumb-audio`) added alongside the existing image thumbnails.
- `messagePreview()` (`server.js`) and the thread-row/list-view previews now say "📎 3 files" instead of a single filename once a message carries more than one attachment.

**Decisions made:**
- Kept `attachment` on the schema rather than migrating old documents to `attachments` — a data migration wasn't worth it for a feature barely a day old; the normalization function is a few lines and handles both shapes forever.
- Capped at 10 attachments per message (not unbounded) — matches the existing `uploadGuest`/`uploadMember` pattern elsewhere in the app of pairing a multer array upload with an explicit sane ceiling, rather than trusting the client.
- Tagged files toggle instead of tap-to-select-and-close — now that multiple files can be tagged in one message, closing the modal on the first pick would make attaching 2+ project files require reopening the modal per file.

---

## 2026-07-06 — Chat: File Tagging, Dedicated Message-Poll Channel, Bubble UI Overhaul

**What was built:**

- **Tagging existing project files into chat.** `resolveTaggedAttachment(booking, source, fileId, isClient)` (`server.js`) looks up a file already on the booking (`uploadedFiles` or, if `source === "deliverable"`, `deliverableFiles` — blocked for clients unless `booking.deliverablesUnlocked`) and returns an attachment object referencing it *without* re-uploading — `attachment.folder` records which physical `files/<folder>/` subfolder the file actually lives in (`"chat"` for a fresh composer upload, or the source array's own type otherwise), so the attachment-serving routes (`GET /admin/messages/attachments/:filename`, `GET /dashboard/messages/attachments/:filename`) know where to look instead of assuming `files/chat/`. Composer UI gained an "Attach a file" modal (`_message-thread-panel.ejs`) listing the booking's uploaded files and unlocked deliverables, single-select at this stage (superseded by multi-select the next day, see above).
- **Dedicated message-poll channel.** Previously (see the entry below), a new chat message created a real `Notification`/`AdminNotification` document with `type: "new_message"`. That's removed — the `new_message` enum value is dropped from both `models/Notification.js` and `models/AdminNotification.js`. Instead, both existing poll endpoints (`GET /api/notifications/poll`, `GET /api/admin/notifications/poll` — still the same 15s-interval polling infrastructure from `_notif-poll.ejs`/`admin/_notif-poll.ejs`, no new endpoint or interval) now also return a `messageItems` array: unread-since-`?since=` messages mapped to `{ bookingId, crCode, preview }` via `messagePreview()`. The client-side poll scripts toast each item via a dedicated `handleNewMessages()` and reload the open thread list if the active `/messages` page has new activity elsewhere, decoupled from the generic notification-toast path.
- **Chat bubble redesign.** Day separators (`dayLabel()`/`maybeInsertDaySeparator()`) group consecutive same-day messages under a pill (e.g. "Today", "Yesterday", a weekday name, or a full date past a week). Attachment rendering switched from a wide `attachment-chip` row to a compact `attachment-badge` with a `badge-thumb` (image thumbnail via `<img>`, or a type icon for video/audio/other). Timestamps moved from a full block under the bubble to an absolutely-positioned corner overlay (`bubble-time.corner`) when the message has body text, reserved via an inline `time-spacer` so the text never overlaps the corner timestamp.
- New `--color-orange-*` theme scale added to `src/input.css` (Tailwind v4 `@theme` block) so bubble colors could reference `var(--color-orange-300)` instead of a hardcoded hex.

**Decisions made:**
- Moved new-message alerts out of the `Notification`/`AdminNotification` models entirely rather than keeping `type: "new_message"` alongside the dedicated channel — those models back a persisted, markable-read inbox (`/dashboard/notifications`, `/admin/notifications`); a chat message already has its own persisted read/unread state on the `Message` document itself (`read` field) and its own list view (`/dashboard/messages`, `/admin/messages`), so writing a second, redundant notification document per message was duplicate bookkeeping with two read-states to keep in sync.
- Reused the existing poll endpoints instead of standing up a new one — the client was already polling every 15s for notifications; piggybacking `messageItems` onto that same round trip avoids a second interval and a second network request per page.
- Tagging only allows one file at this point in the arc (superseded the next day) — kept the composer change small while the underlying `resolveTaggedAttachment` plumbing was still new.

---

## 2026-07-06 — Real-Time Project Messaging System (Socket.IO)

**What was built:**

- New `Message` model (`models/Message.js`): `bookingId`/`crCode`/`clientId`, `senderRole` (`"admin"`/`"client"`), `body` (4000-char cap), a single `attachment` sub-object (`originalName`/`storedName`/`size`/`mimetype`), and `read` — one document per chat message, `timestamps: true`.
- Socket.IO wired into the existing Express app: `http.createServer(app)` replaces the bare `app.listen()`, `io.engine.use(sessionMiddleware)` shares the same `express-session` store so a socket's handshake carries `req.session` (`server.js`). Rooms are scoped **per booking**, not global — `chatRoom(bookingId)` returns `"project:<bookingId>"`; on `io.on("connection", ...)` a socket must supply `?bookingId=` in its handshake query and passes a one-time authorization check (admin: booking exists; client: booking belongs to `session.userId`) before `socket.join()`, or it's disconnected. Admin doesn't join every room globally — each open thread mounts its own socket scoped to that one booking (`mountThread()` in `_message-thread-script.ejs`), so a socket only ever represents one project's conversation at a time. Sending stays on normal HTTP POST (multer needs a real request); the socket is push-only, broadcasting `new-message` events to the room after a message is saved.
- Chat attachment uploads via a dedicated `chatUpload` multer instance (`server.js`) writing to `uploads/<crCode>/files/chat/` — separate folder from client-submission media (`video/audio/image/other`) and admin deliverables, capped at 25 MB (`CHAT_ATTACHMENT_MAX_SIZE`) since chat attachments are framed as quick references/previews, not the main raw-footage delivery path.
- Per-project thread views, one shared partial pair per side: `views/_message-thread-panel.ejs` (client bubble/composer HTML) + `views/_message-thread-script.ejs` (client-side mount/socket/render logic, `<script>` only) for the client, and the admin-styled mirror `views/admin/_message-thread-panel.ejs` (reuses the same `_message-thread-script.ejs`). These render into two new **list/inbox pages**, not into the existing per-booking detail pages: `views/dashboard-messages.ejs` (client — full messenger layout: chat list left, thread panel right, own sidebar nav) and `views/admin/messages.ejs` (admin equivalent). Routes: `GET /dashboard/messages` and `GET /admin/messages` list every thread (one row per booking with a linked client, sorted by most recent activity); `GET /dashboard/messages/:id`/`GET /admin/messages/:id` render a specific thread — full page normally, just the thread-panel partial on an `X-Requested-With: XMLHttpRequest` request (client-side SPA-style navigation between threads without a full reload). **Not** embedded on `dashboard-booking.ejs` or `admin/booking.ejs` — those got no messaging UI in this commit; messaging lives entirely under its own `/messages` inbox pages, with only a "View project →" / back-link crossing over to the booking detail page.
- Sending: `POST /admin/booking/:id/messages` and `POST /dashboard/messages/:id` (client, via `attachCrCodeForClient` — verifies booking ownership and non-archived before multer touches the request) both create a `Message`, `io.to(chatRoom(...)).emit("new-message", message)`, respond with the saved message as JSON, and fire a `new_message` `Notification`/`AdminNotification` for the other party (see next entry — this notification path is removed the same day).
- Unread badges added to **every** admin and client nav (`views/admin/dashboard.ejs`, `analytics.ejs`, `coupons.ejs`; `views/dashboard.ejs`, `dashboard-account.ejs`, `dashboard-gallery.ejs`, `dashboard-new.ejs`, `dashboard-booking.ejs`, `dashboard-notifications.ejs`) — a small "Messages" sidebar link with an amber count badge, backed by `res.locals.unreadMessageCount`/`res.locals.adminUnreadMessageCount` injected via the existing `/dashboard`/`/admin` locals middleware (`Message.countDocuments({ senderRole: ..., read: false })`), and kept live via the existing 15s notification-poll partials (`_notif-poll.ejs`/`admin/_notif-poll.ejs`), which now also return `unreadMessageCount`/`adminUnreadMessageCount` alongside the existing notification count.
- `/admin` dashboard's booking table gained a per-row unread-message indicator (`unreadMessageBookingIds`, a `Set` built from one `distinct("bookingId")` query) so admin can see which bookings have unread client messages without opening `/admin/messages`.

**Decisions made:**
- Per-booking rooms with connect-time authorization rather than a per-message auth check — a socket only ever represents one project's thread (opened from a specific `/dashboard/messages/:id` or `/admin/booking/:id` page load), so it's cheaper to authorize once at `connect` than on every event; sending itself still goes through the normal session-checked HTTP routes regardless.
- Socket.IO is push-only — actually sending a message goes through a normal `multipart/form-data` POST (multer needs a real HTTP request to parse file uploads), and the socket purely broadcasts the resulting saved document to open threads in real time. This avoids reimplementing multer-equivalent binary handling over a websocket.
- Messaging shipped as its own dedicated `/messages` inbox (list + thread panel), not bolted onto the existing booking-detail pages — a client or admin with several active projects needs one place to see *all* conversations at a glance, which a per-booking-detail chat widget wouldn't give them.
- Chat attachments capped smaller (25 MB) than the member upload tier (250 MB) and kept in their own `files/chat/` folder — reinforces that chat attachments are meant as quick previews/references, not a second raw-footage delivery channel (that stays the `/hire` upload flow).

---

## 2026-07-06 — Status-Gate Enforcement, `new_booking` Admin Notifications, Deposit Breakdown Preview

**What was built:**

- `isStatusChangeAllowed(currentStatus, targetStatus)` (`server.js:86`, backed by `STATUS_CORE_ORDER = ["pending", "in-review", "accepted", "in-progress", "completed"]` at `server.js:64`) — the admin status picker previously let admin jump a booking to any status from any other status with no ordering rule. Now: `completed`/`declined` are terminal (no further changes at all); moving *forward* through the core order is capped at one step past the booking's current stage (so `pending` can go to `in-review` but not straight to `accepted`); moving *backward* to any earlier core stage is always allowed as a manual correction; `declined` is reachable from any non-terminal status; `paused` is only reachable from (or while already in) `in-progress`. `getStatusGate(currentStatus)` (`server.js:101`) computes the full allowed/disallowed map for every status in one call, used to render the picker.
- `POST /admin/booking/:id/status` (`server.js:1555`) now rejects disallowed transitions server-side, redirecting back with a `statusError` query param rendered as an inline error banner in `admin/booking.ejs` — this is a real enforcement point, not just a UI nicety. `POST /admin/bookings/bulk-status` (`server.js:1576`) filters candidate bookings through the same `isStatusChangeAllowed` check per-row before the `updateMany`, so a bulk action silently skips rows where the transition isn't valid for that row's current status rather than forcing it through.
- `admin/booking.ejs` status-picker buttons are now `disabled` (with `title` tooltips from `STATUS_GATE_HINTS`, e.g. "Requires reaching In Review first.", or `STATUS_GATE_TERMINAL_HINT` for completed/declined bookings) for any status the gate disallows from the booking's current state — matches the server-side rule exactly since both read off the same `isStatusChangeAllowed`/`getStatusGate` functions.
- New `AdminNotification` type `"new_booking"` — `notifyAdminNewBooking(booking)` (`server.js:428`) fires on every successful `/hire` submission (both the logged-in and guest/new-account branches), alongside the pre-existing `sendAdminNewBookingAlert` email (unchanged, still fires too — this doesn't replace it, it adds an in-app/poll channel on top). Message includes the client name, BR code, and a computed cost label (tier + final price after add-ons/discount, or "Custom (budget: ...)" for custom-tier requests). Rendered with a new amber `post-add` icon in `admin/notifications.ejs`/`admin/_notif-poll.ejs`. The admin dashboard's live poll partial now also triggers `fetchAndRender(location.href, false)` (the existing AJAX re-render function backing `/admin`'s search/pagination) when a `new_booking` event comes through while sitting on `/admin`, so a new booking appears in the table without a manual refresh.
- Admin booking detail's deposit form (`admin/booking.ejs`) gained a live-updating breakdown box showing "Deposit (30%)" and "Final (70%)" dollar amounts, recalculated on every keystroke in the price input alongside the existing submit-button-enable check — lets admin see the actual split before committing to "Send Deposit Invoice" instead of mentally computing 30/70 of whatever they typed.
- `socket.io` (`^4.8.3`) added to `package.json` dependencies — installed in this commit but not wired into `server.js` yet; the actual real-time messaging system lands in the next commit (see the Socket.IO entry above).
- Invoice-sent client notification copy updated ("Check your email" → "You can review it and pay anytime from your project page") for both deposit and final invoices, pointing the client back to `/track`/`/dashboard` rather than implying email is the only place to find it.

**Decisions made:**
- Forward moves capped at exactly one step (not "any forward move allowed") while backward moves are unrestricted — enforces that a booking can't skip review/acceptance straight to in-progress, while still letting admin freely correct a status set too far ahead (e.g. walking `accepted` back to `pending` if it was actioned by mistake) without that counting as a "skip."
- `declined` bypasses the core-order check entirely (reachable from anywhere non-terminal) since declining is a valid off-ramp at any stage, not a step in the happy path.
- `paused` is gated specifically to `in-progress` (mapped via `coreIndex`'s `paused → in-progress` aliasing) rather than being a general "any active state" pause — matches the existing product rule that pausing only makes sense once work has actually started.
- `new_booking` in-app notification is additive to the existing email alert, not a replacement — unlike the earlier nudge migration (email → in-app only), new-booking alerts are important enough that admin gets both channels.

---

## 2026-07-05 — Multi-Coupon Stacking, Admin Deposit Notifications, Booking/Track UI Overhaul

**What was built:**

- `BookingRequest.couponCode` (single string) replaced with `couponCodes[]` (`models/BookingRequest.js`) — each entry stores `code`, `discountType`, `discountValue`, and the actual `amount` deducted, not just the code. `POST /hire` (`server.js:784`, `MAX_COUPONS_PER_BOOKING = 3` at `server.js:366`) accepts up to 3 codes, de-duplicates them, and applies them **sequentially against a shrinking running total** — each coupon's discount is computed off what's left after the previous one, not off the original subtotal, so three stacked percent-off coupons compound rather than each taking a cut of the full price. The `Coupon` model itself (`models/Coupon.js`) is untouched — no `stackable`/exclusive flag was added, and `/hire/coupon/validate` (`server.js:707`) still validates one code at a time with no awareness of what else is already applied; the 3-cap and stacking order live entirely in the `/hire` POST handler and mirrored client-side JS, not in the coupon data model itself.
- `hire.ejs` and `dashboard-new.ejs` (both booking-submission forms) replaced the single hidden `couponCode` input with a **chip-based multi-coupon UI**: `appliedCoupons[]` client array, a chip per applied code with its live-computed discount amount and a remove (×) button, one hidden `couponCodes` input rendered per chip, capped at 3 with a "Maximum 3 coupons applied" state on the input/Apply button. Coupons are gated behind `couponsEnabled()` — disabled (opacity + pointer-events-none + hint text) until a non-Custom pricing tier or at least one add-on is selected, since a coupon against a $0/unset subtotal is meaningless.
- New `AdminNotification` type `"payment"` (`models/AdminNotification.js`) fires from the `invoice.payment_succeeded` webhook (`server.js`, deposit branch) whenever a deposit is paid — distinct from the existing client-facing `payment_confirmed` `Notification`. Message text branches on whether the booking is inactive (archived/declined/paused) — `"...Review manually."` — vs. active — `"...Confirm receipt and move it to in-progress."` Rendered with a distinct green `payments` icon (vs. the indigo nudge bell) in `admin/notifications.ejs` and the polling partial `admin/_notif-poll.ejs`.
- **Behavior change buried in the same webhook edit**: on an active booking's deposit payment, the webhook used to auto-flip `booking.status` straight to `"in-progress"`. That auto-transition was removed — deposit payment now only sets `depositStatus: "paid"` and leaves `status` untouched; the new admin notification's "Confirm receipt and move it to in-progress" wording is the tell that this is now a deliberate manual step for admin, not automatic. (This sets up the next day's status-gate enforcement — see above.)
- `dashboard-booking.ejs` payment card reworked: both deposit and final payment rows now always render (previously the final row only appeared once `finalPaymentStatus !== 'none'`), with the final row shown grayed out/"Once the deposit is paid" until it's actually active — so a client sees the full 30/70 split and both due dates up front instead of the final line materializing out of nowhere later. The separate "Total" line at the bottom was removed in favor of showing `agreedPrice` next to the "Payment" header itself.
- `/track` gained a full pipeline timeline: `pending → in-review → accepted → in-progress → completed` (was capped at `accepted`), plus dedicated non-progress-bar states for `paused` (violet), `archived`, and `filesDeleted` (both gray, "Project archived"/"Project deleted" messaging) — previously those states had no distinct treatment on the client-facing tracking page. `.select()` on both `/track` lookup paths now pulls `archived`/`filesDeleted` to support this.
- Native `confirm()` on client dashboard delete actions (single and bulk) replaced with a custom themed modal (`views/_confirm-modal.ejs`, new file, `showConfirm({ title, message, detail, confirmLabel, tone })` returning a Promise) — `dashboard.ejs`'s `deleteProject()`/`bulkDelete()` are now `async` and `await` it instead of blocking on the browser-native dialog.
- Footer brand name/tagline updated site-wide (`views/index.ejs`): "Jarumiri" → "Jarumiri Studios", "Hobby-driven. Detail-obsessed." → "Precision editing for content creators."
- `Plans/july26-milestone.md` gained 4 new backlog items during this session (brute-force protection on login, password reset flow, session cookie hardening, the `visitorId` compound index follow-up) plus a "Nice-to-haves" section for the deferred returning-client trust tier.

**Decisions made:**

- Stacking is sequential/compounding rather than each coupon computed independently off the full subtotal — chosen so 3 stacked percent coupons don't let discounts overlap into >100% off; a running-total model is the standard way multi-coupon systems avoid that.
- No `stackable` flag added to the `Coupon` model — every coupon is stackable with every other by default up to the 3-code cap; there's no way today to mark a coupon as exclusive/non-combinable. Left as a known gap, not a considered-and-rejected design.
- Auto-transitioning `status` to `in-progress` on deposit payment was removed in favor of a manual admin confirmation step — the new `AdminNotification` copy explicitly asks admin to move the project forward themselves rather than trusting the webhook to do it silently.
- Chip UI (vs. reusing the old single hidden-input pattern) needed real client-side state (`appliedCoupons[]` array) since more than one code can now be "applied" at once with independently removable entries.

---

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
