const path = require("path");

function fileTypeFromMime(mimetype) {
  if (/^video\//i.test(mimetype)) return "video";
  if (/^audio\//i.test(mimetype)) return "audio";
  if (/^image\//i.test(mimetype)) return "image";
  return "other";
}

function uniqueFilename(originalname) {
  const unique = `${Date.now()}-${Math.round(Math.random() * 1e6)}`;
  return `${unique}${path.extname(originalname)}`;
}

module.exports = { fileTypeFromMime, uniqueFilename };
