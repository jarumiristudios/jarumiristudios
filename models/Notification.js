const mongoose = require("mongoose");

const notificationSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    bookingId: { type: mongoose.Schema.Types.ObjectId, ref: "BookingRequest" },
    crCode: { type: String },
    type: {
      type: String,
      enum: ["status_change", "invoice_sent", "payment_confirmed", "project_dismissed", "invoice_expired", "due_date_updated", "due_date_reminder", "deliverable_ready"],
      required: true,
    },
    message: { type: String, required: true },
    read: { type: Boolean, default: false },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Notification", notificationSchema);
