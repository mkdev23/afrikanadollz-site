// POST /api/style-suggest -- opt-in "AI style suggestions" feature for tryon.html. Accepts a
// base64-encoded photo captured/uploaded from the user's OWN device, and only ever runs when the user
// explicitly clicks the "Get AI style suggestions" button and clicks through its consent message (see
// tryon.html) -- this is the one deliberate, clearly-flagged exception to the page's "nothing is
// uploaded" promise, and it is never triggered automatically or silently.
//
// PRIVACY (this is the important part): this function does NOT persist the uploaded photo anywhere.
// No DB write, no blob storage, no disk write of any kind. The image lives only in this single
// invocation's in-memory request body, is forwarded once (as a data: URL) to Azure OpenAI's Chat
// Completions API for analysis, and is discarded the moment this handler returns. It is also never
// logged -- only the request's outcome/error is logged, never the image bytes or the data URL itself.
//
// Accepts the site's live WIGS catalogue (id/name/style/color) as part of the request body rather
// than hardcoding wig data in this function, so recommendations always reference the site's real,
// current inventory instead of stale/duplicated data -- see tryon.html's fetch() call in the AI style
// suggestions button handler, which sends `WIGS` straight through.
'use strict';

const { app } = require('@azure/functions');
const { Pool } = require('pg');
const { suggestStyles } = require('../../lib/openai');
const { getClientIp, enforceRateLimit, rateLimitResponse } = require('../../lib/rateLimit');

let pool;
function getPool() {
  if (!pool) pool = new Pool({ connectionString: process.env.DATABASE_URL });
  return pool;
}

// Raw image bytes, not the base64 text length (base64 expands ~4/3) -- "reasonable size limit... reject
// anything absurdly large" per the task. 8MB comfortably covers a camera snapshot/upload while
// rejecting anything abusive before it's ever sent on to Azure OpenAI.
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const DATA_URL_RE = /^data:image\/(png|jpe?g|webp);base64,([A-Za-z0-9+/]+=*)$/;

// This is a pre-account, anonymous flow with no login to key on -- IP is the only identifier
// available, so this is purely a blunt cost-DoS backstop (each call is a real, billed Azure OpenAI
// request), not a precise per-user cap. 15 requests / 15 minutes comfortably covers one visitor trying
// several photos/angles in a sitting while bounding how much a single source can cost the site if it
// hammers the endpoint continuously.
const STYLE_SUGGEST_RATE_LIMIT = { bucket: 'style_suggest', windowMs: 15 * 60 * 1000, maxAttempts: 15 };

function validateBody(body) {
  const errors = [];
  if (!body || typeof body !== 'object') return ['Request body must be JSON'];

  if (!body.imageDataUrl || typeof body.imageDataUrl !== 'string') {
    errors.push('imageDataUrl is required and must be a data:image/...;base64,... URL');
  } else {
    const match = DATA_URL_RE.exec(body.imageDataUrl);
    if (!match) {
      errors.push('imageDataUrl must look like data:image/(png|jpeg|webp);base64,<data>');
    } else {
      // Estimate raw bytes from the encoded string length rather than decoding the whole payload up
      // front, so an absurdly large request is rejected cheaply.
      const approxRawBytes = Math.floor((match[2].length * 3) / 4);
      if (approxRawBytes > MAX_IMAGE_BYTES) {
        errors.push(
          `imageDataUrl is too large (~${Math.round(approxRawBytes / 1024 / 1024)}MB) -- max ${MAX_IMAGE_BYTES / 1024 / 1024}MB`
        );
      }
    }
  }

  if (!Array.isArray(body.wigs) || body.wigs.length === 0) {
    errors.push('wigs is required and must be a non-empty array of {id, name, style?, color?}');
  } else if (body.wigs.some((w) => !w || typeof w.id !== 'string' || typeof w.name !== 'string')) {
    errors.push('each entry in wigs must at least have {id: string, name: string}');
  }

  if (body.instructions !== undefined && typeof body.instructions !== 'string') {
    errors.push('instructions, if provided, must be a string');
  }

  return errors;
}

async function styleSuggestHandler(request, context) {
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
    { bucket: STYLE_SUGGEST_RATE_LIMIT.bucket, identifier: `ip:${ip}`, windowMs: STYLE_SUGGEST_RATE_LIMIT.windowMs, maxAttempts: STYLE_SUGGEST_RATE_LIMIT.maxAttempts },
  ]);
  if (blocked) {
    return rateLimitResponse(blocked, 'Too many style-suggestion requests. Please try again shortly.');
  }

  try {
    const suggestions = await suggestStyles({
      imageDataUrl: body.imageDataUrl,
      wigs: body.wigs,
      instructions: body.instructions ? body.instructions.slice(0, 500) : undefined,
    });

    return {
      status: 200,
      jsonBody: {
        suggestions,
        note: suggestions.length === 0 ? 'No confident matches were returned -- try a clearer, front-facing photo.' : undefined,
      },
    };
  } catch (err) {
    // Never log the image itself (data URL or bytes) -- only the failure, matching the
    // no-persistence/no-logging privacy guarantee described above.
    context.error('POST /api/style-suggest failed:', err && err.message);
    return { status: 502, jsonBody: { error: 'AI style suggestions are unavailable right now. Please try again shortly.' } };
  }
}

app.http('styleSuggest', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'style-suggest',
  handler: styleSuggestHandler,
});

module.exports = { styleSuggestHandler, validateBody, MAX_IMAGE_BYTES, STYLE_SUGGEST_RATE_LIMIT };
