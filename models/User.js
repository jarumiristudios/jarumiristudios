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
    externalLink:   { type: String, default: "" },
    platforms: {
      type: [{
        platform: { type: String, enum: ["Instagram", "Twitter", "TikTok", "OnlyFans", "Fansly", "Fanview", "MannyVids", "Pornhub", "Other"], required: true },
        handle:   { type: String, trim: true, required: true },
      }],
      validate: { validator: (v) => v.length <= 3, message: "Add up to 3 external links." },
      default: [],
    },
    bookings:       [{ type: mongoose.Schema.Types.ObjectId, ref: "BookingRequest" }],
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
