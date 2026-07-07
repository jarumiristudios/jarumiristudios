const express = require("express");
const mongoose = require("mongoose");
const dotenv = require("dotenv");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const multer = require("multer");
const sharp = require("sharp");
const session = require("express-session");
const cookieParser = require("cookie-parser");
const http = require("http");
const { Server } = require("socket.io");
const { MongoStore } = require("connect-mongo");
const BookingRequest = require("./models/BookingRequest");
const User = require("./models/User");
const Coupon = require("./models/Coupon");
const Notification = require("./models/Notification");
const AdminNotification = require("./models/AdminNotification");
const Message = require("./models/Message");
const LoginAttempt = require("./models/LoginAttempt");
const { sendBookingConfirmation, sendAdminNewBookingAlert, sendAcceptanceEmail, sendAdminInvoiceAlert, sendAdminPaymentAlert, sendAdminPauseAlert, sendAdminUnexpectedPaymentAlert } = require("./lib/mailer");
const { startInvoiceExpiryJob } = require("./lib/invoiceExpiry");

function endOfDay(dateStr) {
  if (!dateStr) return null;
  const d = new Date(`${dateStr}T23:59:59Z`);
  return isNaN(d.getTime()) ? null : d;
}

// Inclusive list of "YYYY-MM" keys spanning two dates, oldest first.
function monthKeysBetween(fromDate, toDate) {
  const keys = [];
  const cur = new Date(Date.UTC(fromDate.getUTCFullYear(), fromDate.getUTCMonth(), 1));
  const end = new Date(Date.UTC(toDate.getUTCFullYear(), toDate.getUTCMonth(), 1));
  while (cur <= end) {
    keys.push(`${cur.getUTCFullYear()}-${String(cur.getUTCMonth() + 1).padStart(2, "0")}`);
    cur.setUTCMonth(cur.getUTCMonth() + 1);
  }
  return keys;
}

function monthKeyLabel(key) {
  const [y, m] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-US", { month: "short", year: "2-digit", timeZone: "UTC" });
}

const MIN_DUE_DATE_LEAD_DAYS = 3;

function minDueDate() {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + MIN_DUE_DATE_LEAD_DAYS);
  return d;
}

const STATUS_LABELS = {
  pending: "Pending",
  "in-review": "In Review",
  accepted: "Accepted",
  declined: "Declined",
  "in-progress": "In Progress",
  completed: "Completed",
  paused: "Paused",
};

const BOOKING_STATUSES = Object.keys(STATUS_LABELS);

// Core happy-path progression. "paused" and "declined" are handled as special
// cases below rather than living in this line — see isStatusChangeAllowed.
const STATUS_CORE_ORDER = ["pending", "in-review", "accepted", "in-progress", "completed"];

const STATUS_GATE_HINTS = {
  "in-review": "Requires reaching Pending first.",
  accepted: "Requires reaching In Review first.",
  "in-progress": "Requires reaching Accepted first.",
  completed: "Requires reaching In Progress first.",
  paused: "Only available while In Progress.",
  declined: "Not available once Completed.",
  pending: "",
};
const STATUS_GATE_TERMINAL_HINT = "This booking is finalized — status can no longer be changed.";

// Can a booking currently at `currentStatus` move to `targetStatus`?
// Forward moves through the core order require having reached the prior stage;
// backward moves are always allowed as a manual correction, unless the booking
// is in a terminal state (completed/declined), which locks out all changes.
function isStatusChangeAllowed(currentStatus, targetStatus) {
  if (currentStatus === targetStatus) return true;
  if (currentStatus === "completed" || currentStatus === "declined") return false;

  if (targetStatus === "declined") return true;
  if (targetStatus === "paused") return currentStatus === "in-progress" || currentStatus === "paused";

  const coreIndex = (s) => STATUS_CORE_ORDER.indexOf(s === "paused" ? "in-progress" : s);
  const curIdx = coreIndex(currentStatus);
  const tgtIdx = STATUS_CORE_ORDER.indexOf(targetStatus);
  if (curIdx === -1 || tgtIdx === -1) return false;

  return tgtIdx <= curIdx + 1;
}

function getStatusGate(currentStatus) {
  const gate = {};
  for (const s of BOOKING_STATUSES) gate[s] = isStatusChangeAllowed(currentStatus, s);
  return gate;
}

dotenv.config();

const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer);
const PORT = process.env.PORT || 3000;

// View engine
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

// Stripe webhook — must be before express.json() to receive raw body for signature verification
app.post("/webhooks/stripe", express.raw({ type: "application/json" }), async (req, res) => {
  const sig = req.headers["stripe-signature"];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("Stripe webhook signature error:", err.message);
    return res.sendStatus(400);
  }

  try {
    if (event.type === "invoice.payment_succeeded") {
      const invoice = event.data.object;
      const crCode = invoice.metadata?.crCode;
      if (crCode) {
        const booking = await BookingRequest.findOne({ crCode });
        if (booking) {
          const isInactive = booking.archived || booking.status === "declined" || booking.status === "paused";
          let notifMsg = null;
          let paymentType = null;
          if (invoice.id === booking.depositInvoiceId) {
            booking.depositStatus = "paid";
            paymentType = "deposit";
            notifMsg = isInactive
              ? `We received your deposit payment for project ${booking.crCode}. We'll follow up shortly to confirm next steps.`
              : `Deposit payment received for project ${booking.crCode}. We'll confirm and begin work shortly.`;
          } else if (invoice.id === booking.finalInvoiceId) {
            booking.finalPaymentStatus = "paid";
            paymentType = "final";
            if (isInactive) {
              notifMsg = `We received your final payment for project ${booking.crCode}. We'll follow up shortly to confirm next steps.`;
            } else {
              booking.status = "completed";
              notifMsg = `Final payment confirmed for project ${booking.crCode}. Your project is complete!`;
              if (booking.deliverableFiles?.length > 0) {
                notifMsg += " Your final files are ready to download.";
              }
            }
          }
          await booking.save();
          if (paymentType) {
            const paidAmount = (invoice.amount_paid / 100);
            if (isInactive) {
              sendAdminUnexpectedPaymentAlert(booking, paymentType, paidAmount);
            } else {
              sendAdminPaymentAlert(booking, paymentType, paidAmount);
            }
          }
          if (notifMsg && booking.clientId) {
            await Notification.create({
              userId: booking.clientId,
              bookingId: booking._id,
              crCode: booking.crCode,
              type: "payment_confirmed",
              message: notifMsg,
            });
          }
          if (paymentType === "deposit") {
            const depositAmount = (invoice.amount_paid / 100).toFixed(2);
            await AdminNotification.create({
              bookingId: booking._id,
              crCode: booking.crCode,
              type: "payment",
              message: isInactive
                ? `Deposit of $${depositAmount} wired for project ${booking.crCode}, which is currently ${booking.archived ? "archived" : booking.status}. Review manually.`
                : `Deposit of $${depositAmount} wired for project ${booking.crCode}. Confirm receipt and move it to in-progress.`,
            });
          }
        }
      }
    }
  } catch (err) {
    console.error("Webhook processing error:", err.message);
    return res.sendStatus(500);
  }

  res.sendStatus(200);
});

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));
app.use(cookieParser());
app.use(assignVisitorId);
const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET || "jarumiri-dev-secret",
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({ mongoUrl: process.env.MONGO_URI }),
  cookie: { maxAge: 8 * 60 * 60 * 1000 }, // 8 hours
});
app.use(sessionMiddleware);
// Shares the same express-session with Socket.IO so a socket's handshake carries req.session
io.engine.use(sessionMiddleware);

const requireAdmin = (req, res, next) => {
  if (req.session.isAdmin) return next();
  res.redirect("/admin/login");
};

const requireClient = (req, res, next) => {
  if (req.session.userId) return next();
  res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
};

function chatRoom(bookingId) {
  return `project:${bookingId}`;
}

// Project chat — a socket only ever represents one project's thread (opened from either
// /dashboard/messages/:id or /admin/booking/:id), so authorization happens once at connect
// time rather than per-event. Sending still goes through normal HTTP POST routes below (multer
// needs a real request); this socket is push-only, used to broadcast those saved messages live.
io.on("connection", async (socket) => {
  const session = socket.request.session;
  const bookingId = socket.handshake.query.bookingId;
  if (!bookingId) return socket.disconnect(true);

  let authorized = false;
  if (session?.isAdmin) {
    authorized = await BookingRequest.exists({ _id: bookingId });
  } else if (session?.userId) {
    authorized = await BookingRequest.exists({ _id: bookingId, clientId: session.userId });
  }
  if (!authorized) return socket.disconnect(true);

  socket.join(chatRoom(bookingId));
});

// Database
mongoose
  .connect(process.env.MONGO_URI)
  .then(() => {
    console.log("MongoDB connected");
    startInvoiceExpiryJob(stripe);
  })
  .catch((err) => console.error("MongoDB error:", err));

