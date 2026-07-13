const mongoose = require("mongoose");
const bcrypt = require("bcrypt");

const userSchema = new mongoose.Schema(
  {
    email:          { type: String, required: true, unique: true, lowercase: true, trim: true },
    password:       { type: String, required: true },
    name:           { type: String, default: "" },
    location:       { type: String, default: "" },
    clientType: {
      type: String,
      default: "",
      enum: ["", "Independent Creator", "Agency", "Studio", "Brand / Business", "Other"],
    },
    platforms: {
      type: [{
        platform: { type: String, enum: ["Instagram", "Twitter", "TikTok", "OnlyFans", "Fansly", "Fanview", "MannyVids", "Pornhub", "Other"], required: true },
        handle:   { type: String, trim: true, required: true },
      }],
      validate: { validator: (v) => v.length <= 3, message: "Add up to 3 external links." },
      default: [],
    },
    bookings:       [{ type: mongoose.Schema.Types.ObjectId, ref: "BookingRequest" }],
    discountPercent:      { type: Number, default: null },
    discountExpiresAt:    { type: Date, default: null },
    discountUsed:         { type: Boolean, default: false },
    discountReminderSent: { type: Boolean, default: false },
    // Set when a Free-tier booking completes; cleared once the client submits a testimonial
    // or grants gallery rights for that same booking. Blocks further Free-tier submissions
    // while outstanding — only one can ever be pending at a time by construction.
    pendingTestimonialObligation: { type: Boolean, default: false },
    pendingTestimonialBookingId:  { type: mongoose.Schema.Types.ObjectId, ref: "BookingRequest", default: null },
    notificationPreferences: {
      emailUpdates: { type: Boolean, default: true },
    },
  },
  { timestamps: true }
);

userSchema.pre("save", async function () {
  if (!this.isModified("password")) return;
  this.password = await bcrypt.hash(this.password, 12);
});

userSchema.methods.verifyPassword = function (plain) {
  return bcrypt.compare(plain, this.password);
};

module.exports = mongoose.model("User", userSchema);
