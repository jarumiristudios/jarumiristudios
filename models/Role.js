const mongoose = require("mongoose");

const roleSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    emoji: { type: String, trim: true },
    description: { type: String, required: true, trim: true },
    requirements: [{ type: String, trim: true }],
    active: { type: Boolean, default: true },
    order: { type: Number, default: 0 },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Role", roleSchema);