// File upload (multer)
function fileTypeFromMime(mimetype) {
  if (/^video\//i.test(mimetype)) return "video";
  if (/^audio\//i.test(mimetype)) return "audio";
  if (/^image\//i.test(mimetype)) return "image";
  return "other";
}

// Checks the active uploads path, then the _archive path, for a given booking/type/filename.
// Sends the file and returns true if found in either location; returns false otherwise (caller decides the fallback).
function trySendStoredFile(res, crCode, type, filename) {
  const activePath = path.join(__dirname, "uploads", crCode, "files", type, filename);
  if (fs.existsSync(activePath)) { res.sendFile(activePath); return true; }
  const archivePath = path.join(__dirname, "uploads", "_archive", crCode, "files", type, filename);
  if (fs.existsSync(archivePath)) { res.sendFile(archivePath); return true; }
  return false;
}

// Renames a stored file from one files/<folder>/ subfolder to another, checking the active
// path then the _archive path (same convention as trySendStoredFile) and staying within
// whichever one the file is actually found in. Returns true on success.
function moveStoredFile(crCode, fromFolder, toFolder, filename) {
  for (const base of [path.join(__dirname, "uploads", crCode), path.join(__dirname, "uploads", "_archive", crCode)]) {
    const from = path.join(base, "files", fromFolder, filename);
    if (fs.existsSync(from)) {
      const toDir = path.join(base, "files", toFolder);
      fs.mkdirSync(toDir, { recursive: true });
      fs.renameSync(from, path.join(toDir, filename));
      return true;
    }
  }
  return false;
}

const CR_CODE_MAX_ATTEMPTS = 10;

async function generateCrCode() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const rand = () => Array.from({ length: 9 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  for (let attempt = 0; attempt < CR_CODE_MAX_ATTEMPTS; attempt++) {
    const r = rand();
    const code = `${r.slice(0, 3)}-${r.slice(3, 6)}-${r.slice(6, 9)}`;
    if (!(await BookingRequest.exists({ crCode: code }))) return code;
  }
  throw new Error(`Failed to generate a unique BR code after ${CR_CODE_MAX_ATTEMPTS} attempts`);
}

const VISITOR_ID_COOKIE = "jrmr_vid";
const VISITOR_ID_MAX_AGE = 365 * 24 * 60 * 60 * 1000; // ~1 year

// Long-lived anonymous visitor id, set for every visitor (not just guests) so it's
// already present by the time someone reaches /hire, and stored on every booking
// regardless of tier — reusable if a "returning client" tier gets added later.
function assignVisitorId(req, res, next) {
  let vid = req.cookies?.[VISITOR_ID_COOKIE];
  if (!vid) {
    vid = crypto.randomUUID();
    res.cookie(VISITOR_ID_COOKIE, vid, {
      maxAge: VISITOR_ID_MAX_AGE,
      httpOnly: true,
      sameSite: "lax",
    });
  }
  req.visitorId = vid;
  next();
}

const MEMBER_MAX_FILES = 20;
const MEMBER_MAX_FILE_SIZE = 250 * 1024 * 1024; // 250 MB
const GUEST_SUBMISSION_WINDOW_MS = 24 * 60 * 60 * 1000;

// Guests (no account) get 1 /hire submission per rolling 24h, keyed on the visitor
// cookie above — runs before preCrCode/multer so an over-quota guest costs nothing
// (no BR code generated, no bytes uploaded, nothing to clean up).
async function enforceGuestSubmissionQuota(req, res, next) {
  if (req.session.userId) return next();
  const since = new Date(Date.now() - GUEST_SUBMISSION_WINDOW_MS);
  const recent = await BookingRequest.exists({ visitorId: req.visitorId, createdAt: { $gte: since } });
  if (recent) {
    return res.render("hire", {
      error: "You've already submitted a request in the last 24 hours. Create a free account for unlimited submissions, or check back later.",
      loggedInUser: null,
      lastBooking: null,
      canUploadNow: false,
    });
  }
  next();
}

// Raw-file uploads at initial submission are reserved for clients with a proven track
// record (a past booking that actually paid a deposit) — everyone else, including guests
// (who have no durable identity to build that record on), submits brief + links only and
// gets file access once a human has reviewed the request (see FILE_ADD_ALLOWED_STATUSES).
async function hasTrustedDepositHistory(userId) {
  if (!userId) return false;
  return BookingRequest.exists({ clientId: userId, depositStatus: "paid" });
}

async function preCrCode(req, res, next) {
  try {
    req.crCode = await generateCrCode();
    next();
  } catch (err) {
    console.error("preCrCode failed:", err);
    res.render("hire", {
      error: "We couldn't process your request right now. Please try again in a moment.",
      loggedInUser: null,
      lastBooking: null,
    });
  }
}

const TIER_PRICES  = { Clip: 79, Scene: 189, Feature: 399 };
const ADDON_PRICES = { "Rush delivery": 50, "Platform cut": 30, "Captions": 35, "Censored preview": 45, "Intro/outro bumper": 75, "Extra revision": 30 };
const MAX_COUPONS_PER_BOOKING = 3;
const PRICING_TIERS = ["Clip", "Scene", "Feature", "Custom"];
const SERVICE_TYPES = ["Video Editing", "Color Grading", "Sound Design", "Motion Graphics"];
const PIPELINE_STATUS_ORDER = ["pending", "in-review", "accepted", "in-progress", "completed", "paused", "declined"];

function writeBookingTxt(booking) {
  const date = booking.createdAt.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
  const lines = [
    "JARUMIRI STUDIOS — PROJECT BRIEF",
    "=".repeat(40),
    `CR Code:   ${booking.crCode}`,
    `Submitted: ${date}`,
    "",
    "CLIENT",
    `  Name:     ${booking.name}`,
    `  Email:    ${booking.email}`,
    `  Location: ${booking.location}`,
  ];
  lines.push(
    "",
    "PROJECT",
    `  Services: ${booking.serviceType.join(", ")}`,
    `  Package:  ${booking.pricingTier}`,
  );
  if (booking.pricingTier === "Custom" && booking.budget) lines.push(`  Budget:   ${booking.budget}`);
  if (booking.addOns && booking.addOns.length > 0) lines.push(`  Add-ons:  ${booking.addOns.join(", ")}`);
  lines.push("", "BRIEF", booking.projectBrief);

  if (booking.mediaLinks && booking.mediaLinks.length > 0) {
    lines.push("", "MEDIA LINKS");
    booking.mediaLinks.forEach(l => lines.push(`  - ${l}`));
  }

  if (booking.uploadedFiles && booking.uploadedFiles.length > 0) {
    lines.push("", `UPLOADED FILES (${booking.uploadedFiles.length})`);
    booking.uploadedFiles.forEach(f => {
      const sizeLabel = f.size < 1024 * 1024
        ? (f.size / 1024).toFixed(1) + " KB"
        : (f.size / 1024 / 1024).toFixed(1) + " MB";
      lines.push(`  - ${f.originalName} (${fileTypeFromMime(f.mimetype)}, ${sizeLabel})`);
    });
  }

  const basePrice = TIER_PRICES[booking.pricingTier];
  if (basePrice !== undefined) {
    const addonTotal = (booking.addOns || []).reduce((s, a) => s + (ADDON_PRICES[a] || 0), 0);
    const subtotal = basePrice + addonTotal;
    lines.push("", "PRICING", `  ${booking.pricingTier} package: $${basePrice}`);
    (booking.addOns || []).forEach(a => { if (ADDON_PRICES[a]) lines.push(`  ${a}: +$${ADDON_PRICES[a]}`); });
    lines.push(`  Subtotal: $${subtotal}`);
    if (booking.couponCodes && booking.couponCodes.length > 0) {
      booking.couponCodes.forEach((c) => lines.push(`  Coupon ${c.code}: -$${c.amount.toFixed(2)}`));
      lines.push(`  Total: $${(subtotal - booking.discountAmount).toFixed(2)}`);
    }
  }

  const dir = path.join(__dirname, "uploads", booking.crCode);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "booking.txt"), lines.join("\n"), "utf8");
}

function notifyAdminNewBooking(booking) {
  const basePrice = TIER_PRICES[booking.pricingTier];
  const costLabel = basePrice !== undefined
    ? `${booking.pricingTier} package, $${(basePrice + (booking.addOns || []).reduce((s, a) => s + (ADDON_PRICES[a] || 0), 0) - (booking.discountAmount || 0)).toFixed(2)}`
    : `Custom${booking.budget ? ` (budget: ${booking.budget})` : ""}`;

  AdminNotification.create({
    bookingId: booking._id,
    crCode: booking.crCode,
    type: "new_booking",
    message: `New booking request from ${booking.name} (${booking.crCode}) — ${costLabel}.`,
  }).catch((err) => console.error("Error creating admin new-booking notification:", err.message));
}

// Normalizes either shape a Message can carry — the legacy single `attachment` (messages sent
// before multi-attachment support) or the current `attachments` array — into a plain array.
function messageAttachments(m) {
  if (m.attachments && m.attachments.length) return m.attachments;
  if (m.attachment && m.attachment.storedName) return [m.attachment];
  return [];
}

function messagePreview(body, attachments) {
  if (body) return body.length > 60 ? body.slice(0, 60) + "…" : body;
  if (attachments && attachments.length) {
    return attachments.length === 1 ? "📎 " + attachments[0].originalName : "📎 " + attachments.length + " files";
  }
  return "";
}

// Soft-deletes a message: clears its body/attachments (leaving a tombstone the UI renders as
// "This message was deleted") and removes any chat-uploaded files from disk. Attachments tagged
// from a project's own files ("uploaded"/"video"/etc. folders, not "chat") are left on disk since
// they still belong to the project regardless of this message being deleted.
async function softDeleteMessage(message) {
  if (message.deleted) return;
  messageAttachments(message)
    .filter((a) => (a.folder || "chat") === "chat")
    .forEach((a) => {
      fs.rm(path.join(__dirname, "uploads", message.crCode, "files", "chat", a.storedName), { force: true }, () => {});
      fs.rm(path.join(__dirname, "uploads", "_archive", message.crCode, "files", "chat", a.storedName), { force: true }, () => {});
    });
  message.deleted = true;
  message.body = "";
  message.attachment = undefined;
  message.attachments = [];
  await message.save();
}

// Builds a chat attachment that references an already-uploaded project file instead of a fresh
// composer upload, so tagging a file in chat doesn't duplicate it on disk. Returns null if the
// file doesn't exist on the booking, or (for clients) if it's a deliverable that isn't unlocked yet.
function resolveTaggedAttachment(booking, source, fileId, isClient) {
  const arrayName = source === "deliverable" ? "deliverableFiles" : "uploadedFiles";
  const file = booking[arrayName]?.id(fileId);
  if (!file) return null;
  if (arrayName === "deliverableFiles" && isClient && !booking.deliverablesUnlocked) return null;
  const folder = arrayName === "deliverableFiles" ? "deliverables" : fileTypeFromMime(file.mimetype);
  return {
    originalName: file.originalName,
    storedName: file.storedName,
    size: file.size,
    mimetype: file.mimetype,
    blurDataUrl: file.blurDataUrl,
    folder,
  };
}

// Resolves a JSON-encoded list of { id, source } tag requests into attachment objects.
// Returns null (caller should 400) if the JSON is malformed or any referenced file can't be tagged.
function resolveTaggedAttachments(booking, taggedFilesJson, isClient) {
  if (!taggedFilesJson) return [];
  let items;
  try {
    items = JSON.parse(taggedFilesJson);
  } catch {
    return null;
  }
  if (!Array.isArray(items)) return null;
  const attachments = [];
  for (const item of items) {
    const att = resolveTaggedAttachment(booking, item?.source, item?.id, isClient);
    if (!att) return null;
    attachments.push(att);
  }
  return attachments;
}

// A file just written by multer can briefly be held open (by Windows Defender's on-write scan,
// in observed testing) — retrying a couple of times a beat apart clears it without giving up
// on files that are only transiently busy, not actually stuck.
function retrySync(fn, attempts = 4, delayMs = 250) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return fn();
    } catch (err) {
      if (attempt === attempts) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
    }
  }
}

// Permanently removes uploaded media for a booking while keeping booking.txt as a record.
// Synchronous and awaited-in-order by archiveAndWipeBookingFiles below — the async fire-and-forget
// version of this raced the folder rename that follows it (rm still mid-flight on the "files"
// subtree when rename tried to move the parent folder), which intermittently lost the race and
// left the folder sitting in the active uploads/ path, wiped but never archived.
function hardDeleteBookingFiles(crCode) {
  if (!crCode) return;
  fs.rmSync(path.join(__dirname, "uploads", crCode, "files"), { recursive: true, force: true });
  fs.rmSync(path.join(__dirname, "uploads", "_archive", crCode, "files"), { recursive: true, force: true });
}

// Client-initiated "delete" — unlike admin archive (which just hides a project, files intact
// and restorable), this is meant to be irreversible: media is wiped and only the booking.txt
// record survives, tucked into _archive alongside admin-archived projects.
function archiveAndWipeBookingFiles(crCode) {
  if (!crCode) return;
  try {
    retrySync(() => hardDeleteBookingFiles(crCode));
    const archiveDir = path.join(__dirname, "uploads", "_archive");
    fs.mkdirSync(archiveDir, { recursive: true });
    retrySync(() => fs.renameSync(path.join(__dirname, "uploads", crCode), path.join(archiveDir, crCode)));
  } catch (err) {
    console.error(`Failed to archive/wipe files for booking ${crCode}:`, err.message);
  }
}

function uniqueFilename(originalname) {
  const unique = `${Date.now()}-${Math.round(Math.random() * 1e6)}`;
  return `${unique}${path.extname(originalname)}`;
}

