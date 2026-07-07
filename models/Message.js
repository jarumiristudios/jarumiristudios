const mongoose = require("mongoose");

const attachmentFields = {
  originalName: String,
  storedName: String,
  size: Number,
  mimetype: String,
  // Which uploads/<crCode>/files/<folder>/ subfolder the file physically lives in —
  // "chat" for a fresh composer upload, or the source array's own storage type
  // ("video"/"audio"/"image"/"other"/"deliverables") when tagging an existing project file.
  folder: String,
  // Tiny base64 blurred preview (images only) shown behind the download prompt for
  // not-yet-downloaded attachments, so the receiver sees a hint of the image without
  // the full file being fetched.
  blurDataUrl: String,
  // Set once the non-sending party has actually fetched the file (see the attachment-serving
  // GET routes), so a re-render (page reload, new socket push) doesn't re-hide a file the
  // receiver already chose to download.
  downloaded: { type: Boolean, default: false },
};

const messageSchema = new mongoose.Schema(
  {
    bookingId: { type: mongoose.Schema.Types.ObjectId, ref: "BookingRequest", required: true, index: true },
    crCode: { type: String, required: true },
    clientId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    senderRole: { type: String, enum: ["admin", "client"], required: true },
    body: { type: String, trim: true, maxlength: 4000, default: "" },
    // Legacy single-attachment shape, kept so messages sent before multi-attachment
    // support still render — new messages are always written to `attachments` below.
    attachment: attachmentFields,
    attachments: [attachmentFields],
    read: { type: Boolean, default: false },
    deleted: { type: Boolean, default: false },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Message", messageSchema);
