// Thin wrapper around Azure OpenAI's Chat Completions REST API (vision-capable model), used by
// src/functions/styleSuggest.js for the opt-in "AI style suggestions" feature on tryon.html. Kept
// separate from the HTTP layer so it can be unit-tested with a mocked fetch, same spirit as
// lib/email.js/lib/sms.js being unit-tested with a mocked ACS SDK client.
//
// Uses Node 20's built-in global fetch rather than an SDK -- this is a single JSON POST, and this
// project deliberately keeps its Azure Functions app's dependency footprint small (see package.json:
// just pg + @azure/functions + the two ACS SDKs). No new dependency was added for this.
//
// PLACEHOLDER env vars -- filled in for real once infra/main.bicep's Azure OpenAI resource is
// deployed (see that file's header comment for the resource/model chosen and the region/availability
// research behind it):
//   AZURE_OPENAI_ENDPOINT    - e.g. https://afrikanadollz-openai-<suffix>.openai.azure.com/
//   AZURE_OPENAI_API_KEY     - from the OpenAI resource's "Keys and Endpoint" blade
//   AZURE_OPENAI_DEPLOYMENT  - the chat model deployment name (e.g. "gpt-5-mini")
//   AZURE_OPENAI_API_VERSION - Chat Completions REST API version (e.g. "2025-01-01-preview")
'use strict';

const DEFAULT_API_VERSION = '2025-01-01-preview';

function buildMessages({ imageDataUrl, wigs, instructions }) {
  const catalogText = wigs
    .map((w) => `- id: ${w.id}, name: ${w.name}${w.style ? `, style: ${w.style}` : ''}${w.color !== undefined ? `, color: ${w.color}` : ''}${w.meta ? `, notes: ${w.meta}` : ''}`)
    .join('\n');

  // Bias-mitigation is deliberate, not incidental: AFRIKANADOLLZ is a Black-owned salon serving a
  // predominantly Black clientele, and vision/beauty-recommendation models have a well-documented
  // tendency to under-analyze darker skin tones and natural/coily hair textures, or to default toward
  // Eurocentric norms (implicitly treating lighter colors/straighter textures as the "safe"/flattering
  // choice). The instructions below exist specifically to counter that, not as generic politeness --
  // every clause here is there to force the SAME depth and quality of analysis regardless of who is in
  // the photo, and to make sure the catalogue's full range (including deep/natural colors and coily/
  // curly textures) gets recommended on its own merits rather than being passed over by default.
  const systemPrompt =
    'You are a professional hair stylist assistant for a wig salon (AFRIKANADOLLZ), a Black-owned ' +
    'salon serving a predominantly Black clientele. Given a photo of a customer and a catalogue of wig ' +
    'units, recommend the 2-3 best-suited units for the customer\'s face shape and complexion.\n\n' +
    'Analysis quality must be equally specific and equally high-quality no matter the person\'s skin ' +
    'tone or hair texture in the photo -- give darker skin tones and tightly coiled/natural hair ' +
    'textures the exact same depth of specific, respectful reasoning you would give lighter skin tones ' +
    'or straighter textures. Never let a lighter color or straighter style win by default or be treated ' +
    'as a "safer"/more universally flattering choice -- weigh every catalogue entry, including deep, ' +
    'dark, and natural colors and coily/curly textures, purely on genuine complementary-undertone and ' +
    'face-shape fit with the photo. Do not guess, state, or reference the person\'s race or ethnicity. ' +
    'Avoid reductive framing like "this looks good on your skin tone" -- instead reason concretely about ' +
    'color contrast/undertone and face-shape fit, the same specific way for every customer.\n\n' +
    'Reply with STRICT JSON ONLY, no markdown, matching exactly this shape: ' +
    '{"suggestions":[{"id":"<catalogue id>","reason":"<one short, specific sentence citing undertone/' +
    'color-contrast or face-shape fit>"}]}. Only use ids that appear in the provided catalogue. Return ' +
    'at most 3 suggestions, ordered best-first.';

  const userText = `Wig catalogue:\n${catalogText}\n\n${instructions || 'Suggest 2-3 units from the catalogue above that would suit this person, and briefly say why.'}`;

  return [
    { role: 'system', content: systemPrompt },
    {
      role: 'user',
      content: [
        { type: 'text', text: userText },
        { type: 'image_url', image_url: { url: imageDataUrl } },
      ],
    },
  ];
}