// Tiny (24px-wide) heavily-blurred JPEG preview, inlined as a data URL, so a not-yet-downloaded
// image attachment can show a hint of its content behind the download prompt without the
// receiver's browser fetching the full file. Images only — no video frame extraction (no ffmpeg
// dependency in this project). Never throws: a failed/unsupported source just yields no preview.
async function generateBlurDataUrl(filePath, mimetype) {
  if (!/^image\//i.test(mimetype)) return undefined;
  try {
    const buf = await sharp(filePath).resize(32, 32, { fit: "inside" }).blur(0.5).jpeg({ quality: 50 }).toBuffer();
    return `data:image/jpeg;base64,${buf.toString("base64")}`;
  } catch {
    return undefined;
  }
}

// Rejects file types that browsers will render/execute as an active document (HTML, SVG) when
// opened directly — served files are trusted by extension at request time regardless of the
// declared upload mimetype, so these must never be accepted no matter what mimetype is claimed.
const DANGEROUS_UPLOAD_EXT_RE = /\.(html?|xhtml|shtml|svg)$/i;
function rejectDangerousFiles(req, file, cb) {
  if (DANGEROUS_UPLOAD_EXT_RE.test(file.originalname)) {
    return cb(new Error("That file type isn't allowed."));
  }
  cb(null, true);
}

// Client-submitted files (the /hire form) are further restricted to an allowlist matching
// the upload widget's own `accept` attribute (video/audio/image, plus .zip/.rar for raw
// footage archives) — admin-uploaded deliverables stay on the blocklist above only, since
// admin is trusted to hand back whatever final file type a project actually needs.
const ALLOWED_UPLOAD_MIME_RE = /^(video|audio|image)\//i;
const ARCHIVE_UPLOAD_EXT_RE = /\.(zip|rar)$/i;
// Archive mimetypes are inconsistent across browsers/OSes; .rar in particular is commonly
// reported as the generic application/octet-stream, so that's only trusted alongside a
// matching .zip/.rar extension, never on its own.
const ARCHIVE_UPLOAD_MIME_RE = /^application\/(zip|x-zip-compressed|x-rar-compressed|vnd\.rar|x-rar|octet-stream)$/i;
function restrictToAllowedMediaTypes(req, file, cb) {
  rejectDangerousFiles(req, file, (err) => {
    if (err) return cb(err);
    const isMedia = ALLOWED_UPLOAD_MIME_RE.test(file.mimetype);
    const isArchive = ARCHIVE_UPLOAD_EXT_RE.test(file.originalname) && ARCHIVE_UPLOAD_MIME_RE.test(file.mimetype);
    if (!isMedia && !isArchive) {
      return cb(new Error("That file type isn't allowed. Upload video, audio, image, or .zip/.rar files."));
    }
    cb(null, true);
  });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const type = fileTypeFromMime(file.mimetype);
    const dir = path.join(__dirname, "uploads", req.crCode, "files", type);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => cb(null, uniqueFilename(file.originalname)),
});
const upload = multer({
  storage,
  limits: { fileSize: MEMBER_MAX_FILE_SIZE },
  fileFilter: restrictToAllowedMediaTypes,
});
// Admin-uploaded final deliverables — separate storage so they never mix with client-submitted raw files
const deliverableStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, "uploads", req.crCode, "files", "deliverables");
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => cb(null, uniqueFilename(file.originalname)),
});
const deliverableUpload = multer({
  storage: deliverableStorage,
  limits: { fileSize: 250 * 1024 * 1024 }, // 250 MB
  fileFilter: rejectDangerousFiles,
});

// Chat attachments — quick references/previews, not raw footage delivery (that's what the
// main upload system above is for), so a smaller cap than member uploads.
const CHAT_ATTACHMENT_MAX_SIZE = 1024 * 1024 * 1024; // 1 GB
const CHAT_MAX_ATTACHMENTS = 10;
const chatStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, "uploads", req.crCode, "files", "chat");
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => cb(null, uniqueFilename(file.originalname)),
});
const chatUpload = multer({
  storage: chatStorage,
  limits: { fileSize: CHAT_ATTACHMENT_MAX_SIZE },
  fileFilter: restrictToAllowedMediaTypes,
});

// Also blocks uploads to an archived booking — its folder lives under uploads/_archive/, not the active path,
// so writing here before a restore would split the booking's files across both locations
async function attachCrCode(req, res, next) {
  const booking = await BookingRequest.findById(req.params.id).select("crCode archived");
  if (!booking) return res.redirect("/admin");
  if (booking.archived) return res.redirect(`/admin/booking/${req.params.id}`);
  req.crCode = booking.crCode;
  next();
}

// Client-side equivalent of attachCrCode above — also verifies the booking belongs to the
// logged-in client before any multer disk write happens.
async function attachCrCodeForClient(req, res, next) {
  const booking = await BookingRequest.findOne({ _id: req.params.id, clientId: req.session.userId }).select("crCode archived clientId name uploadedFiles deliverableFiles status");
  if (!booking) return res.sendStatus(403);
  if (booking.archived) return res.sendStatus(403);
  req.crCode = booking.crCode;
  req.booking = booking;
  next();
}

// Routes
app.get("/", (req, res) => {
  res.render("index");
});

app.get("/track", async (req, res) => {
  const { code, name, email } = req.query;

  if (!code && !name && !email) return res.render("track");

  if (name || email) {
    const booking = await BookingRequest.findOne({
      name: { $regex: new RegExp(`^${name?.trim()}$`, "i") },
      email: email?.trim().toLowerCase(),
    }).select("crCode name serviceType pricingTier budget status archived filesDeleted depositStatus depositDueDate depositInvoiceUrl finalPaymentStatus finalDueDate finalInvoiceUrl deliveryDate deliverableFiles createdAt");
    return res.render("track", { searched: true, method: "identity", name: name?.trim(), email: email?.trim(), booking });
  }

  const booking = await BookingRequest.findOne({ crCode: code.toUpperCase().trim() })
    .select("crCode name serviceType pricingTier budget status archived filesDeleted depositStatus depositDueDate depositInvoiceUrl finalPaymentStatus finalDueDate finalInvoiceUrl deliveryDate deliverableFiles createdAt");
  res.render("track", { searched: true, method: "code", code: code.toUpperCase().trim(), booking });
});

app.get("/hire", async (req, res) => {
  if (!req.session.userId) return res.render("hire", { canUploadNow: false });
  const user = await User.findById(req.session.userId);
  const [lastBooking, canUploadNow] = await Promise.all([
    user?.bookings?.length
      ? BookingRequest.findOne({ clientId: req.session.userId }).sort({ createdAt: -1 }).select("name location")
      : null,
    hasTrustedDepositHistory(req.session.userId),
  ]);
  res.render("hire", {
    loggedInUser: { email: user.email },
    lastBooking,
    canUploadNow,
  });
});

app.get("/hire/success", async (req, res) => {
  const { cr } = req.query;
  if (!cr) return res.redirect("/hire");
  const booking = await BookingRequest.findOne({ crCode: cr }).select("email clientId pricingTier addOns couponCodes discountAmount");
  if (!booking) return res.redirect("/hire");
  const alreadyLinked = !!booking.clientId;
  const existingUser = !alreadyLinked && await User.exists({ email: booking.email });
  res.render("hire", {
    success: true,
    crCode: cr,
    bookingEmail: booking.email,
    alreadyLinked,
    hasAccount: !!existingUser,
    pricingTier: booking.pricingTier,
    addOns: booking.addOns || [],
    couponCodes: booking.couponCodes || [],
    discountAmount: booking.discountAmount || 0,
  });
});

app.post("/hire/coupon/validate", async (req, res) => {
  const code = (req.body.code || "").trim().toUpperCase();
  if (!code) return res.json({ valid: false, message: "Please enter a coupon code." });

  const coupon = await Coupon.findOne({ code, active: true });
  if (!coupon) return res.json({ valid: false, message: "Coupon code not found." });
  if (coupon.expiresAt && new Date() > coupon.expiresAt) return res.json({ valid: false, message: "This coupon has expired." });

  res.json({
    valid: true,
    discountType: coupon.discountType,
    discountValue: coupon.discountValue,
    message: coupon.discountType === "percent"
      ? `${coupon.discountValue}% discount applied`
      : `$${coupon.discountValue} discount applied`,
  });
});

app.post("/hire", enforceGuestSubmissionQuota, preCrCode, async (req, res, next) => {
  const canUploadNow = await hasTrustedDepositHistory(req.session.userId);
  req.canUploadNow = canUploadNow;
  const maxFiles = canUploadNow ? MEMBER_MAX_FILES : 0;
  upload.array("files", maxFiles)(req, res, (err) => {
    if (!err) return next();
    const message = err.code === "LIMIT_FILE_SIZE"
      ? "One or more files exceed the 250MB limit."
      : err.code === "LIMIT_UNEXPECTED_FILE"
      ? canUploadNow
        ? "You can upload up to 20 files at a time."
        : "File uploads aren't available yet for new clients — add reference links below instead. We'll open uploads for this project once it moves to review."
      : err.message || "Upload failed.";
    return res.render("hire", { error: message, formData: req.body, loggedInUser: null, lastBooking: null, canUploadNow });
  });
}, async (req, res) => {
  const { name, email, location, pricingTier, budget, projectBrief } = req.body;
  const serviceType = [].concat(req.body.serviceType || []).filter(Boolean);
  const mediaLinks  = [].concat(req.body.mediaLinks  || []).filter(Boolean);
  const addOns      = [].concat(req.body.addOns      || []).filter(Boolean);
  const canUploadNow = req.canUploadNow;

  // Server-side validation
  const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!name || !email || !emailRe.test(email) || !location || !serviceType.length || !pricingTier || !projectBrief || projectBrief.length > 2000) {
    let loggedInUser = null;
    let lastBooking = null;
    if (req.session.userId) {
      const user = await User.findById(req.session.userId);
      if (user) {
        loggedInUser = { email: user.email };
        lastBooking = user.bookings?.length
          ? await BookingRequest.findOne({ clientId: req.session.userId }).sort({ createdAt: -1 }).select("name location")
          : null;
      }
    }
    return res.render("hire", {
      error: "Please fill in all required fields.",
      formData: req.body,
      loggedInUser,
      lastBooking,
      canUploadNow,
    });
  }

  try {
    const uploadedFiles = await Promise.all((req.files || []).map(async (f) => ({
      originalName: f.originalname,
      storedName: f.filename,
      size: f.size,
      mimetype: f.mimetype,
      blurDataUrl: await generateBlurDataUrl(f.path, f.mimetype),
    })));

    // Validate coupon server-side
    const basePrice  = TIER_PRICES[pricingTier] || 0;
    const addonTotal = addOns.reduce((s, a) => s + (ADDON_PRICES[a] || 0), 0);
    const subtotal   = basePrice + addonTotal;

    const couponCodes = [];
    let discountAmount = 0;
    const rawCodes = [...new Set([].concat(req.body.couponCodes || []).filter(Boolean).map((c) => c.trim().toUpperCase()))].slice(0, MAX_COUPONS_PER_BOOKING);
    if (rawCodes.length && subtotal > 0) {
      let running = subtotal;
      for (const rawCode of rawCodes) {
        const coupon = await Coupon.findOne({ code: rawCode, active: true });
        if (!coupon || (coupon.expiresAt && new Date() > coupon.expiresAt)) continue;
        const amount = coupon.discountType === "percent"
          ? Math.round(running * coupon.discountValue) / 100
          : Math.min(coupon.discountValue, running);
        couponCodes.push({ code: coupon.code, discountType: coupon.discountType, discountValue: coupon.discountValue, amount });
        discountAmount += amount;
        running -= amount;
      }
    }

    const booking = new BookingRequest({
      crCode: req.crCode,
      visitorId: req.visitorId,
      name,
      email,
      location,
      serviceType,
      pricingTier,
      addOns,
      budget: pricingTier === "Custom" ? budget : undefined,
      projectBrief,
      mediaLinks,
      uploadedFiles,
      couponCodes,
      discountAmount,
    });

    await booking.save();
    writeBookingTxt(booking);

    // Auto-link booking to logged-in user and send them straight to the dashboard
    if (req.session.userId) {
      try {
        booking.clientId = req.session.userId;
        await booking.save();
        const linkedUser = await User.findById(req.session.userId);
        if (linkedUser) {
          const alreadyLinked = linkedUser.bookings.some(id => id.toString() === booking._id.toString());
          if (!alreadyLinked) {
            linkedUser.bookings.push(booking._id);
            await linkedUser.save();
          }
        }
      } catch (linkErr) {
        console.error("Error linking booking to user:", linkErr);
      }
      sendBookingConfirmation(booking);
      sendAdminNewBookingAlert(booking);
      notifyAdminNewBooking(booking);
      return res.redirect(`/dashboard?submitted=${booking.crCode}`);
    }

    sendBookingConfirmation(booking);
    sendAdminNewBookingAlert(booking);
    notifyAdminNewBooking(booking);

    res.redirect(`/hire/success?cr=${booking.crCode}`);
  } catch (err) {
    console.error("Booking save error:", err);
    res.render("hire", {
      error: "Something went wrong saving your request. Please try again.",
      formData: req.body,
    });
  }
});

const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_ATTEMPT_WINDOW_MS = 15 * 60 * 1000;

// Failed-login lockout, same rolling-window pattern as enforceGuestSubmissionQuota
// and the nudge limiter above. /login keys on the attempted email; /admin/login has
// no email to key on, so it uses the visitor cookie instead (see assignVisitorId).
async function isLoginLocked(key) {
  const since = new Date(Date.now() - LOGIN_ATTEMPT_WINDOW_MS);
  const count = await LoginAttempt.countDocuments({ key, createdAt: { $gte: since } });
  return count >= LOGIN_MAX_ATTEMPTS;
}

