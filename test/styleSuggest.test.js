// Unit test for src/functions/styleSuggest.js's request validation (the size-limit / shape-checking
// logic) plus an end-to-end handler test with lib/openai.js's suggestStyles() mocked out via
// require-cache substitution -- same no-live-credentials approach as test/openai.test.js. `pg` is
// also mocked (same approach as test/adminApi.test.js): this handler is now rate-limited
// (lib/rateLimit.js, see STYLE_SUGGEST_RATE_LIMIT) since each real call is a billed Azure OpenAI
// request, so it touches Postgres even though it never used to.
//
// Run with: node test/styleSuggest.test.js
'use strict';

const assert = require('assert');
const Module = require('module');
const path = require('path');

const STYLE_SUGGEST_PATH = path.join(__dirname, '..', 'src', 'functions', 'styleSuggest.js');
const OPENAI_LIB_PATH = path.join(__dirname, '..', 'lib', 'openai.js');
const PG_PATH = require.resolve('pg');

// A real (tiny) in-memory sliding window backs rate_limit_events here, same approach as
// test/adminApi.test.js/test/authApi.test.js/test/rateLimit.test.js, so a test that calls the handler
// more times than STYLE_SUGGEST_RATE_LIMIT.maxAttempts allows genuinely observes a 429.
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
      throw new Error(`unexpected query in styleSuggest test: ${sql}`);
    }
  }
  const fakeModule = new Module(PG_PATH);
  fakeModule.exports = { Pool: FakePool };
  fakeModule.loaded = true;
  return { fakeModule, rateLimitEvents };
}

// Azure Functions' `app.http(...)` registration call runs at module load time and needs the real
// @azure/functions package (present in node_modules already, as the deployed Functions app depends on
// it) -- that part is NOT mocked. lib/openai.js's network call and `pg` are mocked via require-cache
// substitution (Module._cache), so this stays a "mocked SDK/network, real everything else" unit test.
function loadStyleSuggestWithMockedOpenAI(mockSuggestStyles) {
  delete require.cache[STYLE_SUGGEST_PATH];
  delete require.cache[OPENAI_LIB_PATH];
  delete require.cache[PG_PATH];
  const fakeModule = new Module(OPENAI_LIB_PATH);
  fakeModule.exports = { suggestStyles: mockSuggestStyles };
  fakeModule.loaded = true;
  require.cache[OPENAI_LIB_PATH] = fakeModule;
  const { fakeModule: fakePg, rateLimitEvents } = makeFakePgModule();
  require.cache[PG_PATH] = fakePg;
  const mod = require(STYLE_SUGGEST_PATH);
  delete require.cache[OPENAI_LIB_PATH];
  delete require.cache[STYLE_SUGGEST_PATH];
  delete require.cache[PG_PATH];
  return { ...mod, _rateLimitEvents: rateLimitEvents };
}

