const nodemailer = require("nodemailer");

const PAYMENT_TYPE_LABELS = { deposit: "Deposit (30%)", final: "Final Payment (70%)", revision: "Revision Fee" };

let transporter;
function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      service: "gmail",
      // Railway containers have no outbound IPv6 route, but smtp.gmail.com resolves
      // an AAAA record too — without forcing IPv4 the connection fails with ENETUNREACH.
      family: 4,
      auth: {
        user: process.env.PERSONAL_GMAIL,
        pass: process.env.APP_PASSWORD,
      },
    });
  }
  return transporter;
}

function sendMail({ to, subject, html }) {
  return getTransporter().sendMail({
    from: process.env.MAIL_FROM,
    to,
    subject,
    html,
  }).catch((err) => console.error("Mail send error:", err));
}

function sendBookingConfirmation(booking) {
  return sendMail({
    to: booking.email,
    subject: `We've received your request — ${booking.crCode}`,
    html: `
      <p>Hi ${booking.name},</p>
      <p>Thank you for reaching out to Jarumiri Studios — we've received your booking request.</p>
      <p><strong>Your BR Code:</strong> ${booking.crCode}</p>
      <p>Please keep this code for your records. You can use it to check your project's status at any time on our <a href="https://jarumiristudios.com/track">tracking page</a>.</p>
      <p>We'll review your brief and follow up shortly.</p>
      <p>— Jarumiri Studios</p>
    `,
  });
}

function sendAdminNewBookingAlert(booking) {
  return sendMail({
    to: process.env.ADMIN_EMAIL,
    subject: `New booking request — ${booking.crCode}`,
    html: `
      <p>New booking submitted.</p>
      <ul>
        <li><strong>BR Code:</strong> ${booking.crCode}</li>
        <li><strong>Name:</strong> ${booking.name}</li>
        <li><strong>Email:</strong> ${booking.email}</li>
        <li><strong>Location:</strong> ${booking.location}</li>
        <li><strong>Service:</strong> ${booking.serviceType.join(", ")}</li>
        <li><strong>Tier:</strong> ${booking.pricingTier}</li>
      </ul>
      <p><a href="https://jarumiristudios.com/admin/booking/${booking._id}">View in admin dashboard →</a></p>
    `,
  });
}

function sendAcceptanceEmail(booking) {
  const payElsewhere = booking.clientId
    ? `your <a href="https://jarumiristudios.com/track">tracking page</a> or <a href="https://jarumiristudios.com/dashboard">account dashboard</a>`
    : `your <a href="https://jarumiristudios.com/track">tracking page</a>`;
  return sendMail({
    to: booking.email,
    subject: `Your request has been accepted — ${booking.crCode}`,
    html: `
      <p>Hi ${booking.name},</p>
      <p>We're pleased to let you know that your booking request has been reviewed and accepted.</p>
      <p><strong>BR Code:</strong> ${booking.crCode}</p>
      <p>A deposit invoice (30%) has been sent to this email address. Work will begin as soon as the deposit is received. If this email gets lost, you can also pay directly from ${payElsewhere} using your BR code — no need to wait on this invoice email.</p>
      <p>You can follow your project's status at any time at <a href="https://jarumiristudios.com/track">jarumiristudios.com/track</a> using your BR code.</p>
      <p>— Jarumiri Studios</p>
    `,
  });
}

function sendAdminInvoiceAlert(booking, type, amount, invoiceUrl) {
  const label = PAYMENT_TYPE_LABELS[type] || type;
  return sendMail({
    to: process.env.ADMIN_EMAIL,
    subject: `Invoice sent — ${booking.crCode} (${label})`,
    html: `
      <p>A Stripe invoice has been sent to the client.</p>
      <ul>
        <li><strong>Project:</strong> ${booking.crCode}</li>
        <li><strong>Client:</strong> ${booking.name} (${booking.email})</li>
        <li><strong>Type:</strong> ${label}</li>
        <li><strong>Amount:</strong> $${amount.toFixed(2)}</li>
      </ul>
      ${invoiceUrl ? `<p><a href="${invoiceUrl}">View Stripe invoice →</a></p>` : ""}
      <p><a href="https://jarumiristudios.com/admin/booking/${booking._id}">View project →</a></p>
    `,
  });
}