// ── Client auth routes ──
app.get("/login", (req, res) => {
  if (req.session.userId) return res.redirect("/dashboard");
  res.render("login", { next: req.query.next || "/dashboard", cr: req.query.cr || "" });
});

app.post("/login", async (req, res) => {
  const { email, password, next, cr } = req.body;
  const attemptKey = `login:${email?.trim().toLowerCase() || ""}`;

  if (await isLoginLocked(attemptKey)) {
    return res.render("login", { error: "Too many failed attempts. Please try again in a few minutes.", next: next || "/dashboard", cr });
  }

  const user = await User.findOne({ email: email?.trim().toLowerCase() });
  if (!user || !(await user.verifyPassword(password))) {
    await LoginAttempt.create({ key: attemptKey });
    return res.render("login", { error: "Invalid email or password.", next: next || "/dashboard", cr });
  }
  await LoginAttempt.deleteMany({ key: attemptKey });
  req.session.userId = user._id.toString();

  // Link a just-submitted booking if a crCode was passed through
  if (cr) {
    const booking = await BookingRequest.findOne({ crCode: cr.toUpperCase().trim(), clientId: null });
    if (booking) {
      booking.clientId = user._id;
      await booking.save();
      if (!user.bookings.includes(booking._id)) {
        user.bookings.push(booking._id);
        await user.save();
      }
    }
  }

  res.redirect(next && next.startsWith("/") ? next : "/dashboard");
});

app.get("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/login"));
});

app.post("/signup", async (req, res) => {
  const { email, password, crCode } = req.body;
  const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  if (!email || !emailRe.test(email) || !password || password.length < 8) {
    return res.redirect(`/hire/success?cr=${crCode}`);
  }

  const booking = await BookingRequest.findOne({ crCode: crCode?.toUpperCase().trim() });
  if (!booking) return res.redirect("/hire");

  try {
    const user = new User({
      email: email.trim().toLowerCase(),
      password,
      name: booking.name || "",
      location: booking.location || "",
      bookings: [booking._id],
    });
    await user.save();
    booking.clientId = user._id;
    await booking.save();
    req.session.userId = user._id.toString();
    res.redirect("/dashboard");
  } catch (err) {
    if (err.code === 11000) {
      // Email already taken — send back to success page with error hint
      return res.redirect(`/hire/success?cr=${crCode}`);
    }
    console.error("Signup error:", err);
    res.redirect(`/hire/success?cr=${crCode}`);
  }
});

// Inject unread notification count into all /dashboard views
app.use("/dashboard", async (req, res, next) => {
  res.locals.unreadCount = 0;
  res.locals.unreadMessageCount = 0;
  if (req.session.userId) {
    try {
      res.locals.unreadCount = await Notification.countDocuments({ userId: req.session.userId, read: false });
      res.locals.unreadMessageCount = await Message.countDocuments({ clientId: req.session.userId, senderRole: "admin", read: false });
    } catch {}
  }
  next();
});

app.get("/dashboard", requireClient, async (req, res) => {
  const user = await User.findById(req.session.userId).populate({
    path: "bookings",
    match: { filesDeleted: { $ne: true } },
    select: "crCode serviceType pricingTier addOns discountAmount status createdAt revisions uploadedFiles deliverableFiles agreedPrice depositStatus depositInvoiceUrl finalPaymentStatus finalInvoiceUrl projectBrief archived",
    options: { sort: { createdAt: -1 } },
  });
  if (!user) {
    req.session.destroy(() => res.redirect("/login"));
    return;
  }
  res.render("dashboard", { user, submitted: req.query.submitted || null, TIER_PRICES, ADDON_PRICES });
});

app.get("/dashboard/account", requireClient, async (req, res) => {
  const user = await User.findById(req.session.userId);
  if (!user) { req.session.destroy(() => res.redirect("/login")); return; }
  res.render("dashboard-account", { user, success: req.query.success || null, error: null });
});

app.post("/dashboard/account/profile", requireClient, async (req, res) => {
  const { name, location, accountType, externalLink } = req.body;
  if (!name?.trim() || !location?.trim()) {
    const user = await User.findById(req.session.userId);
    return res.render("dashboard-account", { user, error: "Name and location are required.", success: null });
  }
  const rawLink = (externalLink || "").trim();
  const safeLink = rawLink && !rawLink.match(/^https?:\/\//) ? "https://" + rawLink : rawLink;
  await User.findByIdAndUpdate(req.session.userId, {
    name: name.trim(),
    location: location.trim(),
    accountType: (accountType || "").trim(),
    externalLink: safeLink,
  });
  const redirectTo = req.query.next || "/dashboard/account";
  res.redirect(redirectTo.startsWith("/") ? redirectTo : "/dashboard/account");
});

app.post("/dashboard/account/password", requireClient, async (req, res) => {
  const { currentPassword, newPassword, confirmPassword } = req.body;
  const user = await User.findById(req.session.userId);
  if (!user) { req.session.destroy(() => res.redirect("/login")); return; }

  if (!await user.verifyPassword(currentPassword)) {
    return res.render("dashboard-account", { user, error: "Current password is incorrect.", success: null });
  }
  if (!newPassword || newPassword.length < 8) {
    return res.render("dashboard-account", { user, error: "New password must be at least 8 characters.", success: null });
  }
  if (newPassword !== confirmPassword) {
    return res.render("dashboard-account", { user, error: "Passwords don't match.", success: null });
  }

  user.password = newPassword;
  await user.save();
  res.redirect("/dashboard/account?success=1");
});

app.post("/dashboard/account/delete", requireClient, async (req, res) => {
  const { confirmEmail } = req.body;
  const user = await User.findById(req.session.userId);
  if (!user) { req.session.destroy(() => res.redirect("/login")); return; }
  if (!confirmEmail || confirmEmail.trim().toLowerCase() !== user.email) {
    return res.render("dashboard-account", { user, success: null, error: "Email confirmation didn't match. Account not deleted." });
  }

  // Deleting the account cascades exactly like deleting each project individually — same
  // irreversible file wipe — since an orphaned clientId would otherwise leave every project's
  // raw footage and deliverables stranded on disk with no owner able to reach or clean them up.
  const bookings = await BookingRequest.find({ clientId: user._id, filesDeleted: { $ne: true } }).select("crCode");
  await BookingRequest.updateMany(
    { clientId: user._id },
    { filesDeleted: true, uploadedFiles: [], deliverableFiles: [], archived: true }
  );
  bookings.forEach((b) => archiveAndWipeBookingFiles(b.crCode));

  await User.findByIdAndDelete(user._id);
  req.session.destroy(() => res.redirect("/"));
});

app.get("/dashboard/new", requireClient, async (req, res) => {
  const user = await User.findById(req.session.userId);
  if (!user) {
    req.session.destroy(() => res.redirect("/login"));
    return;
  }
  const profileComplete = !!(user.name?.trim() && user.location?.trim());
  const canUploadNow = await hasTrustedDepositHistory(req.session.userId);
  res.render("dashboard-new", { user, profileComplete, canUploadNow });
});

app.get("/dashboard/booking/:id", requireClient, async (req, res) => {
  const [booking, user] = await Promise.all([
    BookingRequest.findOne({ _id: req.params.id, clientId: req.session.userId, filesDeleted: { $ne: true } }),
    User.findById(req.session.userId).select("email"),
  ]);
  if (!booking) return res.redirect("/dashboard");
  res.render("dashboard-booking", { booking, user });
});

app.post("/dashboard/booking/:id/delete", requireClient, async (req, res) => {
  const booking = await BookingRequest.findOneAndUpdate(
    { _id: req.params.id, clientId: req.session.userId },
    { filesDeleted: true, uploadedFiles: [], deliverableFiles: [], archived: true }
  );
  archiveAndWipeBookingFiles(booking?.crCode);
  res.redirect("/dashboard");
});

app.post("/dashboard/booking/:id/pause", requireClient, async (req, res) => {
  const booking = await BookingRequest.findOneAndUpdate(
    {
      _id: req.params.id,
      clientId: req.session.userId,
      archived: { $ne: true },
      status: { $nin: ["declined", "completed", "paused"] },
    },
    { status: "paused" },
    { new: true }
  );
  if (!booking) return res.sendStatus(404);
  sendAdminPauseAlert(booking);
  res.sendStatus(200);
});

app.post("/dashboard/booking/:id/nudge", requireClient, async (req, res) => {
  const booking = await BookingRequest.findOne({
    _id: req.params.id,
    clientId: req.session.userId,
    archived: { $ne: true },
    status: { $nin: ["declined", "completed"] },
  });
  if (!booking) return res.sendStatus(404);

  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const recentNudges = await AdminNotification.countDocuments({
    bookingId: booking._id,
    type: "nudge",
    createdAt: { $gte: oneHourAgo },
  });
  if (recentNudges >= 3) {
    return res.status(429).json({ error: "You can only nudge up to 3 times per hour." });
  }

  await AdminNotification.create({
    bookingId: booking._id,
    crCode: booking.crCode,
    type: "nudge",
    message: `${booking.name} nudged you about project ${booking.crCode}.`,
  });
  res.sendStatus(200);
});

app.post("/dashboard/booking/:id/revision", requireClient, async (req, res) => {
  const { message } = req.body;
  if (!message?.trim()) return res.redirect(`/dashboard/booking/${req.params.id}`);
  await BookingRequest.findOneAndUpdate(
    { _id: req.params.id, clientId: req.session.userId },
    { $push: { revisions: { message: message.trim() } } }
  );
  res.redirect(`/dashboard/booking/${req.params.id}`);
});

// Once a booking has actually been looked at (past pending) the client is trusted to add raw
// files — mirrors the trust gate on /hire but keyed on this project's own status instead of
// the client's history, since even a first-time client earns that trust once reviewed.
const FILE_ADD_ALLOWED_STATUSES = ["in-review", "accepted", "in-progress", "paused"];

app.post("/dashboard/booking/:id/upload-files", requireClient, async (req, res, next) => {
  const booking = await BookingRequest.findOne({ _id: req.params.id, clientId: req.session.userId })
    .select("crCode archived status name uploadedFiles");
  if (!booking) return res.status(404).json({ error: "Project not found." });
  if (booking.archived || !FILE_ADD_ALLOWED_STATUSES.includes(booking.status)) {
    return res.status(403).json({ error: "Files can only be added once your project has moved past the initial review stage." });
  }
  req.crCode = booking.crCode;
  req.booking = booking;
  upload.array("files", MEMBER_MAX_FILES)(req, res, (err) => {
    if (!err) return next();
    const message = err.code === "LIMIT_FILE_SIZE" ? "One or more files exceed the 250MB limit."
      : err.code === "LIMIT_UNEXPECTED_FILE" ? "You can upload up to 20 files at a time."
      : err.message || "Upload failed.";
    return res.status(400).json({ error: message });
  });
}, async (req, res) => {
  if (!req.files?.length) return res.status(400).json({ error: "No files received." });
  const newFiles = await Promise.all(req.files.map(async (f) => ({
    originalName: f.originalname,
    storedName: f.filename,
    size: f.size,
    mimetype: f.mimetype,
    blurDataUrl: await generateBlurDataUrl(f.path, f.mimetype),
  })));

  const booking = req.booking;
  booking.uploadedFiles.push(...newFiles);
  await booking.save();

  AdminNotification.create({
    bookingId: booking._id,
    crCode: booking.crCode,
    type: "files_added",
    message: `${booking.name} added ${newFiles.length} file${newFiles.length > 1 ? "s" : ""} to project ${booking.crCode}.`,
  }).catch((err) => console.error("Error creating admin files-added notification:", err.message));

  res.json({ ok: true, count: newFiles.length });
});

// ── Admin routes ──

// Inject unread admin notification count into all /admin views
app.use("/admin", async (req, res, next) => {
  res.locals.adminUnreadCount = 0;
  res.locals.adminUnreadMessageCount = 0;
  if (req.session.isAdmin) {
    try {
      res.locals.adminUnreadCount = await AdminNotification.countDocuments({ read: false });
      res.locals.adminUnreadMessageCount = await Message.countDocuments({ senderRole: "client", read: false });
    } catch {}
  }
  next();
});

app.get("/admin/login", (req, res) => {
  if (req.session.isAdmin) return res.redirect("/admin");
  res.render("admin/login");
});

app.post("/admin/login", async (req, res) => {
  const attemptKey = `admin:${req.visitorId}`;

  if (await isLoginLocked(attemptKey)) {
    return res.render("admin/login", { error: "Too many failed attempts. Please try again in a few minutes." });
  }

  if (req.body.password === process.env.ADMIN_PASSWORD) {
    await LoginAttempt.deleteMany({ key: attemptKey });
    req.session.isAdmin = true;
    return res.redirect("/admin");
  }
  await LoginAttempt.create({ key: attemptKey });
  res.render("admin/login", { error: "Incorrect password." });
});

app.get("/admin/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/admin/login"));
});