const WIGS = [
  { id: 'straight', name: 'Silk Straight 24"' },
  { id: 'blonde', name: 'Blonde 613 Bob' },
];
const SMALL_IMAGE_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

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

  const { validateBody, MAX_IMAGE_BYTES } = loadStyleSuggestWithMockedOpenAI(async () => []);

  await test('validateBody accepts a well-formed request', () => {
    const errors = validateBody({ imageDataUrl: SMALL_IMAGE_DATA_URL, wigs: WIGS });
    assert.deepStrictEqual(errors, []);
  });

  await test('validateBody rejects a missing imageDataUrl', () => {
    const errors = validateBody({ wigs: WIGS });
    assert.ok(errors.some((e) => /imageDataUrl/.test(e)));
  });

  await test('validateBody rejects a non-data-URL imageDataUrl', () => {
    const errors = validateBody({ imageDataUrl: 'https://example.com/photo.jpg', wigs: WIGS });
    assert.ok(errors.some((e) => /data:image/.test(e)));
  });

  await test('validateBody rejects an oversized image (over the byte limit)', () => {
    // Build a base64 string long enough that (len * 3/4) exceeds MAX_IMAGE_BYTES.
    const neededChars = Math.ceil((MAX_IMAGE_BYTES + 1024) / 3) * 4;
    const oversizedBase64 = 'A'.repeat(neededChars);
    const errors = validateBody({ imageDataUrl: `data:image/png;base64,${oversizedBase64}`, wigs: WIGS });
    assert.ok(errors.some((e) => /too large/.test(e)), `expected a "too large" error, got: ${JSON.stringify(errors)}`);
  });

  await test('validateBody rejects an empty/missing wigs array', () => {
    let errors = validateBody({ imageDataUrl: SMALL_IMAGE_DATA_URL, wigs: [] });
    assert.ok(errors.some((e) => /wigs/.test(e)));
    errors = validateBody({ imageDataUrl: SMALL_IMAGE_DATA_URL });
    assert.ok(errors.some((e) => /wigs/.test(e)));
  });

  await test('validateBody rejects malformed wig entries', () => {
    const errors = validateBody({ imageDataUrl: SMALL_IMAGE_DATA_URL, wigs: [{ id: 'x' /* missing name */ }] });
    assert.ok(errors.some((e) => /each entry in wigs/.test(e)));
  });

  await test('handler returns 400 with details when validation fails', async () => {
    const { styleSuggestHandler } = loadStyleSuggestWithMockedOpenAI(async () => {
      throw new Error('should not be called');
    });
    const res = await styleSuggestHandler(fakeRequest({ wigs: WIGS }), fakeContext());
    assert.strictEqual(res.status, 400);
    assert.ok(Array.isArray(res.jsonBody.details));
  });

  await test('handler returns 200 + suggestions on success, and forwards the catalogue through untouched', async () => {
    let receivedWigs = null;
    const { styleSuggestHandler } = loadStyleSuggestWithMockedOpenAI(async ({ wigs }) => {
      receivedWigs = wigs;
      return [{ id: 'blonde', reason: 'Great match.' }];
    });
    const res = await styleSuggestHandler(fakeRequest({ imageDataUrl: SMALL_IMAGE_DATA_URL, wigs: WIGS }), fakeContext());
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.jsonBody.suggestions, [{ id: 'blonde', reason: 'Great match.' }]);
    assert.deepStrictEqual(receivedWigs, WIGS);
  });

  await test('handler returns 502 (not a 500 crash) when the AI call fails, and logs no image data', async () => {
    const ctx = fakeContext();
    const { styleSuggestHandler } = loadStyleSuggestWithMockedOpenAI(async () => {
      throw new Error('Azure OpenAI request failed: 429 rate limited');
    });
    const res = await styleSuggestHandler(fakeRequest({ imageDataUrl: SMALL_IMAGE_DATA_URL, wigs: WIGS }), ctx);
    assert.strictEqual(res.status, 502);
    const loggedText = JSON.stringify(ctx.errors);
    assert.ok(!loggedText.includes(SMALL_IMAGE_DATA_URL), 'the image data URL leaked into the error log');
  });

  await test('handler is rate-limited per IP after STYLE_SUGGEST_RATE_LIMIT.maxAttempts calls, without ever reaching the AI call', async () => {
    let aiCalls = 0;
    const { styleSuggestHandler, STYLE_SUGGEST_RATE_LIMIT } = loadStyleSuggestWithMockedOpenAI(async () => {
      aiCalls++;
      return [];
    });
    for (let i = 0; i < STYLE_SUGGEST_RATE_LIMIT.maxAttempts; i++) {
      const res = await styleSuggestHandler(
        fakeRequest({ imageDataUrl: SMALL_IMAGE_DATA_URL, wigs: WIGS }, '203.0.113.1'),
        fakeContext()
      );
      assert.strictEqual(res.status, 200, `attempt ${i + 1} should still succeed`);
    }
    const blocked = await styleSuggestHandler(
      fakeRequest({ imageDataUrl: SMALL_IMAGE_DATA_URL, wigs: WIGS }, '203.0.113.1'),
      fakeContext()
    );
    assert.strictEqual(blocked.status, 429);
    assert.strictEqual(aiCalls, STYLE_SUGGEST_RATE_LIMIT.maxAttempts, 'the blocked attempt must never reach the (billed) AI call');
  });

  await test('handler rate limit is scoped per IP -- a different caller is unaffected', async () => {
    const { styleSuggestHandler, STYLE_SUGGEST_RATE_LIMIT } = loadStyleSuggestWithMockedOpenAI(async () => []);
    for (let i = 0; i < STYLE_SUGGEST_RATE_LIMIT.maxAttempts; i++) {
      await styleSuggestHandler(fakeRequest({ imageDataUrl: SMALL_IMAGE_DATA_URL, wigs: WIGS }, '203.0.113.2'), fakeContext());
    }
    const otherCaller = await styleSuggestHandler(
      fakeRequest({ imageDataUrl: SMALL_IMAGE_DATA_URL, wigs: WIGS }, '203.0.113.3'),
      fakeContext()
    );
    assert.strictEqual(otherCaller.status, 200);
  });

  console.log(`\n${passed} test(s) passed.`);
  if (process.exitCode) {
    console.error('Some tests FAILED.');
  }
}

run();