/**
 * Ask the Azure OpenAI vision-capable chat deployment which wigs from `wigs` best suit the person in
 * `imageDataUrl`. Never persists the image -- it is only ever forwarded, once, as part of this single
 * request body.
 * @param {object} params
 * @param {string} params.imageDataUrl - a `data:image/...;base64,...` URL.
 * @param {Array<{id:string,name:string,style?:string,color?:*,meta?:string}>} params.wigs - the
 *   caller-supplied, current WIGS catalogue (see tryon.html) -- never hardcoded here, so suggestions
 *   always reference real, current inventory.
 * @param {string} [params.instructions] - optional extra instruction text (e.g. a stated preference).
 * @param {Function} [params._fetch] - test-only override for the fetch implementation.
 * @returns {Promise<Array<{id:string, reason:string}>>}
 */
// ============================================================================
// Business-insights generation (admin dashboard's "AI insights" panel — see
// src/functions/admin/dashboardInsights.js). Text-only: reasons over an aggregated metrics snapshot
// (lib/dashboardMetrics.js's shapeDashboardMetrics output), never raw customer PII/appointment rows.
// Same Chat Completions endpoint/deployment/env-vars as suggestStyles above, just a different
// buildXMessages()/parse pairing -- no second client, no SDK, same fetch-based house style.
// ============================================================================

