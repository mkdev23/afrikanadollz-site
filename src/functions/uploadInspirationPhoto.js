// POST /api/upload-inspiration-photo -- accepts a customer-supplied "inspiration photo" (a picture of
// a hairstyle they want) from book.html's optional photo field on the contact-info step, uploads it to
// a dedicated private blob container, and returns a read-only URL. That URL is then submitted back as
// `inspirationPhotoUrl` on the subsequent POST /api/book call (see src/functions/book.js), exactly like
// any other booking-form field -- this endpoint is deliberately NOT tied to an appointment id, since
// the photo is uploaded before the appointment exists (upload first, get a URL, book with the URL).
//
// Request shape: same base64 data-URL convention as src/functions/styleSuggest.js
// (`{ imageDataUrl: "data:image/...;base64,..." }`) rather than multipart/form-data -- nothing else in
// this codebase parses multipart bodies, so this keeps every /api/* endpoint on the same JSON-only
// style instead of introducing a one-off request format. Trade-off: base64 inflates the wire size by
// ~33%, which is why the size cap below is checked against the estimated RAW byte count, not the
// encoded string length.
//
// UNLIKE styleSuggest.js, this endpoint DOES persist the image: to a dedicated 'inspiration-photos'
// blob container added on the SAME storage account the Functions runtime already uses for
// AzureWebJobsStorage (see infra/main.bicep) -- a separate container, not the runtime's own internal
// one, per the task's explicit instruction. The storage account has allowBlobPublicAccess: false at
// the account level (infra/main.bicep), which means this container can never be made publicly
// readable -- viewing the photo (customer's own upload preview, or Diaka's view in admin.html) requires
// a SAS-signed URL. That URL is generated ONCE here, at upload time, with a long (see
// SAS_VALIDITY_DAYS) expiry rather than re-signed on every read, since nothing else in this codebase
// re-signs URLs on the fly and re-signing would need its own authenticated endpoint. See the task
// report for the blob-retention/cleanup consideration this implies -- these blobs are not
// automatically deleted.
//
// Security: the client-supplied `data:image/xxx;base64,...` MIME claim is NOT trusted on its own --
// after decoding, the actual bytes are sniffed for real image magic-byte signatures
// (detectImageType()) and the upload is rejected if they don't match a supported format, regardless of
// what the data URL claimed. The blob name is always server-generated via crypto.randomBytes, never
// derived from any client-supplied filename.
'use strict';

const crypto = require('crypto');
const { app } = require('@azure/functions');
const { Pool } = require('pg');
const { BlobServiceClient, BlobSASPermissions } = require('@azure/storage-blob');
const { getClientIp, enforceRateLimit, rateLimitResponse } = require('../../lib/rateLimit');

let pool;
function getPool() {
  if (!pool) pool = new Pool({ connectionString: process.env.DATABASE_URL });
  return pool;
}

// Raw image bytes, not the base64 text length -- same 8MB cap/reasoning as src/functions/styleSuggest.js.
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const DATA_URL_RE = /^data:image\/[a-zA-Z0-9.+-]+;base64,([A-Za-z0-9+/]+=*)$/;
const DEFAULT_CONTAINER = 'inspiration-photos';

// Same reasoning as src/functions/styleSuggest.js's STYLE_SUGGEST_RATE_LIMIT: a pre-account, anonymous
// flow with only IP to key on, so this is a blunt cost/abuse backstop (blob storage + bandwidth, and
// an unbounded flood could fill the container) rather than a precise per-user cap. Same 15/15-minute
// threshold for the same "covers a real customer's retries, bounds a single source's damage" reasoning.
const UPLOAD_PHOTO_RATE_LIMIT = { bucket: 'upload_inspiration_photo', windowMs: 15 * 60 * 1000, maxAttempts: 15 };
// How long the generated read URL stays valid. NOT a retention/cleanup policy for the underlying blob
// (the blob itself is kept indefinitely until someone deletes it) -- just the lifetime of the SAS
// query-string signature granting read access to it. See the task report for the flagged operational
// follow-up (a lifecycle policy or manual cleanup for the blobs themselves).
const SAS_VALIDITY_DAYS = 365;

let containerClient;
function getContainerClient() {
  if (!containerClient) {
    const conn = process.env.INSPIRATION_PHOTOS_CONNECTION_STRING;
    if (!conn) throw new Error('INSPIRATION_PHOTOS_CONNECTION_STRING is not configured');
    const containerName = process.env.INSPIRATION_PHOTOS_CONTAINER || DEFAULT_CONTAINER;
    const blobServiceClient = BlobServiceClient.fromConnectionString(conn);
    containerClient = blobServiceClient.getContainerClient(containerName);
  }
  return containerClient;
}

