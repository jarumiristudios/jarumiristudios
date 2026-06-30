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
- `express-session` for session management
- No third-party auth providers

## Payments
- **Stripe** (no monthly fee — % per transaction only)
- Flow: **Stripe Invoices** (not Payment Links) — two invoices per project
  1. Admin accepts booking + sets agreed price → server creates Stripe customer + sends 30% deposit invoice
  2. Client pays → webhook fires `invoice.payment_succeeded` → booking moves to `in-progress`
  3. Work delivered → admin sends 70% final invoice
  4. Client pays → webhook fires again → booking moves to `completed`
- Invoices chosen over Payment Links for: formal paper trail, line items, auto-reminders, professional appearance

## File Delivery
- Users paste video links (YouTube, Google Drive, Dropbox, etc.) on the request form
- Raw files sent via **Telegram** (up to 2GB per file)
- No self-hosted file storage needed for v1

## Hosting
- **Railway.app** (free tier)
- MongoDB stays on Atlas (not self-hosted)

## Why these choices
- Zero monthly cost for a hobby/test project
- No data in third-party hands except Atlas (acceptable tradeoff for uptime)
- Simple stack — no React, no build pipeline complexity
- Can upgrade any piece independently when the project grows
