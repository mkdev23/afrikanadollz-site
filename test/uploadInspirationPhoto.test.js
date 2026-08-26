// Unit tests for src/functions/uploadInspirationPhoto.js -- request validation (data-URL shape, byte
// cap), real magic-byte image sniffing (detectImageType), and an end-to-end handler test with
// @azure/storage-blob's BlobServiceClient mocked out via require-cache substitution -- same
// "mocked SDK/network, real everything else" approach test/styleSuggest.test.js uses for lib/openai.js
// and test/adminApi.test.js uses for `pg`. `pg` is now mocked here too (same reasoning as
// test/styleSuggest.test.js): this handler is rate-limited (lib/rateLimit.js, see
// UPLOAD_PHOTO_RATE_LIMIT) since an unbounded flood could fill the blob container.
//
// Run with: node test/uploadInspirationPhoto.test.js
'use strict';

const assert = require('assert');
const Module = require('module');
const path = require('path');

const HANDLER_PATH = path.join(__dirname, '..', 'src', 'functions', 'uploadInspirationPhoto.js');
const STORAGE_BLOB_PATH = require.resolve('@azure/storage-blob');
const PG_PATH = require.resolve('pg');

// A real (tiny) in-memory sliding window backs rate_limit_events here, same approach as
// test/styleSuggest.test.js/test/adminApi.test.js/test/rateLimit.test.js, so a test that calls the
// handler more times than UPLOAD_PHOTO_RATE_LIMIT.maxAttempts allows genuinely observes a 429.
function makeFakePgModule() {
  const rateLimitEvents = [];
  class FakePool {
    constructor() {}
    async query(sql, params) {
      if (/^SELECT COUNT\(\*\)::int AS count FROM rate_limit_events/.test(sql)) {
        const [bucket, identifier, windowMs] = params;
        const cutoff = Date.now() - windowMs;
        const count = rateLimitEvents.filter((e) => e.bucket === bucket && e.identifier === identifier && e.createdAt > cutoff).length;
        return { rows: [{ count }] };
      }
      if (/^INSERT INTO rate_limit_events/.test(sql)) {
        const [bucket, identifier] = params;
        rateLimitEvents.push({ bucket, identifier, createdAt: Date.now() });
        return { rows: [] };
      }
      throw new Error(`unexpected query in uploadInspirationPhoto test: ${sql}`);
    }
  }
  const fakeModule = new Module(PG_PATH);
  fakeModule.exports = { Pool: FakePool };
  fakeModule.loaded = true;
  return fakeModule;
}

// A real (tiny, valid) 1x1 PNG -- same fixture test/styleSuggest.test.js uses, so this also exercises
// the "actually decodes to real image bytes" path, not just a MIME-claim string.
const SMALL_PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

// A JPEG magic-byte prefix (FF D8 FF) followed by junk -- detectImageType() only looks at the first
// few bytes, so this is enough to be recognized as "a JPEG" without needing a fully valid file.
const JPEG_BYTES = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('junkjunkjunk')]);
const JPEG_DATA_URL = `data:image/jpeg;base64,${JPEG_BYTES.toString('base64')}`;

// Claims to be a PNG in the data-URL MIME prefix, but the actual bytes are plain text -- this is the
// "don't trust the client-supplied content-type" case: real magic-byte sniffing must reject it even
// though the prefix says image/png.
const FAKE_PNG_DATA_URL = `data:image/png;base64,${Buffer.from('this is not actually a png, just text').toString('base64')}`;

function loadHandlerWithMockedBlob(mocks) {
  delete require.cache[HANDLER_PATH];
  delete require.cache[STORAGE_BLOB_PATH];
  delete require.cache[PG_PATH];
  require.cache[PG_PATH] = makeFakePgModule();

  const uploadDataCalls = [];
  const generateSasUrlCalls = [];
  const getBlockBlobClientCalls = [];

  const fakeBlockBlobClient = {
    uploadData: async (buffer, opts) => {
      uploadDataCalls.push({ buffer, opts });
      if (mocks && mocks.uploadDataThrows) throw mocks.uploadDataThrows;
      return {};
    },
    generateSasUrl: async (opts) => {
      generateSasUrlCalls.push(opts);
      if (mocks && mocks.generateSasUrlThrows) throw mocks.generateSasUrlThrows;
      return (mocks && mocks.sasUrl) || 'https://mockaccount.blob.core.windows.net/inspiration-photos/mocked.png?sv=mock-sas';
    },
  };
  const fakeContainerClient = {
    getBlockBlobClient: (blobName) => {
      getBlockBlobClientCalls.push(blobName);
      return fakeBlockBlobClient;
    },
  };
  const fakeBlobServiceClient = {
    getContainerClient: () => fakeContainerClient,
  };

  const fakeModule = new Module(STORAGE_BLOB_PATH);
  fakeModule.exports = {
    BlobServiceClient: { fromConnectionString: () => fakeBlobServiceClient },
    BlobSASPermissions: { parse: (s) => ({ toString: () => s }) },
  };
  fakeModule.loaded = true;
  require.cache[STORAGE_BLOB_PATH] = fakeModule;

  const mod = require(HANDLER_PATH);
  delete require.cache[STORAGE_BLOB_PATH];
  delete require.cache[HANDLER_PATH];
  delete require.cache[PG_PATH];
  mod._resetContainerClientForTests();

  return { mod, uploadDataCalls, generateSasUrlCalls, getBlockBlobClientCalls };
}

