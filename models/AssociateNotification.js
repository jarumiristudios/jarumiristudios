const mongoose = require("mongoose");

const associateNotificationSchema = new mongoose.Schema(
  {
    associateId: { type: mongoose.Schema.Types.ObjectId, ref: "Associate", required: true },
    bookingId: { type: mongoose.Schema.Types.ObjectId, ref: "BookingRequest" },
    crCode: { type: String },
    type: { type: String, enum: ["assignment", "payment", "files_added"], required: true },
    message: { type: String, required: true },
    read: { type: Boolean, default: false },
  },
  { timestamps: true }
);

module.exports = mongoose.model("AssociateNotification", associateNotificationSchema);
