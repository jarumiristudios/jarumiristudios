// Custom multer storage engine writing straight to R2 instead of local disk. R2 keys are flat
// (`<crCode>/<storedName>`) — folder/category is a Mongo metadata field, never encoded in the
// key, so promoting a file between folders (e.g. chat -> project files) is a pure DB update
// with no object-storage operation.
//
// Images are buffered in memory (small, and the same buffer feeds sharp() for the blur preview
// in the upload-completion handlers). Everything else streams directly into R2 via a byte-counting
// PassThrough, never touching local disk or fully buffering in RAM — avoids the OOM risk plain
// multer.memoryStorage() would carry at this app's existing 20-file/250MB upload caps.
const { PassThrough } = require("stream");
const { putObject, streamUpload, deleteObject } = require("./r2");
const { uniqueFilename } = require("./uploadUtils");

function createR2Storage(getPrefix = (req) => req.crCode) {
  return {
    _handleFile(req, file, cb) {
      const storedName = uniqueFilename(file.originalname);
      const storageKey = `${getPrefix(req)}/${storedName}`;
      const isImage = /^image\//i.test(file.mimetype);

      if (isImage) {
        const chunks = [];
        file.stream.on("error", cb);
        file.stream.on("data", (chunk) => chunks.push(chunk));
        file.stream.on("end", async () => {
          const buffer = Buffer.concat(chunks);
          try {
            await putObject(storageKey, buffer, file.mimetype);
            cb(null, { filename: storedName, storedName, storageKey, backend: "r2", size: buffer.length, buffer });
          } catch (err) {
            cb(err);
          }
        });
        return;
      }

      let size = 0;
      const counter = new PassThrough();
      file.stream.on("error", cb);
      file.stream.on("data", (chunk) => { size += chunk.length; });
      file.stream.pipe(counter);
      streamUpload(storageKey, counter, file.mimetype)
        .then(() => cb(null, { filename: storedName, storedName, storageKey, backend: "r2", size }))
        .catch(cb);
    },

    _removeFile(req, file, cb) {
      deleteObject(file.storageKey).then(() => cb(null)).catch(cb);
    },
  };
}

module.exports = { createR2Storage };