function fakeRequest(body, ip) {
  return {
    json: async () => body,
    headers: { get: (name) => (name.toLowerCase() === 'x-forwarded-for' ? ip || null : null) },
  };
}
function fakeContext() {
  const errors = [];
  return { error: (...args) => errors.push(args), errors };
}

async function run() {
  let passed = 0;
  const test = async (name, fn) => {
    try {
      await fn();
      passed++;
      console.log(`ok - ${name}`);
    } catch (err) {
      console.error(`FAIL - ${name}`);
      console.error(err);
      process.exitCode = 1;
    }
  };

  process.env.INSPIRATION_PHOTOS_CONNECTION_STRING = 'UseDevelopmentStorage=true';
  process.env.INSPIRATION_PHOTOS_CONTAINER = 'inspiration-photos';

  const { mod: pureMod } = loadHandlerWithMockedBlob();
  const { validateBody, detectImageType, MAX_IMAGE_BYTES } = pureMod;

  // ---------------- validateBody ----------------

  await test('validateBody accepts a well-formed request', () => {
    const errors = validateBody({ imageDataUrl: SMALL_PNG_DATA_URL });
    assert.deepStrictEqual(errors, []);
  });

  await test('validateBody rejects a missing imageDataUrl', () => {
    const errors = validateBody({});
    assert.ok(errors.some((e) => /imageDataUrl/.test(e)));
  });

  await test('validateBody rejects a non-data-URL imageDataUrl', () => {
    const errors = validateBody({ imageDataUrl: 'https://example.com/photo.jpg' });
    assert.ok(errors.some((e) => /data:image/.test(e)));
  });

  await test('validateBody rejects an oversized image (over the byte limit)', () => {
    const neededChars = Math.ceil((MAX_IMAGE_BYTES + 1024) / 3) * 4;
    const oversizedBase64 = 'A'.repeat(neededChars);
    const errors = validateBody({ imageDataUrl: `data:image/png;base64,${oversizedBase64}` });
    assert.ok(errors.some((e) => /too large/.test(e)), `expected a "too large" error, got: ${JSON.stringify(errors)}`);
  });

  // ---------------- detectImageType (real magic-byte sniffing) ----------------

  await test('detectImageType recognizes a real PNG', () => {
    const buf = Buffer.from(SMALL_PNG_DATA_URL.split(',')[1], 'base64');
    assert.deepStrictEqual(detectImageType(buf), { ext: 'png', contentType: 'image/png' });
  });

  await test('detectImageType recognizes a real JPEG magic-byte prefix', () => {
    assert.deepStrictEqual(detectImageType(JPEG_BYTES), { ext: 'jpg', contentType: 'image/jpeg' });
  });

  await test('detectImageType recognizes GIF and WEBP signatures', () => {
    const gif = Buffer.concat([Buffer.from('GIF89a'), Buffer.from([0, 0, 0, 0])]);
    assert.strictEqual(detectImageType(gif).ext, 'gif');
    const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBP')]);
    assert.strictEqual(detectImageType(webp).ext, 'webp');
  });

  await test('detectImageType returns null for non-image bytes, regardless of a claimed MIME type', () => {
    assert.strictEqual(detectImageType(Buffer.from('this is not actually a png, just text')), null);
  });

  // ---------------- handler (mocked @azure/storage-blob) ----------------

  await test('handler returns 400 with details when validation fails', async () => {
    const { mod } = loadHandlerWithMockedBlob();
    const res = await mod.uploadInspirationPhotoHandler(fakeRequest({}), fakeContext());
    assert.strictEqual(res.status, 400);
    assert.ok(Array.isArray(res.jsonBody.details));
  });

  await test('handler rejects a data URL whose bytes are not a real image, even with an image/png prefix', async () => {
    const { mod, getBlockBlobClientCalls } = loadHandlerWithMockedBlob();
    const res = await mod.uploadInspirationPhotoHandler(fakeRequest({ imageDataUrl: FAKE_PNG_DATA_URL }), fakeContext());
    assert.strictEqual(res.status, 400);
    assert.ok(/does not look like a supported image/.test(res.jsonBody.error));
    assert.strictEqual(getBlockBlobClientCalls.length, 0, 'should never reach the blob client for fake image bytes');
  });

  await test('handler returns 201 + a url on success, uploads with the sniffed content-type, and picks a random .png blob name', async () => {
    const { mod, uploadDataCalls, getBlockBlobClientCalls, generateSasUrlCalls } = loadHandlerWithMockedBlob({
      sasUrl: 'https://mockaccount.blob.core.windows.net/inspiration-photos/abc123.png?sv=mock-sas',
    });
    const res = await mod.uploadInspirationPhotoHandler(fakeRequest({ imageDataUrl: SMALL_PNG_DATA_URL }), fakeContext());
    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.jsonBody.url, 'https://mockaccount.blob.core.windows.net/inspiration-photos/abc123.png?sv=mock-sas');
    assert.strictEqual(uploadDataCalls.length, 1);
    assert.strictEqual(uploadDataCalls[0].opts.blobHTTPHeaders.blobContentType, 'image/png');
    assert.strictEqual(getBlockBlobClientCalls.length, 1);
    assert.ok(/^[0-9a-f]{32}\.png$/.test(getBlockBlobClientCalls[0]), `expected a random hex blob name, got: ${getBlockBlobClientCalls[0]}`);
    assert.strictEqual(generateSasUrlCalls.length, 1);
    assert.ok(generateSasUrlCalls[0].expiresOn instanceof Date);
  });

  await test('handler generates a different random blob name on each call', async () => {
    const { mod, getBlockBlobClientCalls } = loadHandlerWithMockedBlob();
    await mod.uploadInspirationPhotoHandler(fakeRequest({ imageDataUrl: SMALL_PNG_DATA_URL }), fakeContext());
    await mod.uploadInspirationPhotoHandler(fakeRequest({ imageDataUrl: SMALL_PNG_DATA_URL }), fakeContext());
    assert.strictEqual(getBlockBlobClientCalls.length, 2);
    assert.notStrictEqual(getBlockBlobClientCalls[0], getBlockBlobClientCalls[1]);
  });

  await test('handler returns 502 (not a 500 crash) when the blob upload fails, and does not log image bytes', async () => {
    const ctx = fakeContext();
    const { mod } = loadHandlerWithMockedBlob({ uploadDataThrows: new Error('storage account unreachable') });
    const res = await mod.uploadInspirationPhotoHandler(fakeRequest({ imageDataUrl: SMALL_PNG_DATA_URL }), ctx);
    assert.strictEqual(res.status, 502);
    const loggedText = JSON.stringify(ctx.errors);
    assert.ok(!loggedText.includes(SMALL_PNG_DATA_URL), 'the image data URL leaked into the error log');
  });

  await test('handler is rate-limited per IP after UPLOAD_PHOTO_RATE_LIMIT.maxAttempts calls, without ever reaching blob storage', async () => {
    const { mod, uploadDataCalls } = loadHandlerWithMockedBlob();
    const { UPLOAD_PHOTO_RATE_LIMIT } = mod;
    for (let i = 0; i < UPLOAD_PHOTO_RATE_LIMIT.maxAttempts; i++) {
      const res = await mod.uploadInspirationPhotoHandler(fakeRequest({ imageDataUrl: SMALL_PNG_DATA_URL }, '203.0.113.4'), fakeContext());
      assert.strictEqual(res.status, 201, `attempt ${i + 1} should still succeed`);
    }
    const blocked = await mod.uploadInspirationPhotoHandler(fakeRequest({ imageDataUrl: SMALL_PNG_DATA_URL }, '203.0.113.4'), fakeContext());
    assert.strictEqual(blocked.status, 429);
    assert.strictEqual(uploadDataCalls.length, UPLOAD_PHOTO_RATE_LIMIT.maxAttempts, 'the blocked attempt must never reach blob storage');
  });

  await test('handler rate limit is scoped per IP -- a different caller is unaffected', async () => {
    const { mod } = loadHandlerWithMockedBlob();
    const { UPLOAD_PHOTO_RATE_LIMIT } = mod;
    for (let i = 0; i < UPLOAD_PHOTO_RATE_LIMIT.maxAttempts; i++) {
      await mod.uploadInspirationPhotoHandler(fakeRequest({ imageDataUrl: SMALL_PNG_DATA_URL }, '203.0.113.5'), fakeContext());
    }
    const otherCaller = await mod.uploadInspirationPhotoHandler(fakeRequest({ imageDataUrl: SMALL_PNG_DATA_URL }, '203.0.113.6'), fakeContext());
    assert.strictEqual(otherCaller.status, 201);
  });

  console.log(`\n${passed} test(s) passed.`);
  if (process.exitCode) {
    console.error('Some tests FAILED.');
  }
}

run();