function sendAdminPaymentAlert(booking, type, amount) {
  const label = PAYMENT_TYPE_LABELS[type] || type;
  return sendMail({
    to: process.env.ADMIN_EMAIL,
    subject: `Payment received — ${booking.crCode} (${label})`,
    html: `
      <p>A Stripe payment has been confirmed.</p>
      <ul>
        <li><strong>Project:</strong> ${booking.crCode}</li>
        <li><strong>Client:</strong> ${booking.name} (${booking.email})</li>
        <li><strong>Type:</strong> ${label}</li>
        <li><strong>Amount:</strong> $${amount.toFixed(2)}</li>
      </ul>
      <p><a href="https://jarumiristudios.com/admin/booking/${booking._id}">View project →</a></p>
    `,
  });
}

function sendAdminPauseAlert(booking) {
  return sendMail({
    to: process.env.ADMIN_EMAIL,
    subject: `Client paused project — ${booking.crCode}`,
    html: `
      <p>A client has put their project on hold.</p>
      <ul>
        <li><strong>Project:</strong> ${booking.crCode}</li>
        <li><strong>Client:</strong> ${booking.name} (${booking.email})</li>
      </ul>
      <p><a href="https://jarumiristudios.com/admin/booking/${booking._id}">View project →</a></p>
    `,
  });
}

function sendDepositExpiredEmail(booking) {
  return sendMail({
    to: booking.email,
    subject: `Your project has been put on hold — ${booking.crCode}`,
    html: `
      <p>Hi ${booking.name},</p>
      <p>The deposit deadline for your project (<strong>${booking.crCode}</strong>) has passed without payment, so we've placed it on hold.</p>
      <p>We'd be glad to revisit this project — or take on a future one — whenever you're ready. Please don't hesitate to get in touch.</p>
      <p>— Jarumiri Studios</p>
    `,
  });
}

function sendAdminDepositExpiredAlert(booking) {
  return sendMail({
    to: process.env.ADMIN_EMAIL,
    subject: `Auto-declined (unpaid deposit) — ${booking.crCode}`,
    html: `
      <p>A project was automatically declined because its deposit due date passed without payment.</p>
      <ul>
        <li><strong>BR Code:</strong> ${booking.crCode}</li>
        <li><strong>Client:</strong> ${booking.name} (${booking.email})</li>
      </ul>
      <p><a href="https://jarumiristudios.com/admin/booking/${booking._id}">View project →</a></p>
    `,
  });
}

function sendFinalExpiredEmail(booking) {
  return sendMail({
    to: booking.email,
    subject: `Your final payment link has expired — ${booking.crCode}`,
    html: `
      <p>Hi ${booking.name},</p>
      <p>The due date for your final payment on project <strong>${booking.crCode}</strong> has passed, so we've voided that invoice link for security.</p>
      <p>No action needed right now — reach out whenever you're ready and we'll send a fresh payment link.</p>
      <p>— Jarumiri Studios</p>
    `,
  });
}

function sendAdminFinalExpiredAlert(booking) {
  return sendMail({
    to: process.env.ADMIN_EMAIL,
    subject: `Final invoice expired (unpaid) — ${booking.crCode}`,
    html: `
      <p>A final payment invoice was voided because its due date passed without payment.</p>
      <ul>
        <li><strong>BR Code:</strong> ${booking.crCode}</li>
        <li><strong>Client:</strong> ${booking.name} (${booking.email})</li>
      </ul>
      <p>Final payment status has been reset so a new invoice can be sent when ready.</p>
      <p><a href="https://jarumiristudios.com/admin/booking/${booking._id}">View project →</a></p>
    `,
  });
}