app.get("/admin/notifications", requireAdmin, async (req, res) => {
  const notifications = await AdminNotification.find().sort({ createdAt: -1 }).limit(200);
  await AdminNotification.updateMany({ read: false }, { read: true });
  res.locals.adminUnreadCount = 0;
  res.render("admin/notifications", { notifications });
});

app.get("/api/admin/notifications/poll", requireAdmin, async (req, res) => {
  const since = parseInt(req.query.since) || 0;
  const [unreadCount, adminUnreadMessageCount, items, newMessages] = await Promise.all([
    AdminNotification.countDocuments({ read: false }),
    Message.countDocuments({ senderRole: "client", read: false }),
    since
      ? AdminNotification.find({ createdAt: { $gt: new Date(since) } }).sort({ createdAt: -1 }).lean()
      : [],
    since
      ? Message.find({ senderRole: "client", createdAt: { $gt: new Date(since) } }).sort({ createdAt: -1 }).lean()
      : [],
  ]);
  const messageItems = newMessages.map((m) => ({
    bookingId: m.bookingId,
    crCode: m.crCode,
    preview: messagePreview(m.body, messageAttachments(m)),
  }));
  res.json({ unreadCount, adminUnreadMessageCount, items, messageItems, now: Date.now() });
});

app.post("/api/admin/notifications/mark-read", requireAdmin, async (req, res) => {
  await AdminNotification.updateMany({ read: false }, { read: true });
  res.json({ ok: true });
});

const ADMIN_PAGE_SIZE = 30;
const ADMIN_SEARCH_FIELDS = {
  crCode: "crCode",
  name: "name",
  email: "email",
  location: "location",
  services: "serviceType",
  package: "pricingTier",
  status: "status",
};

app.get("/admin", requireAdmin, async (req, res) => {
  const archivedView = req.query.view === "archived";
  const filter = archivedView ? { archived: true } : { archived: { $ne: true } };

  const statusParam = (req.query.status || "all").trim();
  if (!archivedView && statusParam !== "all") {
    const statuses = statusParam.split(",").filter(Boolean);
    if (statuses.length) filter.status = { $in: statuses };
  }

  const q = (req.query.q || "").trim();
  const field = ADMIN_SEARCH_FIELDS[req.query.field] ? req.query.field : "all";
  if (q) {
    const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    filter.$or = field === "all"
      ? Object.values(ADMIN_SEARCH_FIELDS).map((f) => ({ [f]: re }))
      : [{ [ADMIN_SEARCH_FIELDS[field]]: re }];
  }

  const dateFrom = (req.query.dateFrom || "").trim();
  const dateTo = (req.query.dateTo || "").trim();
  const fromDate = dateFrom ? new Date(`${dateFrom}T00:00:00Z`) : null;
  const toDate = endOfDay(dateTo);
  if ((fromDate && !isNaN(fromDate.getTime())) || toDate) {
    filter.createdAt = {};
    if (fromDate && !isNaN(fromDate.getTime())) filter.createdAt.$gte = fromDate;
    if (toDate) filter.createdAt.$lte = toDate;
  }

  const [total, pending] = await Promise.all([
    BookingRequest.countDocuments(filter),
    BookingRequest.countDocuments({ archived: { $ne: true }, status: "pending" }),
  ]);
  const totalPages = Math.max(1, Math.ceil(total / ADMIN_PAGE_SIZE));
  const page = Math.min(Math.max(1, parseInt(req.query.page) || 1), totalPages);

  const bookings = await BookingRequest.find(filter)
    .sort({ createdAt: -1 })
    .skip((page - 1) * ADMIN_PAGE_SIZE)
    .limit(ADMIN_PAGE_SIZE);

  const unreadMessageBookingIds = new Set(
    (await Message.find({ senderRole: "client", read: false }).distinct("bookingId")).map(String)
  );

  const locals = {
    bookings, total, pending, TIER_PRICES, ADDON_PRICES, archivedView,
    page, totalPages, pageSize: ADMIN_PAGE_SIZE, q, field, statusParam, STATUS_LABELS,
    dateFrom, dateTo, unreadMessageBookingIds,
  };

  if (req.xhr) {
    res.render("admin/_filter-summary", locals, (err, summaryHtml) => {
      if (err) return res.status(500).end();
      res.render("admin/_results-table", locals, (err2, tableHtml) => {
        if (err2) return res.status(500).end();
        res.json({ summaryHtml, tableHtml });
      });
    });
    return;
  }

  res.render("admin/dashboard", locals);
});

app.get("/admin/analytics", requireAdmin, async (req, res) => {
  const dateFrom = (req.query.dateFrom || "").trim();
  const dateTo = (req.query.dateTo || "").trim();

  const defaultFrom = new Date();
  defaultFrom.setUTCDate(1);
  defaultFrom.setUTCHours(0, 0, 0, 0);
  defaultFrom.setUTCMonth(defaultFrom.getUTCMonth() - 11);

  const fromDate = (dateFrom && !isNaN(new Date(`${dateFrom}T00:00:00Z`).getTime()))
    ? new Date(`${dateFrom}T00:00:00Z`)
    : defaultFrom;
  const toDate = endOfDay(dateTo) || new Date();

  const [facetResult] = await BookingRequest.aggregate([
    { $match: { archived: { $ne: true }, createdAt: { $gte: fromDate, $lte: toDate } } },
    {
      $addFields: {
        revenue: {
          $add: [
            { $cond: [{ $eq: ["$depositStatus", "paid"] }, { $multiply: [{ $ifNull: ["$agreedPrice", 0] }, 0.3] }, 0] },
            { $cond: [{ $eq: ["$finalPaymentStatus", "paid"] }, { $multiply: [{ $ifNull: ["$agreedPrice", 0] }, 0.7] }, 0] },
          ],
        },
        trustGroup: { $cond: [{ $ne: ["$clientId", null] }, "account", "guest"] },
        hasCoupon: { $cond: [{ $gt: [{ $size: { $ifNull: ["$couponCodes", []] } }, 0] }, 1, 0] },
      },
    },
    {
      $facet: {
        byMonth: [
          { $group: { _id: { $dateToString: { format: "%Y-%m", date: "$createdAt", timezone: "UTC" } }, count: { $sum: 1 }, revenue: { $sum: "$revenue" } } },
        ],
        byTier: [
          { $group: { _id: "$pricingTier", revenue: { $sum: "$revenue" }, count: { $sum: 1 } } },
        ],
        byService: [
          { $unwind: "$serviceType" },
          { $group: { _id: "$serviceType", count: { $sum: 1 } } },
        ],
        funnel: [
          { $group: {
              _id: null,
              total: { $sum: 1 },
              depositPaid: { $sum: { $cond: [{ $eq: ["$depositStatus", "paid"] }, 1, 0] } },
              completed: { $sum: { $cond: [{ $eq: ["$status", "completed"] }, 1, 0] } },
          } },
        ],
        byTrust: [
          { $group: {
              _id: "$trustGroup",
              total: { $sum: 1 },
              completed: { $sum: { $cond: [{ $eq: ["$status", "completed"] }, 1, 0] } },
          } },
        ],
        coupon: [
          { $group: {
              _id: null,
              totalBookings: { $sum: 1 },
              couponBookings: { $sum: "$hasCoupon" },
              totalDiscount: { $sum: { $ifNull: ["$discountAmount", 0] } },
          } },
        ],
        dealSize: [
          { $match: { agreedPrice: { $gt: 0 } } },
          { $group: { _id: null, avgPrice: { $avg: "$agreedPrice" } } },
        ],
        revenueTotal: [
          { $group: { _id: null, total: { $sum: "$revenue" } } },
        ],
      },
    },
  ]);

  const monthKeys = monthKeysBetween(fromDate, toDate);
  const byMonthMap = new Map(facetResult.byMonth.map((r) => [r._id, r]));
  const bookingsPerMonth = monthKeys.map((key) => ({
    label: monthKeyLabel(key),
    value: byMonthMap.get(key)?.count || 0,
  }));
  const revenuePerMonth = monthKeys.map((key) => ({
    label: monthKeyLabel(key),
    value: Math.round(byMonthMap.get(key)?.revenue || 0),
  }));

  const byTierMap = new Map(facetResult.byTier.map((r) => [r._id, r]));
  const revenueByTier = PRICING_TIERS.map((tier) => ({
    label: tier,
    value: Math.round(byTierMap.get(tier)?.revenue || 0),
  }));

  const byServiceMap = new Map(facetResult.byService.map((r) => [r._id, r]));
  const bookingsByService = SERVICE_TYPES.map((service) => ({
    label: service,
    value: byServiceMap.get(service)?.count || 0,
  }));

  const funnel = facetResult.funnel[0] || { total: 0, depositPaid: 0, completed: 0 };

  const byTrustMap = new Map(facetResult.byTrust.map((r) => [r._id, r]));
  const trustGroups = ["guest", "account"].map((g) => {
    const row = byTrustMap.get(g) || { total: 0, completed: 0 };
    return {
      label: g === "guest" ? "Guest" : "Account holder",
      total: row.total,
      completed: row.completed,
      rate: row.total ? Math.round((row.completed / row.total) * 100) : 0,
    };
  });

  const couponStats = facetResult.coupon[0] || { totalBookings: 0, couponBookings: 0, totalDiscount: 0 };
  const avgDealSize = facetResult.dealSize[0]?.avgPrice || 0;
  const revenueCollected = Math.round(facetResult.revenueTotal[0]?.total || 0);

  const pipelineRaw = await BookingRequest.aggregate([
    { $match: { archived: { $ne: true } } },
    { $group: { _id: "$status", count: { $sum: 1 } } },
  ]);
  const pipelineMap = new Map(pipelineRaw.map((r) => [r._id, r.count]));
  const pipelineSnapshot = PIPELINE_STATUS_ORDER.map((status) => ({
    label: STATUS_LABELS[status] || status,
    value: pipelineMap.get(status) || 0,
  }));

  res.render("admin/analytics", {
    dateFrom: dateFrom || fromDate.toISOString().slice(0, 10),
    dateTo: dateTo || toDate.toISOString().slice(0, 10),
    kpi: {
      totalBookings: funnel.total,
      revenueCollected,
      avgDealSize: Math.round(avgDealSize),
      conversionRate: funnel.total ? Math.round((funnel.completed / funnel.total) * 100) : 0,
    },
    bookingsPerMonth,
    revenuePerMonth,
    revenueByTier,
    bookingsByService,
    funnel,
    trustGroups,
    couponStats,
    pipelineSnapshot,
  });
});

app.get("/admin/booking/:id", requireAdmin, async (req, res) => {
  const booking = await BookingRequest.findById(req.params.id);
  if (!booking) return res.redirect("/admin");
  const bookingUnreadMessageCount = booking.clientId
    ? await Message.countDocuments({ bookingId: booking._id, senderRole: "client", read: false })
    : 0;
  res.render("admin/booking", {
    booking,
    bookingUnreadMessageCount,
    statusGate: getStatusGate(booking.status),
    statusGateHints: STATUS_GATE_HINTS,
    statusGateTerminalHint: STATUS_GATE_TERMINAL_HINT,
    statusError: req.query.statusError || null,
    stripeError: req.query.error || null,
    deliverError: req.query.deliverError || null,
    delivered: req.query.delivered ? parseInt(req.query.delivered, 10) : null,
  });
});

