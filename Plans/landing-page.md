# Landing Page Structure

Route: `/`
Design: Clean, minimal, lots of whitespace

---

## 1. Navbar
- Logo: Jarumiri Studios
- Links (in-page anchors): Services, Pricing, About, Careers (mobile drawer adds How It Works)
- "Log In" → `/login`
- CTA button: "Book A Project" → `/hire`

---

## 2. Hero
- Punchy headline and subline about what you do
- CTAs link into `/hire` and down to the reel section
- Background: dark, minimal (`#080808` base)

---

## 3. Reel / Work Samples
- `#reel` section exists in markup but is `display:none;` until real client work is ready to show — currently 3 placeholder cards (blank thumbnail, name, date)
- Self-hosted thumbnail grid, not a YouTube/Vimeo embed

---

## 4. How It Works
- `#process` section — explains the booking → invoice → 30% deposit → work → revisions flow (mirrors the [user flow in pages.md](pages.md))

---

## 5. Services
- `#services` section — cards for Video Editing, Color Grading, Sound Design, Motion Graphics

---

## 6. Pricing
- In-page section, id `#pricing` (no standalone `/pricing` route)
- 3 cards, each linking to `/hire?tier=<name>` to preselect on the request form (2026-07-13, `f1b8718`: the old flat $79 Clip package was replaced by a gated free tier — see `pages.md`'s `/hire` row and `Plans/journal.md`'s "Free Tier Replaces $79 Clip Package" entry for the account/weekly-cap/3-platform-link/testimonial gating):
  - **Clip** — Free (stored as `pricingTier: "Free"`; the old `"Clip"` enum value is kept only for historical $79 bookings)
  - **Scene** — $189 (marked "Popular")
  - **Feature** — $399 — unlimited/multi-part, custom LUT, sound design, motion graphics, 4 revisions, 10 days
  - Plus a **Custom** option on the `/hire` form itself for "name your budget"
- Add-ons strip below the tiers now scales by tier instead of a flat rate — Scene is +50%, Feature +150% on the base prices (Rush delivery $50, Platform cut $30, Captions $35, Censored preview $45, Intro/outro bumper $75, Extra revision $30); Captions, Intro/outro bumper, and Extra revision aren't offered on Free at all. Clicking a pricing card (`.pricing-card`, `selectPricingTier()`) highlights it and live-updates the displayed add-on prices for that tier (2026-07-13, uncommitted) — Scene selected by default on load.
- Coupon codes (percent or fixed amount, admin-managed) can be applied at checkout on `/hire`

---

## 7. About
- `#about` section — short paragraph on background/editing style; includes a line on the no-project-taken-unless-it-can-be-done-well standard

---

## 8. Careers
- `#career` section, "We're looking for Talents" — two open-role cards (Video Editor, Videographer) with a "Send Your Work" CTA to the Telegram handle
- Not in the original plan — added later as a recruiting section, separate from the client-facing booking flow

---

## 9. Footer
- Navigation links
- Telegram handle
- Copyright — Jarumiri Studios
