# Pages & Routes

## Public (no login required)

| Route | Page | Purpose |
|-------|------|---------|
| `/` | Landing | Hero, reel, services, pricing, about, footer |
| `/pricing` | Pricing | Detailed breakdown of packages and rates |
| `/hire` | Request Form | Project details, video links, file upload, Telegram instructions |
| `/track` | Project Tracker | Look up a booking by BR code or name + email combo |
| `/login` | Login | Existing user login |
| `/signup` | Sign Up | New user registration |

## Authenticated (login required)

| Route | Page | Purpose |
|-------|------|---------|
| `/dashboard` | Client Dashboard | All submitted requests and payment statuses |
| `/dashboard/booking/:id` | Booking Detail | Full detail view of a single request |
| `/dashboard/gallery` | File Gallery | Browse uploaded project files |
| `/dashboard/notifications` | Notifications | In-app alerts (status changes, invoices, payments) |
| `/dashboard/account` | Account Settings | Profile, password, account deletion |

## Admin (restricted to owner)

| Route | Page | Purpose |
|-------|------|---------|
| `/admin` | Admin Dashboard | All bookings with live search and status filters |
| `/admin/booking/:id` | Booking Detail | Full booking info, status picker, payment card, media links |
| `POST /admin/booking/:id/send-deposit` | — | Create Stripe customer + send 30% deposit invoice |
| `POST /admin/booking/:id/send-final` | — | Send 70% final invoice after deposit is paid |
| `POST /admin/booking/:id/status` | — | Update booking status + trigger client notification |
| `GET /admin/uploads/:filename` | — | Protected file serving (images inline, video/audio in-browser) |
| `POST /webhooks/stripe` | — | Stripe webhook — advances payment status on `invoice.payment_succeeded` |

## User Flow

```
Landing → /hire → Submit request (no login required)
                       ↓
           Admin reviews in /admin → sets price → sends 30% deposit invoice via Stripe
                       ↓
           Client pays deposit → booking status → in-progress
                       ↓
           Admin does the work → sends 70% final invoice via Stripe
                       ↓
           Client pays final → booking status → completed
                       ↓
           Client tracks progress any time via /track (BR code or name + email)
```
