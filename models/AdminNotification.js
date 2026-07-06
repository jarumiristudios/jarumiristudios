const mongoose = require("mongoose");

const adminNotificationSchema = new mongoose.Schema(
  {
    bookingId: { type: mongoose.Schema.Types.ObjectId, ref: "BookingRequest" },
    crCode: { type: String },
    type: { type: String, enum: ["nudge", "payment", "new_booking"], required: true },
    message: { type: String, required: true },
    read: { type: Boolean, default: false },
  },
  { timestamps: true }
);

module.exports = mongoose.model("AdminNotification", adminNotificationSchema);
