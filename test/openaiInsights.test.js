// Mocked-fetch unit tests for lib/openai.js's business-insights generation
// (buildInsightsMessages/summarizeMetricsForPrompt/generateInsights) -- added for the admin Dashboard
// tab's AI-insights panel. Separate file from test/openai.test.js (which covers the pre-existing
// suggestStyles/buildMessages vision-suggestion feature) since these are a distinct, unrelated feature
// sharing only the module and the fetch-mocking style.
//
// Run with: node test/openaiInsights.test.js
'use strict';

const assert = require('assert');
const { buildInsightsMessages, summarizeMetricsForPrompt, generateInsights } = require('../lib/openai');

// A representative shapeDashboardMetrics() output (see lib/dashboardMetrics.js) -- deliberately
// includes a standout figure in every section (a dominant category, a no-show-heavy category, a slow
// weekday) so tests can assert those real numbers actually make it into the prompt text.
const METRICS = {
  range: { from: '2026-05-21', to: '2026-08-19', days: 90, granularity: 'week' },
  revenueOverTime: [{ bucket: '2026-08-10', revenueCents: 120000, count: 6 }],
  revenueByCategory: [
    { category: 'Wigs', revenueCents: 500000, count: 20 },
    { category: 'Braids', revenueCents: 80000, count: 8 },
  ],
  revenueByService: [
    { serviceId: 1, name: 'Full Lace Install', category: 'Wigs', revenueCents: 300000, count: 10 },
    { serviceId: 2, name: 'Box Braids', category: 'Braids', revenueCents: 80000, count: 8 },
  ],
  bookingVolumeOverTime: [{ bucket: '2026-08-10', status: 'confirmed', count: 6 }],
  bookingsByWeekday: [
    { weekday: 1, count: 2 }, // Monday -- deliberately the slow one
    { weekday: 6, count: 30 }, // Saturday -- deliberately the busy one
  ],
  statusTotals: { confirmed: 10, completed: 40, cancelled: 5, no_show: 8, total: 63 },
  noShowRate: 8 / 63,
  cancellationRate: 5 / 63,
  noShowRateByCategory: [
    { category: 'Wigs', noShowCount: 1, total: 20, rate: 0.05 },
    { category: 'Braids', noShowCount: 6, total: 15, rate: 0.4 }, // deliberately the standout
  ],
  newVsReturning: { new: 12, returning: 30 },
  billingTotals: { totalCents: 580000, count: 28 },
  avgTicketCents: 20714,
  upcomingLoad: { next7Days: 9, next30Days: 34 },
  generatedAt: '2026-08-19T12:00:00.000Z',
};

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

  // ---------------- summarizeMetricsForPrompt ----------------

  await test('summarizeMetricsForPrompt: includes the real standout figures from every section', () => {
    const text = summarizeMetricsForPrompt(METRICS);
    assert.ok(text.includes('Wigs'), 'missing category name');
    assert.ok(text.includes('$5,000.00') || text.includes('$5000.00'), 'missing formatted category revenue');
    assert.ok(text.includes('Full Lace Install'), 'missing top service name');
    assert.ok(text.includes('Braids'), 'missing second category');
    assert.ok(text.includes('40.0%'), 'missing the standout Braids no-show rate');
    assert.ok(text.includes('Monday'), 'missing weekday name');
    assert.ok(text.includes('12 new'), 'missing new-customer count');
    assert.ok(text.includes('30 returning'), 'missing returning-customer count');
    assert.ok(text.includes('9') && text.includes('34'), 'missing upcoming-load figures');
  });

  await test('summarizeMetricsForPrompt: never mentions a category/service/weekday not present in the input', () => {
    const text = summarizeMetricsForPrompt(METRICS);
    assert.ok(!text.includes('Sew-in'), 'invented a service name not in the input');
    assert.ok(!text.includes('Locs'), 'invented a category not in the input');
  });

  // ---------------- buildInsightsMessages ----------------

  await test('buildInsightsMessages: system prompt demands grounded, specific, non-generic recommendations and strict JSON', () => {
    const messages = buildInsightsMessages({ metrics: METRICS });
    assert.strictEqual(messages[0].role, 'system');
    assert.strictEqual(messages[1].role, 'user');
    const sys = messages[0].content.toLowerCase();
    assert.ok(sys.includes('grounded'), 'prompt does not require grounding in real numbers');
    assert.ok(sys.includes('never generic') || sys.includes('not generic'), 'prompt does not ban generic filler advice');
    assert.ok(sys.includes('cite'), 'prompt does not require citing the specific figures');
    assert.ok(sys.includes('strict json'), 'prompt does not require strict JSON output');
    assert.ok(sys.includes('"insights"'), 'prompt does not specify the {"insights":[...]} shape');
  });

  await test('buildInsightsMessages: user message embeds the actual metrics summary text', () => {
    const messages = buildInsightsMessages({ metrics: METRICS });
    assert.strictEqual(typeof messages[1].content, 'string');
    assert.ok(messages[1].content.includes('Full Lace Install'));
    assert.ok(messages[1].content.includes(summarizeMetricsForPrompt(METRICS)));
  });

  // ---------------- generateInsights ----------------

  await test('generateInsights: throws a clear error when env vars are not configured', async () => {
    await withEnv({ AZURE_OPENAI_ENDPOINT: '', AZURE_OPENAI_API_KEY: '', AZURE_OPENAI_DEPLOYMENT: '' }, async () => {
      await assert.rejects(() => generateInsights({ metrics: METRICS }), /not configured/);
    });
  });

  await test('generateInsights: rejects a missing metrics object even with valid env', async () => {
    await withEnv(
      { AZURE_OPENAI_ENDPOINT: 'https://x.openai.azure.com', AZURE_OPENAI_API_KEY: 'k', AZURE_OPENAI_DEPLOYMENT: 'gpt-5-mini' },
      async () => {
        await assert.rejects(() => generateInsights({ metrics: null }), /metrics snapshot/);
      }
    );
  });

  await test('generateInsights: builds the expected request and parses a valid strict-JSON response', async () => {
    await withEnv(
      { AZURE_OPENAI_ENDPOINT: 'https://afrikanadollz-openai-test.openai.azure.com/', AZURE_OPENAI_API_KEY: 'test-key', AZURE_OPENAI_DEPLOYMENT: 'gpt-5-mini', AZURE_OPENAI_API_VERSION: '2025-01-01-preview' },
      async () => {
        let capturedUrl, capturedOptions;
        const fakeFetch = async (url, options) => {
          capturedUrl = url;
          capturedOptions = options;
          return jsonResponse(200, {
            choices: [{
              message: {
                content: JSON.stringify({
                  insights: [
                    { title: 'Braids no-shows are 8x Wigs', detail: '40% of Braids appointments were no-shows vs 5% for Wigs; consider a deposit requirement for Braids bookings.' },
                    { title: 'Mondays are quiet', detail: 'Only 2 bookings landed on Mondays vs 30 on Saturdays.' },
                  ],
                }),
              },
            }],
          });
        };

        const insights = await generateInsights({ metrics: METRICS, _fetch: fakeFetch });

        assert.strictEqual(
          capturedUrl,
          'https://afrikanadollz-openai-test.openai.azure.com/openai/deployments/gpt-5-mini/chat/completions?api-version=2025-01-01-preview'
        );
        assert.strictEqual(capturedOptions.method, 'POST');
        assert.strictEqual(capturedOptions.headers['api-key'], 'test-key');
        const sentBody = JSON.parse(capturedOptions.body);
        assert.deepStrictEqual(sentBody.response_format, { type: 'json_object' });
        assert.strictEqual(sentBody.messages.length, 2);

        assert.strictEqual(insights.length, 2);
        assert.strictEqual(insights[0].title, 'Braids no-shows are 8x Wigs');
        assert.ok(insights[0].detail.includes('40%'));
      }
    );
  });

  await test('generateInsights: caps at 5 insights and drops malformed entries', async () => {
    await withEnv(
      { AZURE_OPENAI_ENDPOINT: 'https://x.openai.azure.com', AZURE_OPENAI_API_KEY: 'k', AZURE_OPENAI_DEPLOYMENT: 'gpt-5-mini' },
      async () => {
        const many = Array.from({ length: 8 }, (_, i) => ({ title: `T${i}`, detail: `D${i}` }));
        many.push({ title: 'no detail here' }); // malformed -- should be filtered out
        const fakeFetch = async () => jsonResponse(200, { choices: [{ message: { content: JSON.stringify({ insights: many }) } }] });
        const insights = await generateInsights({ metrics: METRICS, _fetch: fakeFetch });
        assert.strictEqual(insights.length, 5);
        assert.strictEqual(insights[0].title, 'T0');
      }
    );
  });

  await test('generateInsights: throws when Azure OpenAI returns a non-2xx response', async () => {
    await withEnv(
      { AZURE_OPENAI_ENDPOINT: 'https://x.openai.azure.com', AZURE_OPENAI_API_KEY: 'k', AZURE_OPENAI_DEPLOYMENT: 'gpt-5-mini' },
      async () => {
        const fakeFetch = async () => jsonResponse(500, { error: 'boom' });
        await assert.rejects(() => generateInsights({ metrics: METRICS, _fetch: fakeFetch }), /500/);
      }
    );
  });

  await test('generateInsights: throws when the response JSON does not match {"insights":[...]}', async () => {
    await withEnv(
      { AZURE_OPENAI_ENDPOINT: 'https://x.openai.azure.com', AZURE_OPENAI_API_KEY: 'k', AZURE_OPENAI_DEPLOYMENT: 'gpt-5-mini' },
      async () => {
        const fakeFetch = async () => jsonResponse(200, { choices: [{ message: { content: JSON.stringify({ foo: 'bar' }) } }] });
        await assert.rejects(() => generateInsights({ metrics: METRICS, _fetch: fakeFetch }), /insights/);
      }
    );
  });

  console.log(`\n${passed} test(s) passed.`);
  if (process.exitCode) {
    console.error('Some tests FAILED.');
  }
}

run();
