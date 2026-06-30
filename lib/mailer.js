const nodemailer = require("nodemailer");

let transporter;
function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      service: "gmail",
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
      <p>Thanks for reaching out to Jarumiri Studios. Your booking request has been received.</p>
      <p><strong>Your BR Code:</strong> ${booking.crCode}</p>
      <p>Hold onto this code — you'll need it to track your project's status at any time on our <a href="https://jarumiristudios.com/track">tracking page</a>.</p>
      <p>We'll review your brief and get back to you shortly.</p>
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
  return sendMail({
    to: booking.email,
    subject: `Your request has been accepted — ${booking.crCode}`,
    html: `
      <p>Hi ${booking.name},</p>
      <p>Great news — your booking request has been reviewed and accepted.</p>
      <p><strong>BR Code:</strong> ${booking.crCode}</p>
      <p>A deposit invoice (30%) has been sent to this email — pay that to kick things off. Work begins as soon as the deposit lands.</p>
      <p>You can track your project status at <a href="https://jarumiristudios.com/track">jarumiristudios.com/track</a> using your BR code.</p>
      <p>— Jarumiri Studios</p>
    `,
  });
}

function sendAdminInvoiceAlert(booking, type, amount, invoiceUrl) {
  const label = type === "deposit" ? "Deposit (30%)" : "Final Payment (70%)";
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
  const label = type === "deposit" ? "Deposit (30%)" : "Final Payment (70%)";
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

module.exports = { sendMail, sendBookingConfirmation, sendAdminNewBookingAlert, sendAcceptanceEmail, sendAdminInvoiceAlert, sendAdminPaymentAlert };
