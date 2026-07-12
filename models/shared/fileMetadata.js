// Shared subdocument shape for every place a file's metadata is stored (BookingRequest's
// uploadedFiles/deliverableFiles, Message's attachment/attachments) — one place to add a
// field (e.g. storageKey/backend for the R2 migration) instead of three.
const mongoose = require("mongoose");

module.exports = {
  originalName: String,
  storedName: String,
  size: Number,
  mimetype: String,
  // Which uploads/<crCode>/files/<folder>/ subfolder (local backend) or logical category
  // (R2 backend, key itself is flat) the file belongs to — "video"/"audio"/"image"/"other"/
  // "deliverables"/"chat".
  folder: String,
  // Full object key once uploaded to R2 (e.g. "<crCode>/<storedName>"). Unset for files
  // still on the local `backend`.
  storageKey: String,
  // Which storage backend actually holds the bytes for this file — drives read-path branching
  // during the phased R2 migration. Defaults to "local" so existing documents need no backfill.
  backend: { type: String, enum: ["local", "r2"], default: "local" },
  // Only meaningful for deliverableFiles, where both the shared admin login and any associate
  // can upload through the same route — which specific associate uploaded this one, or null
  // for the shared admin login. Chat attachments get their uploader from the parent Message's
  // senderRole/senderAssociateId instead, since every attachment already has one.
  uploadedByAssociateId: { type: mongoose.Schema.Types.ObjectId, ref: "Associate", default: null },
  // Tiny base64 blurred preview (images only).
  blurDataUrl: String,
};