function sendDepositReminderEmail(booking) {
  const payElsewhere = booking.clientId
    ? `your <a href="https://jarumiristudios.com/track">tracking page</a> or <a href="https://jarumiristudios.com/dashboard">account dashboard</a>`
    : `your <a href="https://jarumiristudios.com/track">tracking page</a>`;
  const dueDateStr = booking.depositDueDate.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
  return sendMail({
    to: booking.email,
    subject: `Reminder: deposit due tomorrow — ${booking.crCode}`,
    html: `
      <p>Hi ${booking.name},</p>
      <p>Just a reminder that the deposit for your project (<strong>${booking.crCode}</strong>) is due by <strong>${dueDateStr}</strong>. If it passes unpaid, the project will be put on hold.</p>
      <p>You can pay from ${payElsewhere} using your BR code if you can't find the original invoice email.</p>
      <p>— Jarumiri Studios</p>
    `,
  });
}

function sendFinalReminderEmail(booking) {
  const payElsewhere = booking.clientId
    ? `your <a href="https://jarumiristudios.com/track">tracking page</a> or <a href="https://jarumiristudios.com/dashboard">account dashboard</a>`
    : `your <a href="https://jarumiristudios.com/track">tracking page</a>`;
  const dueDateStr = booking.finalDueDate.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
  return sendMail({
    to: booking.email,
    subject: `Reminder: final payment due tomorrow — ${booking.crCode}`,
    html: `
      <p>Hi ${booking.name},</p>
      <p>Just a reminder that the final payment for your project (<strong>${booking.crCode}</strong>) is due by <strong>${dueDateStr}</strong>. If it passes unpaid, the payment link will be voided.</p>
      <p>You can pay from ${payElsewhere} using your BR code if you can't find the original invoice email.</p>
      <p>— Jarumiri Studios</p>
    `,
  });
}

function sendPasswordResetEmail(user, rawToken) {
  return sendMail({
    to: user.email,
    subject: "Reset your password — Jarumiri Studios",
    html: `
      <p>Hi${user.name ? " " + user.name : ""},</p>
      <p>We received a request to reset your Jarumiri Studios account password. Click below to choose a new one — this link expires in 1 hour.</p>
      <p><a href="https://jarumiristudios.com/reset-password/${rawToken}">Reset your password →</a></p>
      <p>If you didn't request this, you can safely ignore this email — your password won't be changed.</p>
      <p>— Jarumiri Studios</p>
    `,
  });
}

function sendAdminUnexpectedPaymentAlert(booking, type, amount) {
  const label = PAYMENT_TYPE_LABELS[type] || type;
  const stateLabel = booking.archived ? "archived" : booking.status;
  return sendMail({
    to: process.env.ADMIN_EMAIL,
    subject: `⚠ Payment received on inactive project — ${booking.crCode}`,
    html: `
      <p>A Stripe payment came in for a project that is currently <strong>${stateLabel}</strong> — it was not auto-progressed. Please review manually.</p>
      <ul>
        <li><strong>Project:</strong> ${booking.crCode}</li>
        <li><strong>Client:</strong> ${booking.name} (${booking.email})</li>
        <li><strong>Type:</strong> ${label}</li>
        <li><strong>Amount:</strong> $${amount.toFixed(2)}</li>
      </ul>
      <p><a href="https://jarumiristudios.com/admin/booking/${booking._id}">View project →</a></p>
    `,
  });
}

module.exports = { sendMail, sendBookingConfirmation, sendAdminNewBookingAlert, sendAcceptanceEmail, sendAdminInvoiceAlert, sendAdminPaymentAlert, sendAdminPauseAlert, sendDepositExpiredEmail, sendAdminDepositExpiredAlert, sendFinalExpiredEmail, sendAdminFinalExpiredAlert, sendDepositReminderEmail, sendFinalReminderEmail, sendAdminUnexpectedPaymentAlert, sendPasswordResetEmail };
