const express = require("express");
const mongoose = require("mongoose");
const dotenv = require("dotenv");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const session = require("express-session");
const BookingRequest = require("./models/BookingRequest");
const User = require("./models/User");
const Coupon = require("./models/Coupon");
const Notification = require("./models/Notification");
const { sendBookingConfirmation, sendAdminNewBookingAlert, sendAcceptanceEmail, sendAdminInvoiceAlert, sendAdminPaymentAlert } = require("./lib/mailer");

const STATUS_LABELS = {
  pending: "Pending",
  "in-review": "In Review",
  accepted: "Accepted",
  declined: "Declined",
  "in-progress": "In Progress",
  completed: "Completed",
};

dotenv.config();

const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

const app = express();
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
          let notifMsg = null;
          let paymentType = null;
          if (invoice.id === booking.depositInvoiceId) {
            booking.depositStatus = "paid";
            booking.status = "in-progress";
            notifMsg = `Deposit payment confirmed for project ${booking.crCode}. Work has begun!`;
            paymentType = "deposit";
          } else if (invoice.id === booking.finalInvoiceId) {
            booking.finalPaymentStatus = "paid";
            booking.status = "completed";
            notifMsg = `Final payment confirmed for project ${booking.crCode}. Your project is complete!`;
            paymentType = "final";
          }
          await booking.save();
          if (paymentType) {
            const paidAmount = (invoice.amount_paid / 100);
            sendAdminPaymentAlert(booking, paymentType, paidAmount);
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
app.use(session({
  secret: process.env.SESSION_SECRET || "jarumiri-dev-secret",
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000 }, // 8 hours
}));

const requireAdmin = (req, res, next) => {
  if (req.session.isAdmin) return next();
  res.redirect("/admin/login");
};

const requireClient = (req, res, next) => {
  if (req.session.userId) return next();
  res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
};

// Database
mongoose
  .connect(process.env.MONGO_URI)
  .then(() => console.log("MongoDB connected"))
  .catch((err) => console.error("MongoDB error:", err));

// File upload (multer)
function fileTypeFromMime(mimetype) {
  if (/^video\//i.test(mimetype)) return "video";
  if (/^audio\//i.test(mimetype)) return "audio";
  if (/^image\//i.test(mimetype)) return "image";
  return "other";
}

async function generateCrCode() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const rand = () => Array.from({ length: 9 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  let code, exists;
  do {
    const r = rand();
    code = `${r.slice(0, 3)}-${r.slice(3, 6)}-${r.slice(6, 9)}`;
    exists = await BookingRequest.exists({ crCode: code });
  } while (exists);
  return code;
}

async function preCrCode(req, res, next) {
  req.crCode = await generateCrCode();
  next();
}

const TIER_PRICES  = { Clip: 79, Scene: 189, Feature: 399 };
const ADDON_PRICES = { "Rush delivery": 50, "Platform cut": 30, "Captions": 35, "Censored preview": 45, "Intro/outro bumper": 75, "Extra revision": 30 };

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
  if (booking.telegramHandle) lines.push(`  Telegram: ${booking.telegramHandle}`);
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
    if (booking.couponCode && booking.discountAmount > 0) {
      lines.push(`  Coupon ${booking.couponCode}: -$${booking.discountAmount.toFixed(2)}`);
      lines.push(`  Total: $${(subtotal - booking.discountAmount).toFixed(2)}`);
    }
  }

  const dir = path.join(__dirname, "uploads", booking.crCode);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "booking.txt"), lines.join("\n"), "utf8");
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const type = fileTypeFromMime(file.mimetype);
    const dir = path.join(__dirname, "uploads", req.crCode, "files", type);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e6)}`;
    const ext = path.extname(file.originalname);
    cb(null, `${unique}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 250 * 1024 * 1024 }, // 250 MB
});

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
    }).select("crCode name serviceType pricingTier budget status createdAt");
    return res.render("track", { searched: true, method: "identity", name: name?.trim(), email: email?.trim(), booking });
  }

  const booking = await BookingRequest.findOne({ crCode: code.toUpperCase().trim() })
    .select("crCode name serviceType pricingTier budget status createdAt");
  res.render("track", { searched: true, method: "code", code: code.toUpperCase().trim(), booking });
});

