const mongoose = require("mongoose");

const messageSchema = new mongoose.Schema(
  {
    bookingId: { type: mongoose.Schema.Types.ObjectId, ref: "BookingRequest", required: true, index: true },
    crCode: { type: String, required: true },
    clientId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    senderRole: { type: String, enum: ["admin", "client"], required: true },
    body: { type: String, trim: true, maxlength: 4000, default: "" },
    attachment: {
      originalName: String,
      storedName: String,
      size: Number,
      mimetype: String,
    },
    read: { type: Boolean, default: false },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Message", messageSchema);
