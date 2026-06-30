const mongoose = require("mongoose");

const bookingRequestSchema = new mongoose.Schema(
  {
    crCode: { type: String, unique: true },
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, trim: true, lowercase: true },
    location: { type: String, required: true, trim: true },
    telegramHandle: { type: String, trim: true },
    serviceType: {
      type: [String],
      enum: ["Video Editing", "Color Grading", "Sound Design", "Motion Graphics"],
      validate: { validator: (v) => v.length > 0, message: "At least one service is required." },
    },
    pricingTier: {
      type: String,
      required: true,
      enum: ["Clip", "Scene", "Feature", "Custom"],
    },
    addOns: [{ type: String }],
    budget: { type: String, trim: true },
    projectBrief: { type: String, required: true, trim: true },
    mediaLinks: [{ type: String, trim: true }],
    uploadedFiles: [
      {
        originalName: String,
        storedName: String,
        size: Number,
        mimetype: String,
      },
    ],
    status: {
      type: String,
      enum: ["pending", "in-review", "accepted", "declined", "in-progress", "completed"],
      default: "pending",
    },
    agreedPrice: { type: Number },
    stripeCustomerId: { type: String },
    depositInvoiceId: { type: String },
    finalInvoiceId: { type: String },
    depositStatus: { type: String, enum: ["none", "pending", "paid"], default: "none" },
    finalPaymentStatus: { type: String, enum: ["none", "pending", "paid"], default: "none" },
    couponCode: { type: String },
    discountAmount: { type: Number, default: 0 },
    clientId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    revisions: [
      {
        message: { type: String, required: true, trim: true },
        createdAt: { type: Date, default: Date.now },
        status: { type: String, enum: ["pending", "reviewed"], default: "pending" },
      },
    ],
    archived: { type: Boolean, default: false },
  },
  { timestamps: true }
);

bookingRequestSchema.pre("save", async function () {
  if (this.crCode) return;
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const rand = () => Array.from({ length: 9 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  let code, exists;
  do {
    const r = rand();
    code = `${r.slice(0,3)}-${r.slice(3,6)}-${r.slice(6,9)}`;
    exists = await mongoose.model("BookingRequest").exists({ crCode: code });
  } while (exists);
  this.crCode = code;
});

module.exports = mongoose.model("BookingRequest", bookingRequestSchema);