app.get("/hire", async (req, res) => {
  if (!req.session.userId) return res.render("hire");
  const user = await User.findById(req.session.userId);
  const lastBooking = user?.bookings?.length
    ? await BookingRequest.findOne({ clientId: req.session.userId }).sort({ createdAt: -1 }).select("name location telegramHandle")
    : null;
  res.render("hire", {
    loggedInUser: { email: user.email },
    lastBooking,
  });
});

app.get("/hire/success", async (req, res) => {
  const { cr } = req.query;
  if (!cr) return res.redirect("/hire");
  const booking = await BookingRequest.findOne({ crCode: cr }).select("email clientId pricingTier addOns couponCode discountAmount");
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
    couponCode: booking.couponCode || null,
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

app.post("/hire", preCrCode, upload.array("files", 20), async (req, res) => {
  const { name, email, location, telegramHandle, pricingTier, budget, projectBrief } = req.body;
  const serviceType = [].concat(req.body.serviceType || []).filter(Boolean);
  const mediaLinks  = [].concat(req.body.mediaLinks  || []).filter(Boolean);
  const addOns      = [].concat(req.body.addOns      || []).filter(Boolean);

  // Server-side validation
  const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!name || !email || !emailRe.test(email) || !location || !serviceType.length || !pricingTier || !projectBrief) {
    let loggedInUser = null;
    let lastBooking = null;
    if (req.session.userId) {
      const user = await User.findById(req.session.userId);
      if (user) {
        loggedInUser = { email: user.email };
        lastBooking = user.bookings?.length
          ? await BookingRequest.findOne({ clientId: req.session.userId }).sort({ createdAt: -1 }).select("name location telegramHandle")
          : null;
      }
    }
    return res.render("hire", {
      error: "Please fill in all required fields.",
      formData: req.body,
      loggedInUser,
      lastBooking,
    });
  }

  try {
    const uploadedFiles = (req.files || []).map((f) => ({
      originalName: f.originalname,
      storedName: f.filename,
      size: f.size,
      mimetype: f.mimetype,
    }));

    // Validate coupon server-side
    const basePrice  = TIER_PRICES[pricingTier] || 0;
    const addonTotal = addOns.reduce((s, a) => s + (ADDON_PRICES[a] || 0), 0);
    const subtotal   = basePrice + addonTotal;

    let couponCode = null;
    let discountAmount = 0;
    const rawCode = (req.body.couponCode || "").trim().toUpperCase();
    if (rawCode && subtotal > 0) {
      const coupon = await Coupon.findOne({ code: rawCode, active: true });
      if (coupon && (!coupon.expiresAt || new Date() <= coupon.expiresAt)) {
        couponCode = coupon.code;
        discountAmount = coupon.discountType === "percent"
          ? Math.round(subtotal * coupon.discountValue) / 100
          : Math.min(coupon.discountValue, subtotal);
      }
    }

    const booking = new BookingRequest({
      crCode: req.crCode,
      name,
      email,
      location,
      telegramHandle,
      serviceType,
      pricingTier,
      addOns,
      budget: pricingTier === "Custom" ? budget : undefined,
      projectBrief,
      mediaLinks,
      uploadedFiles,
      couponCode,
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
      return res.redirect(`/dashboard?submitted=${booking.crCode}`);
    }

    sendBookingConfirmation(booking);
    sendAdminNewBookingAlert(booking);

    res.redirect(`/hire/success?cr=${booking.crCode}`);
  } catch (err) {
    console.error("Booking save error:", err);
    res.render("hire", {
      error: "Something went wrong saving your request. Please try again.",
      formData: req.body,
    });
  }
});

// ── Client auth routes ──
app.get("/login", (req, res) => {
  if (req.session.userId) return res.redirect("/dashboard");
  res.render("login", { next: req.query.next || "/dashboard", cr: req.query.cr || "" });
});

app.post("/login", async (req, res) => {
  const { email, password, next, cr } = req.body;
  const user = await User.findOne({ email: email?.trim().toLowerCase() });
  if (!user || !(await user.verifyPassword(password))) {
    return res.render("login", { error: "Invalid email or password.", next: next || "/dashboard", cr });
  }
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
      telegramHandle: booking.telegramHandle || "",
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
  if (req.session.userId) {
    try {
      res.locals.unreadCount = await Notification.countDocuments({ userId: req.session.userId, read: false });
    } catch {}
  }
  next();
});

app.get("/dashboard", requireClient, async (req, res) => {
  const user = await User.findById(req.session.userId).populate({
    path: "bookings",
    select: "crCode serviceType pricingTier addOns discountAmount status createdAt revisions uploadedFiles agreedPrice depositStatus finalPaymentStatus projectBrief",
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
  const { name, location, telegramHandle, accountType, externalLink } = req.body;
  if (!name?.trim() || !location?.trim()) {
    const user = await User.findById(req.session.userId);
    return res.render("dashboard-account", { user, error: "Name and location are required.", success: null });
  }
  const rawLink = (externalLink || "").trim();
  const safeLink = rawLink && !rawLink.match(/^https?:\/\//) ? "https://" + rawLink : rawLink;
  await User.findByIdAndUpdate(req.session.userId, {
    name: name.trim(),
    location: location.trim(),
    telegramHandle: (telegramHandle || "").trim(),
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
  res.render("dashboard-new", { user, profileComplete });
});

app.get("/dashboard/booking/:id", requireClient, async (req, res) => {
  const [booking, user] = await Promise.all([
    BookingRequest.findOne({ _id: req.params.id, clientId: req.session.userId }),
    User.findById(req.session.userId).select("email"),
  ]);
  if (!booking) return res.redirect("/dashboard");
  res.render("dashboard-booking", { booking, user });
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

// ── Admin routes ──
app.get("/admin/login", (req, res) => {
  if (req.session.isAdmin) return res.redirect("/admin");
  res.render("admin/login");
});

app.post("/admin/login", (req, res) => {
  if (req.body.password === process.env.ADMIN_PASSWORD) {
    req.session.isAdmin = true;
    return res.redirect("/admin");
  }
  res.render("admin/login", { error: "Incorrect password." });
});

app.get("/admin/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/admin/login"));
});

app.get("/admin", requireAdmin, async (req, res) => {
  const [bookings, total, pending] = await Promise.all([
    BookingRequest.find({ archived: { $ne: true } }).sort({ createdAt: -1 }),
    BookingRequest.countDocuments({ archived: { $ne: true } }),
    BookingRequest.countDocuments({ archived: { $ne: true }, status: "pending" }),
  ]);
  res.render("admin/dashboard", { bookings, total, pending, TIER_PRICES, ADDON_PRICES });
});

app.get("/admin/booking/:id", requireAdmin, async (req, res) => {
  const booking = await BookingRequest.findById(req.params.id);
  if (!booking) return res.redirect("/admin");
  res.render("admin/booking", { booking, stripeError: req.query.error || null });
});

app.post("/admin/booking/:id/status", requireAdmin, async (req, res) => {
  const booking = await BookingRequest.findByIdAndUpdate(
    req.params.id,
    { status: req.body.status },
    { new: true }
  );
  if (booking && booking.clientId) {
    const label = STATUS_LABELS[req.body.status] || req.body.status;
    await Notification.create({
      userId: booking.clientId,
      bookingId: booking._id,
      crCode: booking.crCode,
      type: req.body.status === "declined" ? "project_dismissed" : "status_change",
      message: req.body.status === "declined"
        ? `Project ${booking.crCode} has been declined.`
        : `Project ${booking.crCode} has moved to ${label}.`,
    });
  }
  res.redirect(`/admin/booking/${req.params.id}`);
});

app.post("/admin/booking/:id/send-deposit", requireAdmin, async (req, res) => {
  const booking = await BookingRequest.findById(req.params.id);
  if (!booking || booking.depositStatus !== "none") return res.redirect(`/admin/booking/${req.params.id}`);

  const agreedPrice = parseFloat(req.body.agreedPrice);
  if (!agreedPrice || agreedPrice <= 0) return res.redirect(`/admin/booking/${req.params.id}`);

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
      days_until_due: 7,
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
    booking.depositStatus = "pending";
    booking.status = "accepted";
    await booking.save();

    sendAcceptanceEmail(booking);
    sendAdminInvoiceAlert(booking, "deposit", agreedPrice * 0.30, finalized.hosted_invoice_url);

    if (booking.clientId) {
      await Notification.create({
        userId: booking.clientId,
        bookingId: booking._id,
        crCode: booking.crCode,
        type: "invoice_sent",
        message: `A deposit invoice ($${(agreedPrice * 0.30).toFixed(2)}) has been sent for project ${booking.crCode}. Check your email.`,
      });
    }
  } catch (err) {
    console.error("Stripe deposit invoice error:", err.message);
    return res.redirect(`/admin/booking/${req.params.id}?error=${encodeURIComponent(err.message)}`);
  }

  res.redirect(`/admin/booking/${req.params.id}`);
});

app.post("/admin/booking/:id/send-final", requireAdmin, async (req, res) => {
  const booking = await BookingRequest.findById(req.params.id);
  if (!booking || booking.depositStatus !== "paid" || booking.finalPaymentStatus !== "none") {
    return res.redirect(`/admin/booking/${req.params.id}`);
  }

  try {
    const invoice = await stripe.invoices.create({
      customer: booking.stripeCustomerId,
      collection_method: "send_invoice",
      days_until_due: 7,
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
    booking.finalPaymentStatus = "pending";
    await booking.save();

    sendAdminInvoiceAlert(booking, "final", booking.agreedPrice * 0.70, finalized.hosted_invoice_url);

    if (booking.clientId) {
      await Notification.create({
        userId: booking.clientId,
        bookingId: booking._id,
        crCode: booking.crCode,
        type: "invoice_sent",
        message: `A final invoice ($${(booking.agreedPrice * 0.70).toFixed(2)}) has been sent for project ${booking.crCode}. Check your email.`,
      });
    }
  } catch (err) {
    console.error("Stripe final invoice error:", err.message);
    return res.redirect(`/admin/booking/${req.params.id}?error=${encodeURIComponent(err.message)}`);
  }

  res.redirect(`/admin/booking/${req.params.id}`);
});

app.post("/admin/booking/:id/delete", requireAdmin, async (req, res) => {
  const booking = await BookingRequest.findById(req.params.id);
  if (booking && booking.clientId) {
    await Notification.create({
      userId: booking.clientId,
      bookingId: booking._id,
      crCode: booking.crCode,
      type: "project_dismissed",
      message: `Project ${booking.crCode} has been removed.`,
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

app.post("/admin/bookings/bulk-delete", requireAdmin, async (req, res) => {
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
        message: `Project ${b.crCode} has been removed.`,
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

app.post("/admin/booking/:id/revision/:revId/reviewed", requireAdmin, async (req, res) => {
  await BookingRequest.updateOne(
    { _id: req.params.id, "revisions._id": req.params.revId },
    { $set: { "revisions.$.status": "reviewed" } }
  );
  res.redirect(`/admin/booking/${req.params.id}`);
});

app.get("/admin/uploads/:filename", requireAdmin, async (req, res) => {
  const filename = path.basename(req.params.filename);
  const booking = await BookingRequest.findOne({ "uploadedFiles.storedName": filename });
  if (booking) {
    const fileInfo = booking.uploadedFiles.find(f => f.storedName === filename);
    const type = fileTypeFromMime(fileInfo.mimetype);
    const activePath = path.join(__dirname, "uploads", booking.crCode, "files", type, filename);
    if (fs.existsSync(activePath)) return res.sendFile(activePath);
    const archivePath = path.join(__dirname, "uploads", "_archive", booking.crCode, "files", type, filename);
    if (fs.existsSync(archivePath)) return res.sendFile(archivePath);
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

app.get("/api/notifications/poll", requireClient, async (req, res) => {
  const since = parseInt(req.query.since) || 0;
  const [unreadCount, items] = await Promise.all([
    Notification.countDocuments({ userId: req.session.userId, read: false }),
    since
      ? Notification.find({ userId: req.session.userId, createdAt: { $gt: new Date(since) } }).sort({ createdAt: -1 }).lean()
      : [],
  ]);
  res.json({ unreadCount, items, now: Date.now() });
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
  const activePath = path.join(__dirname, "uploads", booking.crCode, "files", type, filename);
  if (fs.existsSync(activePath)) return res.sendFile(activePath);
  const archivePath = path.join(__dirname, "uploads", "_archive", booking.crCode, "files", type, filename);
  if (fs.existsSync(archivePath)) return res.sendFile(archivePath);
  res.sendFile(path.join(__dirname, "uploads", filename));
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