app.post("/admin/booking/:id/messages", requireAdmin, async (req, res, next) => {
  const booking = await BookingRequest.findById(req.params.id).select("crCode archived clientId uploadedFiles deliverableFiles status");
  if (!booking) return res.status(404).json({ error: "Project not found." });
  if (booking.archived) return res.status(403).json({ error: "This project is archived." });
  if (!booking.clientId) return res.status(400).json({ error: "This project has no linked client account." });
  req.crCode = booking.crCode;
  req.booking = booking;
  next();
}, (req, res, next) => {
  chatUpload.array("attachments", CHAT_MAX_ATTACHMENTS)(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    next();
  });
}, async (req, res) => {
  const body = (req.body.body || "").trim();

  const attachments = await Promise.all((req.files || []).map(async (f) => ({
    originalName: f.originalname, storedName: f.filename, size: f.size, mimetype: f.mimetype, folder: "chat",
    blurDataUrl: await generateBlurDataUrl(f.path, f.mimetype),
  })));
  const tagged = resolveTaggedAttachments(req.booking, req.body.taggedFiles, false);
  if (tagged === null) return res.status(400).json({ error: "One of those files couldn't be found." });
  attachments.push(...tagged);

  if (!body && attachments.length === 0) return res.status(400).json({ error: "Message can't be empty." });

  const message = await Message.create({
    bookingId: req.params.id,
    crCode: req.booking.crCode,
    clientId: req.booking.clientId,
    senderRole: "admin",
    body,
    attachments,
  });

  io.to(chatRoom(req.params.id)).emit("new-message", message);
  res.json({ message });
});

app.post("/admin/booking/:id/messages/:messageId/delete", requireAdmin, async (req, res) => {
  const message = await Message.findOne({ _id: req.params.messageId, bookingId: req.params.id, senderRole: "admin" });
  if (!message) return res.status(404).json({ error: "Message not found." });
  await softDeleteMessage(message);
  io.to(chatRoom(req.params.id)).emit("message-deleted", { messageId: message._id, bookingId: req.params.id });
  res.json({ ok: true });
});

async function adminMessageThreads() {
  const bookings = await BookingRequest.find({ clientId: { $ne: null } })
    .select("crCode name serviceType status archived createdAt")
    .sort({ createdAt: -1 });
  return Promise.all(bookings.map(async (booking) => {
    const [lastMessage, unreadCount] = await Promise.all([
      Message.findOne({ bookingId: booking._id }).sort({ createdAt: -1 }),
      Message.countDocuments({ bookingId: booking._id, senderRole: "client", read: false }),
    ]);
    return { booking, lastMessage, unreadCount };
  }));
}

app.get("/admin/messages", requireAdmin, async (req, res) => {
  const threads = await adminMessageThreads();
  res.render("admin/messages", { threads });
});

app.get("/admin/messages/:id", requireAdmin, async (req, res) => {
  const booking = await BookingRequest.findOne({ _id: req.params.id, clientId: { $ne: null } });
  if (!booking) return res.redirect("/admin/messages");
  const messages = await Message.find({ bookingId: booking._id }).sort({ createdAt: 1 });
  await Message.updateMany({ bookingId: booking._id, senderRole: "client", read: false }, { read: true });

  if (req.xhr) {
    return res.render("admin/_message-thread-panel", {
      booking, messages, myRole: "admin",
      attachmentBasePath: "/admin/messages/attachments",
      postPath: `/admin/booking/${booking._id}/messages`,
    });
  }

  const threads = await adminMessageThreads();
  res.render("admin/messages", { threads, booking, messages });
});

app.get("/admin/messages/attachments/:filename", requireAdmin, async (req, res) => {
  const filename = path.basename(req.params.filename);
  const message = await Message.findOne({ $or: [{ "attachments.storedName": filename }, { "attachment.storedName": filename }] });
  if (!message) return res.sendStatus(404);
  const att = messageAttachments(message).find((a) => a.storedName === filename);
  if (!att) return res.sendStatus(404);
  if (message.senderRole !== "admin" && !att.downloaded) {
    att.downloaded = true;
    await message.save();
  }
  if (trySendStoredFile(res, message.crCode, att.folder || "chat", filename)) return;
  res.sendStatus(404);
});

// Promotes a chat-shared file (uploaded fresh in the composer, not tagged from existing project
// files) into the booking's official uploadedFiles — moves it out of files/chat/ into the
// matching files/<type>/ subfolder and updates the message's own record of where it lives.
app.post("/admin/messages/attachments/:filename/save-to-project", requireAdmin, async (req, res) => {
  const filename = path.basename(req.params.filename);
  const message = await Message.findOne({ $or: [{ "attachments.storedName": filename }, { "attachment.storedName": filename }] });
  if (!message) return res.sendStatus(404);
  const att = messageAttachments(message).find((a) => a.storedName === filename);
  if (!att) return res.sendStatus(404);
  if (att.folder && att.folder !== "chat") return res.status(400).json({ error: "Already in project files." });

  const booking = await BookingRequest.findById(message.bookingId);
  if (!booking) return res.sendStatus(404);
  if (booking.archived) return res.status(403).json({ error: "This project is archived." });

  const type = fileTypeFromMime(att.mimetype);
  if (!moveStoredFile(message.crCode, "chat", type, filename)) {
    return res.status(404).json({ error: "File not found on disk." });
  }

  booking.uploadedFiles.push({ originalName: att.originalName, storedName: att.storedName, size: att.size, mimetype: att.mimetype, blurDataUrl: att.blurDataUrl });
  await booking.save();

  att.folder = type;
  await message.save();

  res.json({ ok: true });
});

async function notifyStatusChange(bookings, newStatus) {
  const label = STATUS_LABELS[newStatus] || newStatus;
  const notifications = [];
  for (const b of bookings) {
    if (!b.clientId) continue;
    notifications.push({
      userId: b.clientId,
      bookingId: b._id,
      crCode: b.crCode,
      type: newStatus === "declined" ? "project_dismissed" : "status_change",
      message: newStatus === "declined"
        ? `Project ${b.crCode} has been declined.`
        : `Project ${b.crCode} has moved to ${label}.`,
    });
    if (newStatus === "completed" && b.deliverableFiles?.length > 0) {
      notifications.push({
        userId: b.clientId,
        bookingId: b._id,
        crCode: b.crCode,
        type: "deliverable_ready",
        message: `Your final files are ready to download for project ${b.crCode}.`,
      });
    }
  }
  if (notifications.length) await Notification.insertMany(notifications);
}

app.post("/admin/booking/:id/status", requireAdmin, async (req, res) => {
  const existing = await BookingRequest.findById(req.params.id).select("status");
  if (!existing) return res.redirect("/admin");
  if (existing.status === req.body.status) return res.redirect(`/admin/booking/${req.params.id}`);
  if (!BOOKING_STATUSES.includes(req.body.status) || !isStatusChangeAllowed(existing.status, req.body.status)) {
    return res.redirect(`/admin/booking/${req.params.id}?statusError=${encodeURIComponent("That status change isn't allowed yet.")}`);
  }

  const booking = await BookingRequest.findByIdAndUpdate(
    req.params.id,
    { status: req.body.status },
    { new: true }
  );
  if (booking) await notifyStatusChange([booking], req.body.status);
  res.redirect(`/admin/booking/${req.params.id}`);
});

app.post("/admin/bookings/bulk-status", requireAdmin, async (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids : [req.body.ids].filter(Boolean);
  const status = req.body.status;
  if (ids.length && BOOKING_STATUSES.includes(status)) {
    const candidates = await BookingRequest.find(
      { _id: { $in: ids }, status: { $ne: status } },
      "clientId crCode deliverableFiles status"
    );
    const bookings = candidates.filter((b) => isStatusChangeAllowed(b.status, status));
    if (bookings.length) {
      await BookingRequest.updateMany({ _id: { $in: bookings.map((b) => b._id) } }, { status });
      await notifyStatusChange(bookings, status);
    }
  }
  res.redirect("/admin");
});

app.post("/admin/booking/:id/deliverables", requireAdmin, attachCrCode, (req, res, next) => {
  deliverableUpload.array("files", 20)(req, res, (err) => {
    if (!err) return next();
    const message = err.code === "LIMIT_FILE_SIZE" ? "One or more files exceed the 250MB limit."
      : err.code === "LIMIT_UNEXPECTED_FILE" ? "You can upload up to 20 files at a time."
      : err.message || "Upload failed.";
    res.redirect(`/admin/booking/${req.params.id}?deliverError=${encodeURIComponent(message)}`);
  });
}, async (req, res) => {
  const newFiles = await Promise.all((req.files || []).map(async (f) => ({
    originalName: f.originalname,
    storedName: f.filename,
    size: f.size,
    mimetype: f.mimetype,
    blurDataUrl: await generateBlurDataUrl(f.path, f.mimetype),
  })));
  if (newFiles.length === 0) {
    return res.redirect(`/admin/booking/${req.params.id}?deliverError=${encodeURIComponent("No files were selected.")}`);
  }
  const booking = await BookingRequest.findByIdAndUpdate(
    req.params.id,
    { $push: { deliverableFiles: { $each: newFiles } } },
    { new: true }
  );
  if (booking && booking.clientId && booking.status === "completed") {
    await Notification.create({
      userId: booking.clientId,
      bookingId: booking._id,
      crCode: booking.crCode,
      type: "deliverable_ready",
      message: `Your final files are ready to download for project ${booking.crCode}.`,
    });
  }
  res.redirect(`/admin/booking/${req.params.id}?delivered=${newFiles.length}`);
});

app.post("/admin/booking/:id/deliverables/:fileId/delete", requireAdmin, async (req, res) => {
  const booking = await BookingRequest.findById(req.params.id);
  if (booking && !booking.archived) {
    const file = booking.deliverableFiles.id(req.params.fileId);
    if (file) {
      fs.rm(path.join(__dirname, "uploads", booking.crCode, "files", "deliverables", file.storedName), { force: true }, () => {});
      fs.rm(path.join(__dirname, "uploads", "_archive", booking.crCode, "files", "deliverables", file.storedName), { force: true }, () => {});
      booking.deliverableFiles.pull(req.params.fileId);
      await booking.save();
    }
  }
  res.redirect(`/admin/booking/${req.params.id}`);
});

app.post("/admin/booking/:id/notes", requireAdmin, async (req, res) => {
  const text = (req.body.note || "").trim();
  if (text) {
    await BookingRequest.findByIdAndUpdate(req.params.id, { $push: { adminNotes: { text } } });
  }
  res.redirect(`/admin/booking/${req.params.id}`);
});

app.post("/admin/booking/:id/notes/:noteId/delete", requireAdmin, async (req, res) => {
  await BookingRequest.findByIdAndUpdate(req.params.id, { $pull: { adminNotes: { _id: req.params.noteId } } });
  res.redirect(`/admin/booking/${req.params.id}`);
});

app.post("/admin/booking/:id/notes/:noteId/edit", requireAdmin, async (req, res) => {
  const text = (req.body.text || "").trim();
  if (text) {
    await BookingRequest.updateOne(
      { _id: req.params.id, "adminNotes._id": req.params.noteId },
      { $set: { "adminNotes.$.text": text } }
    );
  }
  res.redirect(`/admin/booking/${req.params.id}`);
});

