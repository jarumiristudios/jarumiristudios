// Shared subdocument shape for every place a file's metadata is stored (BookingRequest's
// uploadedFiles/deliverableFiles, Message's attachment/attachments) — one place to add a
// field (e.g. storageKey/backend for the R2 migration) instead of three.
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
  // Tiny base64 blurred preview (images only).
  blurDataUrl: String,
};