function pct(n) {
  return `${(Number(n) * 100).toFixed(1)}%`;
}
function money(cents) {
  return `$${(Number(cents) / 100).toFixed(2)}`;
}

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * Render a metrics snapshot (lib/dashboardMetrics.js's shapeDashboardMetrics output) into a compact,
 * numbers-forward text block for the model -- deliberately terse (bullet lists of real figures, not
 * prose) so the model reasons over the actual numbers rather than padding/summarizing them back, and so
 * a small max_completion_tokens budget is spent on the model's output, not re-reading a verbose input.
 * Exported (not just used internally) so it's independently testable/reviewable, same spirit as
 * buildMessages() above.
 * @param {object} metrics - shapeDashboardMetrics() output
 */
function summarizeMetricsForPrompt(metrics) {
  const lines = [];
  lines.push(`Date range: ${metrics.range.from} to ${metrics.range.to} (${metrics.range.days} days, ${metrics.range.granularity}ly buckets).`);

  const revTotal = (metrics.revenueByCategory || []).reduce((s, c) => s + c.revenueCents, 0);
  lines.push(`Total revenue in range: ${money(revTotal)} across ${metrics.billingTotals.count} recorded payments. Average ticket: ${money(metrics.avgTicketCents)}.`);

  if (metrics.revenueByCategory && metrics.revenueByCategory.length) {
    lines.push('Revenue by category:');
    metrics.revenueByCategory.forEach((c) => {
      lines.push(`  - ${c.category}: ${money(c.revenueCents)} (${c.count} payments)`);
    });
  }

  if (metrics.revenueByService && metrics.revenueByService.length) {
    lines.push('Revenue by individual service (top 10, with revenue-per-booking):');
    metrics.revenueByService.slice(0, 10).forEach((s) => {
      const perBooking = s.count > 0 ? Math.round(s.revenueCents / s.count) : 0;
      lines.push(`  - ${s.name} (${s.category}): ${money(s.revenueCents)} total, ${s.count} bookings, ${money(perBooking)}/booking`);
    });
  }

  lines.push(`Appointments in range: ${metrics.statusTotals.total} total -- confirmed ${metrics.statusTotals.confirmed}, completed ${metrics.statusTotals.completed}, cancelled ${metrics.statusTotals.cancelled}, no-show ${metrics.statusTotals.no_show}.`);
  lines.push(`Overall no-show rate: ${pct(metrics.noShowRate)}. Overall cancellation rate: ${pct(metrics.cancellationRate)}.`);

  if (metrics.noShowRateByCategory && metrics.noShowRateByCategory.length) {
    lines.push('No-show rate by category:');
    metrics.noShowRateByCategory.forEach((c) => {
      lines.push(`  - ${c.category}: ${pct(c.rate)} (${c.noShowCount} of ${c.total} appointments)`);
    });
  }

  if (metrics.bookingsByWeekday && metrics.bookingsByWeekday.length) {
    lines.push('Bookings by day of week:');
    metrics.bookingsByWeekday.forEach((w) => {
      lines.push(`  - ${WEEKDAY_NAMES[w.weekday] || w.weekday}: ${w.count} bookings`);
    });
  }

  lines.push(`New vs returning customers active in range: ${metrics.newVsReturning.new} new, ${metrics.newVsReturning.returning} returning.`);
  lines.push(`Upcoming confirmed load: ${metrics.upcomingLoad.next7Days} in the next 7 days, ${metrics.upcomingLoad.next30Days} in the next 30 days.`);

  return lines.join('\n');
}

function buildInsightsMessages({ metrics }) {
  const systemPrompt =
    'You are a business analyst for AFRIKANADOLLZ, a small single-operator hair/wig salon. You will be given a ' +
    'summary of the salon\'s real booking and revenue metrics for a recent date range. Produce concrete, ' +
    'actionable recommendations grounded ONLY in the numbers given -- never generic advice ("increase your ' +
    'marketing", "improve customer service") that isn\'t tied to a specific figure in the summary. Every ' +
    'recommendation must cite the specific number(s) that motivated it (a rate, a dollar figure, a count, a ' +
    'day-of-week pattern) so the reasoning is checkable against the data. If a metric looks unremarkable or ' +
    'there isn\'t enough signal to say anything specific about it, leave it out rather than inventing a generic ' +
    'point about it. Do not recommend anything about categories/services/days that aren\'t named in the summary.\n\n' +
    'Reply with STRICT JSON ONLY, no markdown, matching exactly this shape: ' +
    '{"insights":[{"title":"<short, specific headline, under 80 chars>","detail":"<1-3 sentences citing the ' +
    'exact figures behind it>"}]}. Return between 2 and 5 insights, ordered by how impactful acting on them ' +
    'would likely be, most impactful first.';

  const userText = `Here is this salon's current metrics snapshot:\n\n${summarizeMetricsForPrompt(metrics)}\n\nGenerate the recommendations.`;

  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userText },
  ];
}

/**
 * Ask the Azure OpenAI text chat deployment to reason over a business-metrics snapshot and return
 * structured, grounded recommendations. Same env vars / request shape as suggestStyles above, but a
 * plain text user message (no image content part) since there's no photo involved here.
 * @param {object} params
 * @param {object} params.metrics - lib/dashboardMetrics.js's shapeDashboardMetrics() output
 * @param {Function} [params._fetch] - test-only override for the fetch implementation.
 * @returns {Promise<Array<{title:string, detail:string}>>}
 */