app.post("/admin/booking/:id/send-deposit", requireAdmin, async (req, res) => {
  const booking = await BookingRequest.findById(req.params.id);
  if (!booking || booking.depositStatus !== "none") return res.redirect(`/admin/booking/${req.params.id}`);

  const agreedPrice = parseFloat(req.body.agreedPrice);
  if (!agreedPrice || agreedPrice <= 0) return res.redirect(`/admin/booking/${req.params.id}`);

  const depositDueDate = endOfDay(req.body.dueDate);
  if (!depositDueDate || depositDueDate < minDueDate()) {
    return res.redirect(`/admin/booking/${req.params.id}?error=${encodeURIComponent(`Deposit due date must be at least ${MIN_DUE_DATE_LEAD_DAYS} days from today.`)}`);
  }

  try {
    const existing = await stripe.customers.list({ email: booking.email, limit: 1 });
    const customer = existing.data.length
      ? existing.data[0]
      : await stripe.customers.create({
          email: booking.email,
          name: booking.name,
          metadata: { crCode: booking.crCode },
        });

    const invoice = await stripe.invoices.create({
      customer: customer.id,
      collection_method: "send_invoice",
      due_date: Math.floor(depositDueDate.getTime() / 1000),
      currency: "usd",
      metadata: { crCode: booking.crCode },
    });

    await stripe.invoiceItems.create({
      customer: customer.id,
      invoice: invoice.id,
      amount: Math.round(agreedPrice * 0.30 * 100),
      currency: "usd",
      description: `30% Deposit — Jarumiri Studios (${booking.crCode})`,
    });

    const finalized = await stripe.invoices.finalizeInvoice(invoice.id);
    await stripe.invoices.sendInvoice(invoice.id);

    booking.agreedPrice = agreedPrice;
    booking.stripeCustomerId = customer.id;
    booking.depositInvoiceId = invoice.id;
    booking.depositInvoiceUrl = finalized.hosted_invoice_url;
    booking.depositStatus = "pending";
    booking.status = "accepted";
    booking.depositDueDate = depositDueDate;
    await booking.save();

    sendAcceptanceEmail(booking);
    sendAdminInvoiceAlert(booking, "deposit", agreedPrice * 0.30, finalized.hosted_invoice_url);

    if (booking.clientId) {
      await Notification.create({
        userId: booking.clientId,
        bookingId: booking._id,
        crCode: booking.crCode,
        type: "invoice_sent",
        message: `A deposit invoice ($${(agreedPrice * 0.30).toFixed(2)}) has been sent for project ${booking.crCode}. You can review it and pay anytime from your project page.`,
      });
    }
  } catch (err) {
    console.error("Stripe deposit invoice error:", err.message);
    return res.redirect(`/admin/booking/${req.params.id}?error=${encodeURIComponent(err.message)}`);
  }

  res.redirect(`/admin/booking/${req.params.id}`);
});

app.post("/admin/booking/:id/deposit-due-date", requireAdmin, async (req, res) => {
  const booking = await BookingRequest.findById(req.params.id);
  if (!booking || booking.depositStatus !== "pending") return res.redirect(`/admin/booking/${req.params.id}`);

  const depositDueDate = endOfDay(req.body.dueDate);
  if (!depositDueDate || depositDueDate < minDueDate()) {
    return res.redirect(`/admin/booking/${req.params.id}?error=${encodeURIComponent(`Deposit due date must be at least ${MIN_DUE_DATE_LEAD_DAYS} days from today.`)}`);
  }
  if (booking.depositDueDate && depositDueDate.getTime() === booking.depositDueDate.getTime()) {
    return res.redirect(`/admin/booking/${req.params.id}`);
  }

  try {
    if (booking.depositInvoiceId) {
      await stripe.invoices.voidInvoice(booking.depositInvoiceId);
    }

    const invoice = await stripe.invoices.create({
      customer: booking.stripeCustomerId,
      collection_method: "send_invoice",
      due_date: Math.floor(depositDueDate.getTime() / 1000),
      currency: "usd",
      metadata: { crCode: booking.crCode },
    });

    await stripe.invoiceItems.create({
      customer: booking.stripeCustomerId,
      invoice: invoice.id,
      amount: Math.round(booking.agreedPrice * 0.30 * 100),
      currency: "usd",
      description: `30% Deposit — Jarumiri Studios (${booking.crCode})`,
    });

    const finalized = await stripe.invoices.finalizeInvoice(invoice.id);
    await stripe.invoices.sendInvoice(invoice.id);

    booking.depositInvoiceId = invoice.id;
    booking.depositInvoiceUrl = finalized.hosted_invoice_url;
    booking.depositDueDate = depositDueDate;
    booking.depositReminderSent = false;
    await booking.save();

    if (booking.clientId) {
      const dueDateStr = depositDueDate.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
      await Notification.create({
        userId: booking.clientId,
        bookingId: booking._id,
        crCode: booking.crCode,
        type: "due_date_updated",
        message: `The deposit due date for project ${booking.crCode} has been moved to ${dueDateStr}. A fresh payment link has been sent.`,
      });
    }
  } catch (err) {
    console.error("Stripe deposit due-date update error:", err.message);
    return res.redirect(`/admin/booking/${req.params.id}?error=${encodeURIComponent(err.message)}`);
  }

  res.redirect(`/admin/booking/${req.params.id}`);
});

app.post("/admin/booking/:id/delivery-date", requireAdmin, async (req, res) => {
  const booking = await BookingRequest.findById(req.params.id);
  if (!booking || booking.depositStatus !== "paid") return res.redirect(`/admin/booking/${req.params.id}`);

  if (req.body.deliveryDate) {
    const parsed = new Date(`${req.body.deliveryDate}T00:00:00`);
    if (!isNaN(parsed.getTime())) booking.deliveryDate = parsed;
  } else {
    booking.deliveryDate = null;
  }
  await booking.save();
  res.redirect(`/admin/booking/${req.params.id}`);
});

app.post("/admin/booking/:id/send-final", requireAdmin, async (req, res) => {
  const booking = await BookingRequest.findById(req.params.id);
  if (!booking || booking.depositStatus !== "paid" || booking.finalPaymentStatus !== "none") {
    return res.redirect(`/admin/booking/${req.params.id}`);
  }

  const finalDueDate = endOfDay(req.body.dueDate);
  if (!finalDueDate || finalDueDate < minDueDate()) {
    return res.redirect(`/admin/booking/${req.params.id}?error=${encodeURIComponent(`Final due date must be at least ${MIN_DUE_DATE_LEAD_DAYS} days from today.`)}`);
  }

  try {
    const invoice = await stripe.invoices.create({
      customer: booking.stripeCustomerId,
      collection_method: "send_invoice",
      due_date: Math.floor(finalDueDate.getTime() / 1000),
      currency: "usd",
      metadata: { crCode: booking.crCode },
    });

    await stripe.invoiceItems.create({
      customer: booking.stripeCustomerId,
      invoice: invoice.id,
      amount: Math.round(booking.agreedPrice * 0.70 * 100),
      currency: "usd",
      description: `Final Payment — Jarumiri Studios (${booking.crCode})`,
    });

    const finalized = await stripe.invoices.finalizeInvoice(invoice.id);
    await stripe.invoices.sendInvoice(invoice.id);

    booking.finalInvoiceId = invoice.id;
    booking.finalInvoiceUrl = finalized.hosted_invoice_url;
    booking.finalPaymentStatus = "pending";
    booking.finalDueDate = finalDueDate;
    await booking.save();

    sendAdminInvoiceAlert(booking, "final", booking.agreedPrice * 0.70, finalized.hosted_invoice_url);

    if (booking.clientId) {
      await Notification.create({
        userId: booking.clientId,
        bookingId: booking._id,
        crCode: booking.crCode,
        type: "invoice_sent",
        message: `A final invoice ($${(booking.agreedPrice * 0.70).toFixed(2)}) has been sent for project ${booking.crCode}. You can review it and pay anytime from your project page.`,
      });
    }
  } catch (err) {
    console.error("Stripe final invoice error:", err.message);
    return res.redirect(`/admin/booking/${req.params.id}?error=${encodeURIComponent(err.message)}`);
  }

  res.redirect(`/admin/booking/${req.params.id}`);
});

app.post("/admin/booking/:id/final-due-date", requireAdmin, async (req, res) => {
  const booking = await BookingRequest.findById(req.params.id);
  if (!booking || booking.finalPaymentStatus !== "pending") return res.redirect(`/admin/booking/${req.params.id}`);

  const finalDueDate = endOfDay(req.body.dueDate);
  if (!finalDueDate || finalDueDate < minDueDate()) {
    return res.redirect(`/admin/booking/${req.params.id}?error=${encodeURIComponent(`Final due date must be at least ${MIN_DUE_DATE_LEAD_DAYS} days from today.`)}`);
  }
  if (booking.finalDueDate && finalDueDate.getTime() === booking.finalDueDate.getTime()) {
    return res.redirect(`/admin/booking/${req.params.id}`);
  }

  try {
    if (booking.finalInvoiceId) {
      await stripe.invoices.voidInvoice(booking.finalInvoiceId);
    }

    const invoice = await stripe.invoices.create({
      customer: booking.stripeCustomerId,
      collection_method: "send_invoice",
      due_date: Math.floor(finalDueDate.getTime() / 1000),
      currency: "usd",
      metadata: { crCode: booking.crCode },
    });

    await stripe.invoiceItems.create({
      customer: booking.stripeCustomerId,
      invoice: invoice.id,
      amount: Math.round(booking.agreedPrice * 0.70 * 100),
      currency: "usd",
      description: `Final Payment — Jarumiri Studios (${booking.crCode})`,
    });

    const finalized = await stripe.invoices.finalizeInvoice(invoice.id);
    await stripe.invoices.sendInvoice(invoice.id);

    booking.finalInvoiceId = invoice.id;
    booking.finalInvoiceUrl = finalized.hosted_invoice_url;
    booking.finalDueDate = finalDueDate;
    booking.finalReminderSent = false;
    await booking.save();

    if (booking.clientId) {
      const dueDateStr = finalDueDate.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
      await Notification.create({
        userId: booking.clientId,
        bookingId: booking._id,
        crCode: booking.crCode,
        type: "due_date_updated",
        message: `The final payment due date for project ${booking.crCode} has been moved to ${dueDateStr}. A fresh payment link has been sent.`,
      });
    }
  } catch (err) {
    console.error("Stripe final due-date update error:", err.message);
    return res.redirect(`/admin/booking/${req.params.id}?error=${encodeURIComponent(err.message)}`);
  }

  res.redirect(`/admin/booking/${req.params.id}`);
});

app.post("/admin/booking/:id/archive", requireAdmin, async (req, res) => {
  const booking = await BookingRequest.findById(req.params.id);
  if (booking && booking.clientId) {
    await Notification.create({
      userId: booking.clientId,
      bookingId: booking._id,
      crCode: booking.crCode,
      type: "project_dismissed",
      message: `Project ${booking.crCode} has been archived.`,
    });
  }
  await BookingRequest.findByIdAndUpdate(req.params.id, { archived: true });
  if (booking?.crCode) {
    const archiveDir = path.join(__dirname, "uploads", "_archive");
    fs.mkdirSync(archiveDir, { recursive: true });
    fs.rename(path.join(__dirname, "uploads", booking.crCode), path.join(archiveDir, booking.crCode), () => {});
  }
  res.redirect("/admin");
});

app.post("/admin/bookings/bulk-archive", requireAdmin, async (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids : [req.body.ids].filter(Boolean);
  if (ids.length) {
    const bookings = await BookingRequest.find({ _id: { $in: ids } }, "clientId crCode _id");
    const notifications = bookings
      .filter(b => b.clientId)
      .map(b => ({
        userId: b.clientId,
        bookingId: b._id,
        crCode: b.crCode,
        type: "project_dismissed",
        message: `Project ${b.crCode} has been archived.`,
      }));
    if (notifications.length) await Notification.insertMany(notifications);
    await BookingRequest.updateMany({ _id: { $in: ids } }, { archived: true });
    const archiveDir = path.join(__dirname, "uploads", "_archive");
    fs.mkdirSync(archiveDir, { recursive: true });
    for (const b of bookings) {
      if (b.crCode) {
        fs.rename(path.join(__dirname, "uploads", b.crCode), path.join(archiveDir, b.crCode), () => {});
      }
    }
  }
  res.redirect("/admin");
});

