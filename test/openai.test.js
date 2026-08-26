// Mocked-fetch unit test for lib/openai.js (no live Azure OpenAI credentials required). Mirrors the
// mocking style of lib/email.js/lib/sms.js's ACS-SDK-client tests, adapted for a fetch-based wrapper.
//
// Run with: node test/openai.test.js
'use strict';

const assert = require('assert');
const { suggestStyles } = require('../lib/openai');

// Deliberately spans the catalogue's full range -- not just lighter colors/straighter textures --
// since a common way bias slips through untested is a test fixture that only ever exercises the
// "safe default" end of the catalogue. Includes deep/dark colors and coily/natural textures alongside
// straighter/lighter ones, and the assertions below check that ALL of them make it into the outbound
// prompt on equal footing (no code-level filtering that would favor one end of the catalogue).
const WIGS = [
  { id: 'straight', name: 'Silk Straight 24"', style: 'long', color: 0x241a16 },
  { id: 'blonde', name: 'Blonde 613 Bob', style: 'bob', color: 0xe8c98d },
  { id: 'chestnut', name: 'Chestnut Curls 18"', style: 'curl', color: 0x6b4226 },
  { id: 'natural4c', name: 'Natural 4C Coily Crown', style: 'coily', color: 0x140d0a, meta: 'Deep Jet Black' },
  { id: 'burgundy', name: 'Deep Burgundy Locs', style: 'locs', color: 0x3d0f14 },
];
// Multiple distinct fake "photos" (arbitrary bytes -- content is irrelevant since fetch is mocked) so
// tests can confirm the code path treats every input photo identically: same prompt shape, same
// catalogue forwarded in full, no branching on anything about the image itself.
const IMAGE_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const IMAGE_DATA_URL_ALT = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkI';

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
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

  const withEnv = async (envOverrides, fn) => {
    const prev = {};
    for (const k of Object.keys(envOverrides)) {
      prev[k] = process.env[k];
      process.env[k] = envOverrides[k];
    }
    try {
      await fn();
    } finally {
      for (const k of Object.keys(envOverrides)) {
        if (prev[k] === undefined) delete process.env[k];
        else process.env[k] = prev[k];
      }
    }
  };

  await test('throws a clear error when env vars are not configured', async () => {
    await withEnv({ AZURE_OPENAI_ENDPOINT: '', AZURE_OPENAI_API_KEY: '', AZURE_OPENAI_DEPLOYMENT: '' }, async () => {
      await assert.rejects(() => suggestStyles({ imageDataUrl: IMAGE_DATA_URL, wigs: WIGS }), /not configured/);
    });
  });

  await test('rejects an empty wigs catalogue even with valid env', async () => {
    await withEnv(
      { AZURE_OPENAI_ENDPOINT: 'https://x.openai.azure.com', AZURE_OPENAI_API_KEY: 'k', AZURE_OPENAI_DEPLOYMENT: 'gpt-5-mini' },
      async () => {
        await assert.rejects(() => suggestStyles({ imageDataUrl: IMAGE_DATA_URL, wigs: [] }), /non-empty wigs/);
      }
    );
  });

  await test('builds the expected Chat Completions request URL and body, and parses a valid response', async () => {
    await withEnv(
      { AZURE_OPENAI_ENDPOINT: 'https://afrikanadollz-openai-test.openai.azure.com/', AZURE_OPENAI_API_KEY: 'test-key', AZURE_OPENAI_DEPLOYMENT: 'gpt-5-mini', AZURE_OPENAI_API_VERSION: '2025-01-01-preview' },
      async () => {
        let capturedUrl, capturedOptions;
        const fakeFetch = async (url, options) => {
          capturedUrl = url;
          capturedOptions = options;
          return jsonResponse(200, {
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    suggestions: [
                      { id: 'blonde', reason: 'Warm skin tones pair beautifully with 613 blonde.' },
                      { id: 'chestnut', reason: 'Soft curls complement a rounder face shape.' },
                      { id: 'not-a-real-id', reason: 'Should be filtered out.' },
                    ],
                  }),
                },
              },
            ],
          });
        };

        const suggestions = await suggestStyles({ imageDataUrl: IMAGE_DATA_URL, wigs: WIGS, _fetch: fakeFetch });

        assert.strictEqual(
          capturedUrl,
          'https://afrikanadollz-openai-test.openai.azure.com/openai/deployments/gpt-5-mini/chat/completions?api-version=2025-01-01-preview'
        );
        assert.strictEqual(capturedOptions.method, 'POST');
        assert.strictEqual(capturedOptions.headers['api-key'], 'test-key');

        const sentBody = JSON.parse(capturedOptions.body);
        assert.strictEqual(sentBody.messages[0].role, 'system');
        assert.strictEqual(sentBody.messages[1].role, 'user');
        const imagePart = sentBody.messages[1].content.find((c) => c.type === 'image_url');
        assert.ok(imagePart, 'no image_url content part was sent');
        assert.strictEqual(imagePart.image_url.url, IMAGE_DATA_URL);

        // The catalogue text sent up must reference the real ids passed in, not hardcoded data --
        // and ALL of them, including the deep/natural-texture entries, not just the lighter/
        // straighter ones. This is the concrete check that nothing in this code path pre-filters the
        // catalogue toward a "safer default" subset before it ever reaches the model.
        const textPart = sentBody.messages[1].content.find((c) => c.type === 'text');
        for (const w of WIGS) {
          assert.ok(textPart.text.includes(w.id), `catalogue text did not include wig id "${w.id}"`);
        }

        // Response parsing: only real catalogue ids survive, capped at 3.
        assert.deepStrictEqual(
          suggestions.map((s) => s.id),
          ['blonde', 'chestnut']
        );
        assert.ok(suggestions[0].reason.length > 0);
      }
    );
  });

  await test('system prompt explicitly instructs equal-quality analysis across skin tones/textures, bans race/ethnicity guessing, and bans "safe default" bias', async () => {
    // This asserts on the actual instruction text sent to the model, not just on code behavior --
    // the point is to make the bias-mitigation design reviewable/enforced by a test, not just prose
    // in a comment. AFRIKANADOLLZ is a Black-owned salon serving a predominantly Black clientele, and
    // vision/beauty-recommendation models have a documented tendency to under-analyze darker skin
    // tones and natural/coily textures, or to implicitly default toward lighter/straighter options as
    // the "safe" choice -- these specific phrases exist to counter that.
    await withEnv(
      { AZURE_OPENAI_ENDPOINT: 'https://x.openai.azure.com', AZURE_OPENAI_API_KEY: 'k', AZURE_OPENAI_DEPLOYMENT: 'gpt-5-mini' },
      async () => {
        let capturedSystemPrompt = null;
        const fakeFetch = async (_url, options) => {
          const body = JSON.parse(options.body);
          capturedSystemPrompt = body.messages[0].content;
          return jsonResponse(200, { choices: [{ message: { content: JSON.stringify({ suggestions: [] }) } }] });
        };
        await suggestStyles({ imageDataUrl: IMAGE_DATA_URL, wigs: WIGS, _fetch: fakeFetch });

        const p = capturedSystemPrompt.toLowerCase();
        assert.ok(p.includes('equally specific'), 'prompt does not require equally specific analysis across skin tones/textures');
        assert.ok(p.includes('race') || p.includes('ethnicity'), 'prompt does not ban guessing race/ethnicity');
        assert.ok(p.includes('do not guess'), 'prompt does not explicitly forbid guessing');
        assert.ok(p.includes('safer'), 'prompt does not warn against treating lighter/straighter as a "safer" default');
        assert.ok(p.includes('coily') || p.includes('natural'), 'prompt does not explicitly name natural/coily textures');
        assert.ok(!p.includes('what looks good on your skin tone'), 'prompt should forbid, not use, reductive skin-tone framing');
      }
    );
  });

  await test('the outbound prompt is structurally identical regardless of which photo is sent (no branching on the image itself)', async () => {
    await withEnv(
      { AZURE_OPENAI_ENDPOINT: 'https://x.openai.azure.com', AZURE_OPENAI_API_KEY: 'k', AZURE_OPENAI_DEPLOYMENT: 'gpt-5-mini' },
      async () => {
        const capturedBodies = [];
        const fakeFetch = async (_url, options) => {
          capturedBodies.push(JSON.parse(options.body));
          return jsonResponse(200, { choices: [{ message: { content: JSON.stringify({ suggestions: [] }) } }] });
        };
        await suggestStyles({ imageDataUrl: IMAGE_DATA_URL, wigs: WIGS, _fetch: fakeFetch });
        await suggestStyles({ imageDataUrl: IMAGE_DATA_URL_ALT, wigs: WIGS, _fetch: fakeFetch });

        const [bodyA, bodyB] = capturedBodies;
        assert.strictEqual(bodyA.messages[0].content, bodyB.messages[0].content, 'system prompt changed based on the photo');
        const textA = bodyA.messages[1].content.find((c) => c.type === 'text').text;
        const textB = bodyB.messages[1].content.find((c) => c.type === 'text').text;
        assert.strictEqual(textA, textB, 'catalogue/user text changed based on the photo');
      }
    );
  });

  await test('throws when Azure OpenAI returns a non-2xx response', async () => {
    await withEnv(
      { AZURE_OPENAI_ENDPOINT: 'https://x.openai.azure.com', AZURE_OPENAI_API_KEY: 'k', AZURE_OPENAI_DEPLOYMENT: 'gpt-5-mini' },
      async () => {
        const fakeFetch = async () => jsonResponse(429, { error: { message: 'rate limited' } });
        await assert.rejects(() => suggestStyles({ imageDataUrl: IMAGE_DATA_URL, wigs: WIGS, _fetch: fakeFetch }), /429/);
      }
    );
  });

  await test('throws when the model response is not valid JSON', async () => {
    await withEnv(
      { AZURE_OPENAI_ENDPOINT: 'https://x.openai.azure.com', AZURE_OPENAI_API_KEY: 'k', AZURE_OPENAI_DEPLOYMENT: 'gpt-5-mini' },
      async () => {
        const fakeFetch = async () => jsonResponse(200, { choices: [{ message: { content: 'not json at all' } }] });
        await assert.rejects(() => suggestStyles({ imageDataUrl: IMAGE_DATA_URL, wigs: WIGS, _fetch: fakeFetch }), /not valid JSON/);
      }
    );
  });

  await test('returns an empty array (not an error) when the model suggests only unknown ids', async () => {
    await withEnv(
      { AZURE_OPENAI_ENDPOINT: 'https://x.openai.azure.com', AZURE_OPENAI_API_KEY: 'k', AZURE_OPENAI_DEPLOYMENT: 'gpt-5-mini' },
      async () => {
        const fakeFetch = async () =>
          jsonResponse(200, { choices: [{ message: { content: JSON.stringify({ suggestions: [{ id: 'nope', reason: 'x' }] }) } }] });
        const suggestions = await suggestStyles({ imageDataUrl: IMAGE_DATA_URL, wigs: WIGS, _fetch: fakeFetch });
        assert.deepStrictEqual(suggestions, []);
      }
    );
  });

  console.log(`\n${passed} test(s) passed.`);
  if (process.exitCode) {
    console.error('Some tests FAILED.');
  }
}

run();