// Exposed for tests: reset the memoized client so a differently-mocked env/module can be exercised.
function _resetContainerClientForTests() {
  containerClient = undefined;
}

// Sniffs real magic bytes rather than trusting the client's data:image/xxx;base64 MIME claim. Returns
// {ext, contentType} for a supported format, or null if the bytes don't match any of them.
function detectImageType(buf) {
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
    buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
  ) {
    return { ext: 'png', contentType: 'image/png' };
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { ext: 'jpg', contentType: 'image/jpeg' };
  }
  if (
    buf.length >= 6 &&
    buf.toString('ascii', 0, 3) === 'GIF' &&
    (buf.toString('ascii', 3, 6) === '87a' || buf.toString('ascii', 3, 6) === '89a')
  ) {
    return { ext: 'gif', contentType: 'image/gif' };
  }
  if (
    buf.length >= 12 &&
    buf.toString('ascii', 0, 4) === 'RIFF' &&
    buf.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return { ext: 'webp', contentType: 'image/webp' };
  }
  return null;
}

function validateBody(body) {
  const errors = [];
  if (!body || typeof body !== 'object') return ['Request body must be JSON'];

  if (!body.imageDataUrl || typeof body.imageDataUrl !== 'string') {
    errors.push('imageDataUrl is required and must be a data:image/...;base64,... URL');
  } else {
    const match = DATA_URL_RE.exec(body.imageDataUrl);
    if (!match) {
      errors.push('imageDataUrl must look like data:image/<type>;base64,<data>');
    } else {
      const approxRawBytes = Math.floor((match[1].length * 3) / 4);
      if (approxRawBytes > MAX_IMAGE_BYTES) {
        errors.push(
          `imageDataUrl is too large (~${Math.round(approxRawBytes / 1024 / 1024)}MB) -- max ${MAX_IMAGE_BYTES / 1024 / 1024}MB`
        );
      }
    }
  }
  return errors;
}

async function uploadInspirationPhotoHandler(request, context) {
  let body;
  try {
    body = await request.json();
  } catch {
    body = null;
  }

  const errors = validateBody(body);
  if (errors.length) {
    return { status: 400, jsonBody: { error: 'Invalid request', details: errors } };
  }

  const ip = getClientIp(request);
  const blocked = await enforceRateLimit(getPool(), [
    { bucket: UPLOAD_PHOTO_RATE_LIMIT.bucket, identifier: `ip:${ip}`, windowMs: UPLOAD_PHOTO_RATE_LIMIT.windowMs, maxAttempts: UPLOAD_PHOTO_RATE_LIMIT.maxAttempts },
  ]);
  if (blocked) {
    return rateLimitResponse(blocked, 'Too many photo uploads. Please try again shortly.');
  }

  const match = DATA_URL_RE.exec(body.imageDataUrl);
  const buffer = Buffer.from(match[1], 'base64');

  if (buffer.length === 0 || buffer.length > MAX_IMAGE_BYTES) {
    return { status: 400, jsonBody: { error: `Image is too large -- max ${MAX_IMAGE_BYTES / 1024 / 1024}MB` } };
  }

  const detected = detectImageType(buffer);
  if (!detected) {
    return {
      status: 400,
      jsonBody: { error: 'That file does not look like a supported image (PNG, JPEG, GIF, or WEBP).' },
    };
  }

  try {
    const container = getContainerClient();
    const blobName = `${crypto.randomBytes(16).toString('hex')}.${detected.ext}`;
    const blockBlobClient = container.getBlockBlobClient(blobName);

    await blockBlobClient.uploadData(buffer, {
      blobHTTPHeaders: { blobContentType: detected.contentType },
    });

    // The container has public access disabled (infra/main.bicep) -- a read-only, time-limited SAS URL
    // is what actually makes the photo viewable. This works because BlobServiceClient.fromConnectionString()
    // above parsed a shared-key credential out of the connection string.
    const url = await blockBlobClient.generateSasUrl({
      permissions: BlobSASPermissions.parse('r'),
      expiresOn: new Date(Date.now() + SAS_VALIDITY_DAYS * 24 * 60 * 60 * 1000),
    });

    return { status: 201, jsonBody: { url } };
  } catch (err) {
    context.error('POST /api/upload-inspiration-photo failed:', err && err.message);
    return {
      status: 502,
      jsonBody: { error: 'Photo upload is unavailable right now. Please try again, or continue without a photo.' },
    };
  }
}

app.http('uploadInspirationPhoto', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'upload-inspiration-photo',
  handler: uploadInspirationPhotoHandler,
});

module.exports = {
  uploadInspirationPhotoHandler,
  validateBody,
  detectImageType,
  MAX_IMAGE_BYTES,
  UPLOAD_PHOTO_RATE_LIMIT,
  _resetContainerClientForTests,
};
