# July 2026 Milestone

## Pending

- [ ] Add `og:image` and `twitter:image` meta tags — needs a logo or cover image asset first (deferred from June)

### Security/Reliability
- [x] Brute-force protection on `/login` and `/admin/login` — added a `LoginAttempt` collection (TTL-indexed) tracking failed attempts in a 15-minute rolling window, capped at 5, same DB-backed pattern as `enforceGuestSubmissionQuota`/the nudge limiter. `/login` keys on the attempted email; `/admin/login` has no email, so it keys on the `jrmr_vid` visitor cookie instead (deliberately not IP — this app doesn't set `trust proxy` behind Railway, so `req.ip` would resolve to the proxy for everyone).
- [ ] Password reset flow for client accounts — no self-service recovery exists today; a client who forgets their password is simply stuck. Now that accounts gate real functionality (payments, deliverable downloads), this is closer to a missing basic feature than a nice-to-have.
- [ ] Harden session cookie config — `express-session`'s `secret` falls back to a hardcoded `"jarumiri-dev-secret"` (`server.js:153`) if `SESSION_SECRET` isn't set in the environment, and the cookie config (`server.js:157`) has no explicit `secure`/`sameSite`. Confirm `SESSION_SECRET` is actually set in the Railway env, and add `secure: true` (prod)/`sameSite` explicitly.
- [ ] Compound index `{ visitorId: 1, createdAt: -1 }` on `BookingRequest` — flagged as a follow-up when the guest-quota tiering shipped (2026-07-04); the guest-submission-quota `exists()` check is currently an unindexed scan.

### Nice-to-haves
- [ ] "Returning client" trust tier on `/hire` — a third tier between guest and full account holder (e.g. ≥1 completed project gets guest-like users more room than the base 3-file/25MB cap) — discussed and explicitly deferred when the two-tier guest/account system shipped.