async function generateInsights({ metrics, _fetch }) {
  const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
  const apiKey = process.env.AZURE_OPENAI_API_KEY;
  const deployment = process.env.AZURE_OPENAI_DEPLOYMENT;
  const apiVersion = process.env.AZURE_OPENAI_API_VERSION || DEFAULT_API_VERSION;

  if (!endpoint || !apiKey || !deployment) {
    throw new Error('AZURE_OPENAI_ENDPOINT/AZURE_OPENAI_API_KEY/AZURE_OPENAI_DEPLOYMENT not configured');
  }
  if (!metrics || typeof metrics !== 'object') {
    throw new Error('generateInsights requires a metrics snapshot object');
  }

  const url = `${endpoint.replace(/\/+$/, '')}/openai/deployments/${encodeURIComponent(deployment)}/chat/completions?api-version=${encodeURIComponent(apiVersion)}`;

  const requestBody = {
    messages: buildInsightsMessages({ metrics }),
    // Same reasoning-model token-budget consideration as suggestStyles above (gpt-5-mini spends part of
    // this on invisible reasoning tokens before any visible output) -- a structured 2-5 item JSON list
    // with cited figures is a bit longer than suggestStyles' output, so this leaves extra headroom.
    max_completion_tokens: 2000,
    response_format: { type: 'json_object' },
  };

  const doFetch = _fetch || fetch;
  const res = await doFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'api-key': apiKey },
    body: JSON.stringify(requestBody),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Azure OpenAI request failed: ${res.status} ${res.statusText}${text ? ` - ${text}` : ''}`);
  }

  const json = await res.json();
  const content = json && json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
  if (!content) {
    throw new Error('Azure OpenAI response had no message content');
  }

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    throw new Error(`Azure OpenAI response was not valid JSON: ${err.message}`);
  }
  if (!parsed || !Array.isArray(parsed.insights)) {
    throw new Error('Azure OpenAI response JSON did not match the expected {"insights":[...]} shape');
  }

  return parsed.insights
    .filter((i) => i && typeof i.title === 'string' && typeof i.detail === 'string')
    .slice(0, 5)
    .map((i) => ({ title: i.title.slice(0, 200), detail: i.detail.slice(0, 800) }));
}

async function suggestStyles({ imageDataUrl, wigs, instructions, _fetch }) {
  const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
  const apiKey = process.env.AZURE_OPENAI_API_KEY;
  const deployment = process.env.AZURE_OPENAI_DEPLOYMENT;
  const apiVersion = process.env.AZURE_OPENAI_API_VERSION || DEFAULT_API_VERSION;

  if (!endpoint || !apiKey || !deployment) {
    throw new Error('AZURE_OPENAI_ENDPOINT/AZURE_OPENAI_API_KEY/AZURE_OPENAI_DEPLOYMENT not configured');
  }
  if (!Array.isArray(wigs) || wigs.length === 0) {
    throw new Error('suggestStyles requires a non-empty wigs catalogue array');
  }

  const url = `${endpoint.replace(/\/+$/, '')}/openai/deployments/${encodeURIComponent(deployment)}/chat/completions?api-version=${encodeURIComponent(apiVersion)}`;

  const requestBody = {
    messages: buildMessages({ imageDataUrl, wigs, instructions }),
    // gpt-5-mini is a reasoning model: verified live against the actual deployed resource that it
    // spends a chunk of max_completion_tokens on internal (invisible) reasoning tokens BEFORE any
    // visible output -- a first attempt at 600 came back with empty message content and finish_reason
    // "length" because reasoning alone ate the whole budget. 1500 leaves comfortable headroom (a real
    // call against this exact prompt shape used ~320 reasoning + ~70 visible tokens).
    max_completion_tokens: 1500,
    // No `temperature` override here -- verified live: this model rejects any non-default temperature
    // with a 400 ("Only the default (1) value is supported"), a real, current constraint of the GPT-5
    // reasoning-model family on Azure OpenAI's Chat Completions API. Omit the field to use its default.
    response_format: { type: 'json_object' },
  };

  const doFetch = _fetch || fetch;
  const res = await doFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'api-key': apiKey },
    body: JSON.stringify(requestBody),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Azure OpenAI request failed: ${res.status} ${res.statusText}${text ? ` - ${text}` : ''}`);
  }

  const json = await res.json();
  const content = json && json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
  if (!content) {
    throw new Error('Azure OpenAI response had no message content');
  }

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    throw new Error(`Azure OpenAI response was not valid JSON: ${err.message}`);
  }
  if (!parsed || !Array.isArray(parsed.suggestions)) {
    throw new Error('Azure OpenAI response JSON did not match the expected {"suggestions":[...]} shape');
  }

  const validIds = new Set(wigs.map((w) => w.id));
  return parsed.suggestions
    .filter((s) => s && typeof s.id === 'string' && validIds.has(s.id))
    .slice(0, 3)
    .map((s) => ({ id: s.id, reason: typeof s.reason === 'string' ? s.reason.slice(0, 400) : '' }));
}

module.exports = { suggestStyles, buildMessages, generateInsights, buildInsightsMessages, summarizeMetricsForPrompt };
