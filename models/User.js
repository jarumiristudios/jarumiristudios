const mongoose = require("mongoose");
const bcrypt = require("bcrypt");

const userSchema = new mongoose.Schema(
  {
    email:          { type: String, required: true, unique: true, lowercase: true, trim: true },
    password:       { type: String, required: true },
    name:           { type: String, default: "" },
    location:       { type: String, default: "" },
    telegramHandle: { type: String, default: "" },
    accountType:    { type: String, default: "" },
    externalLink:   { type: String, default: "" },
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