app.post("/admin/booking/:id/restore", requireAdmin, async (req, res) => {
  const booking = await BookingRequest.findOneAndUpdate(
    { _id: req.params.id, filesDeleted: { $ne: true } },
    { archived: false }
  );
  if (booking?.crCode) {
    const archiveDir = path.join(__dirname, "uploads", "_archive");
    fs.rename(path.join(archiveDir, booking.crCode), path.join(__dirname, "uploads", booking.crCode), () => {});
  }
  res.redirect("/admin");
});

app.post("/admin/booking/:id/revision/:revId/reviewed", requireAdmin, async (req, res) => {
  await BookingRequest.updateOne(
    { _id: req.params.id, "revisions._id": req.params.revId },
    { $set: { "revisions.$.status": "reviewed" } }
  );
  res.redirect(`/admin/booking/${req.params.id}`);
});

app.get("/admin/uploads/:filename", requireAdmin, async (req, res) => {
  const filename = path.basename(req.params.filename);
  const booking = await BookingRequest.findOne({
    $or: [{ "uploadedFiles.storedName": filename }, { "deliverableFiles.storedName": filename }],
  });
  if (booking) {
    const uploadedMatch = booking.uploadedFiles.find(f => f.storedName === filename);
    const type = uploadedMatch ? fileTypeFromMime(uploadedMatch.mimetype) : "deliverables";
    if (trySendStoredFile(res, booking.crCode, type, filename)) return;
  }
  res.sendFile(path.join(__dirname, "uploads", filename));
});

// ── Admin coupon routes ──
app.get("/admin/coupons", requireAdmin, async (req, res) => {
  const coupons = await Coupon.find().sort({ createdAt: -1 });
  res.render("admin/coupons", { coupons });
});

app.post("/admin/coupons", requireAdmin, async (req, res) => {
  const { code, discountType, discountValue, expiresAt } = req.body;
  try {
    await new Coupon({ code, discountType, discountValue: parseFloat(discountValue), expiresAt: expiresAt || null }).save();
  } catch (err) {
    console.error("Coupon create error:", err.message);
  }
  res.redirect("/admin/coupons");
});

app.post("/admin/coupons/:id/toggle", requireAdmin, async (req, res) => {
  const coupon = await Coupon.findById(req.params.id);
  if (coupon) { coupon.active = !coupon.active; await coupon.save(); }
  res.redirect("/admin/coupons");
});

app.post("/admin/coupons/:id/delete", requireAdmin, async (req, res) => {
  await Coupon.findByIdAndDelete(req.params.id);
  res.redirect("/admin/coupons");
});

app.get("/dashboard/notifications", requireClient, async (req, res) => {
  const notifications = await Notification.find({ userId: req.session.userId }).sort({ createdAt: -1 });
  await Notification.updateMany({ userId: req.session.userId, read: false }, { read: true });
  res.locals.unreadCount = 0;
  res.render("dashboard-notifications", { notifications });
});

app.post("/dashboard/notifications/mark-all-read", requireClient, async (req, res) => {
  await Notification.updateMany({ userId: req.session.userId, read: false }, { read: true });
  res.redirect("/dashboard/notifications");
});

// ── Client project chat ──

async function clientMessageThreads(userId) {
  const user = await User.findById(userId).populate({
    path: "bookings",
    select: "crCode serviceType pricingTier status archived createdAt",
    options: { sort: { createdAt: -1 } },
  });
  if (!user) return null;
  const activeBookings = (user.bookings || []).filter((booking) => !booking.archived);
  const threads = await Promise.all(activeBookings.map(async (booking) => {
    const [lastMessage, unreadCount] = await Promise.all([
      Message.findOne({ bookingId: booking._id }).sort({ createdAt: -1 }),
      Message.countDocuments({ bookingId: booking._id, senderRole: "admin", read: false }),
    ]);
    return { booking, lastMessage, unreadCount };
  }));
  return threads;
}

app.get("/dashboard/messages", requireClient, async (req, res) => {
  const threads = await clientMessageThreads(req.session.userId);
  if (threads === null) { req.session.destroy(() => res.redirect("/login")); return; }
  res.render("dashboard-messages", { threads });
});

app.get("/dashboard/messages/:id", requireClient, async (req, res) => {
  const booking = await BookingRequest.findOne({ _id: req.params.id, clientId: req.session.userId });
  if (!booking) return res.redirect("/dashboard/messages");
  const messages = await Message.find({ bookingId: booking._id }).sort({ createdAt: 1 });
  await Message.updateMany({ bookingId: booking._id, senderRole: "admin", read: false }, { read: true });

  if (req.xhr) {
    return res.render("_message-thread-panel", {
      booking, messages, myRole: "client",
      attachmentBasePath: "/dashboard/messages/attachments",
      postPath: `/dashboard/messages/${booking._id}`,
    });
  }

  const threads = await clientMessageThreads(req.session.userId);
  res.render("dashboard-messages", { threads, booking, messages });
});

app.post("/dashboard/messages/:id", requireClient, attachCrCodeForClient, (req, res, next) => {
  chatUpload.array("attachments", CHAT_MAX_ATTACHMENTS)(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    next();
  });
}, async (req, res) => {
  const body = (req.body.body || "").trim();

  const attachments = await Promise.all((req.files || []).map(async (f) => ({
    originalName: f.originalname, storedName: f.filename, size: f.size, mimetype: f.mimetype, folder: "chat",
    blurDataUrl: await generateBlurDataUrl(f.path, f.mimetype),
  })));
  const tagged = resolveTaggedAttachments(req.booking, req.body.taggedFiles, true);
  if (tagged === null) return res.status(400).json({ error: "One of those files couldn't be found." });
  attachments.push(...tagged);

  if (!body && attachments.length === 0) return res.status(400).json({ error: "Message can't be empty." });

  const message = await Message.create({
    bookingId: req.params.id,
    crCode: req.booking.crCode,
    clientId: req.booking.clientId,
    senderRole: "client",
    body,
    attachments,
  });

  io.to(chatRoom(req.params.id)).emit("new-message", message);
  res.json({ message });
});

app.post("/dashboard/messages/:id/:messageId/delete", requireClient, async (req, res) => {
  const booking = await BookingRequest.findOne({ _id: req.params.id, clientId: req.session.userId }).select("_id");
  if (!booking) return res.status(404).json({ error: "Project not found." });
  const message = await Message.findOne({ _id: req.params.messageId, bookingId: booking._id, senderRole: "client" });
  if (!message) return res.status(404).json({ error: "Message not found." });
  await softDeleteMessage(message);
  io.to(chatRoom(req.params.id)).emit("message-deleted", { messageId: message._id, bookingId: req.params.id });
  res.json({ ok: true });
});

app.get("/dashboard/messages/attachments/:filename", requireClient, async (req, res) => {
  const filename = path.basename(req.params.filename);
  const message = await Message.findOne({
    clientId: req.session.userId,
    $or: [{ "attachments.storedName": filename }, { "attachment.storedName": filename }],
  });
  if (!message) return res.sendStatus(403);
  const att = messageAttachments(message).find((a) => a.storedName === filename);
  if (!att) return res.sendStatus(404);
  const folder = att.folder || "chat";
  if (folder === "deliverables") {
    const booking = await BookingRequest.findById(message.bookingId).select("status");
    if (!booking?.deliverablesUnlocked) return res.sendStatus(403);
  }
  if (message.senderRole !== "client" && !att.downloaded) {
    att.downloaded = true;
    await message.save();
  }
  if (trySendStoredFile(res, message.crCode, folder, filename)) return;
  res.sendStatus(404);
});

// Client-side equivalent of the admin save-to-project route above.
app.post("/dashboard/messages/attachments/:filename/save-to-project", requireClient, async (req, res) => {
  const filename = path.basename(req.params.filename);
  const message = await Message.findOne({
    clientId: req.session.userId,
    $or: [{ "attachments.storedName": filename }, { "attachment.storedName": filename }],
  });
  if (!message) return res.sendStatus(403);
  const att = messageAttachments(message).find((a) => a.storedName === filename);
  if (!att) return res.sendStatus(404);
  if (att.folder && att.folder !== "chat") return res.status(400).json({ error: "Already in project files." });

  const booking = await BookingRequest.findById(message.bookingId);
  if (!booking) return res.sendStatus(404);
  if (booking.archived) return res.status(403).json({ error: "This project is archived." });

  const type = fileTypeFromMime(att.mimetype);
  if (!moveStoredFile(message.crCode, "chat", type, filename)) {
    return res.status(404).json({ error: "File not found on disk." });
  }

  booking.uploadedFiles.push({ originalName: att.originalName, storedName: att.storedName, size: att.size, mimetype: att.mimetype, blurDataUrl: att.blurDataUrl });
  await booking.save();

  att.folder = type;
  await message.save();

  res.json({ ok: true });
});

app.get("/api/notifications/poll", requireClient, async (req, res) => {
  const since = parseInt(req.query.since) || 0;
  const [unreadCount, unreadMessageCount, items, newMessages] = await Promise.all([
    Notification.countDocuments({ userId: req.session.userId, read: false }),
    Message.countDocuments({ clientId: req.session.userId, senderRole: "admin", read: false }),
    since
      ? Notification.find({ userId: req.session.userId, createdAt: { $gt: new Date(since) } }).sort({ createdAt: -1 }).lean()
      : [],
    since
      ? Message.find({ clientId: req.session.userId, senderRole: "admin", createdAt: { $gt: new Date(since) } }).sort({ createdAt: -1 }).lean()
      : [],
  ]);
  const messageItems = newMessages.map((m) => ({
    bookingId: m.bookingId,
    crCode: m.crCode,
    preview: messagePreview(m.body, messageAttachments(m)),
  }));
  res.json({ unreadCount, unreadMessageCount, items, messageItems, now: Date.now() });
});

app.post("/api/notifications/mark-read", requireClient, async (req, res) => {
  await Notification.updateMany({ userId: req.session.userId, read: false }, { read: true });
  res.json({ ok: true });
});

app.get("/dashboard/gallery", requireClient, async (req, res) => {
  const sortDir = req.query.sort === "oldest" ? 1 : -1;
  const user = await User.findById(req.session.userId).populate({
    path: "bookings",
    select: "crCode serviceType pricingTier status createdAt uploadedFiles",
    options: { sort: { createdAt: sortDir } },
  });
  if (!user) { req.session.destroy(() => res.redirect("/login")); return; }
  const projects = (user.bookings || []).filter(b => b.uploadedFiles && b.uploadedFiles.length > 0);
  res.render("dashboard-gallery", { projects, sort: req.query.sort || "newest" });
});

app.get("/dashboard/uploads/:filename", requireClient, async (req, res) => {
  const filename = path.basename(req.params.filename);
  const booking = await BookingRequest.findOne({
    clientId: req.session.userId,
    "uploadedFiles.storedName": filename,
  });
  if (!booking) return res.sendStatus(403);
  const fileInfo = booking.uploadedFiles.find(f => f.storedName === filename);
  const type = fileTypeFromMime(fileInfo.mimetype);
  if (trySendStoredFile(res, booking.crCode, type, filename)) return;
  res.sendFile(path.join(__dirname, "uploads", filename));
});

app.get("/dashboard/deliverables/:filename", requireClient, async (req, res) => {
  const filename = path.basename(req.params.filename);
  const booking = await BookingRequest.findOne({
    clientId: req.session.userId,
    "deliverableFiles.storedName": filename,
  });
  if (!booking || !booking.deliverablesUnlocked) return res.sendStatus(403);
  if (trySendStoredFile(res, booking.crCode, "deliverables", filename)) return;
  res.sendStatus(404);
});

app.get("/track/:crCode/deliverables/:filename", async (req, res) => {
  const crCode = req.params.crCode.toUpperCase().trim();
  const filename = path.basename(req.params.filename);
  const booking = await BookingRequest.findOne({ crCode, "deliverableFiles.storedName": filename });
  if (!booking || !booking.deliverablesUnlocked) return res.sendStatus(403);
  if (trySendStoredFile(res, booking.crCode, "deliverables", filename)) return;
  res.sendStatus(404);
});

// Safety net for anything upstream that calls next(err) without its own handling
// (e.g. a Multer error on a route without a bespoke wrapper) — avoids leaking a stack trace.
app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(500).send("Something went wrong. Please go back and try again.");
});

httpServer.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
