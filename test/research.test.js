const test = require('node:test');
const assert = require('node:assert/strict');
const { researchJobDescription, searchDuckDuckGoLite } = require('../src/research');

test('researchJobDescription returns empty structure on empty input', async () => {
  const res1 = await researchJobDescription('', {});
  assert.deepEqual(res1, { queries: [], results: [] });

  const res2 = await researchJobDescription(null, {});
  assert.deepEqual(res2, { queries: [], results: [] });
});

test('researchJobDescription extracts queries from JD and triggers progress callbacks', async () => {
  const sampleJD = `Senior Backend Engineer at Stripe
We are looking for an experienced engineer to build our next-generation payment infrastructure.
Tech Stack: Go, Kubernetes, Kafka, PostgreSQL, AWS.`;

  const progressEvents = [];
  const mockSettings = { provider: 'custom', apiKeys: {} }; // LLM not ready, will use regex fallback

  const result = await researchJobDescription(sampleJD, mockSettings, (prog) => {
    progressEvents.push(prog);
  });

  assert.ok(Array.isArray(result.queries), 'queries should be an array');
  assert.ok(result.queries.length > 0, 'should extract at least one query');
  assert.ok(progressEvents.length > 0, 'should trigger progress events');
  assert.ok(progressEvents.some(p => p.stage === 'done'), 'should reach done stage');
});

test('searchDuckDuckGoLite handles empty or failing query gracefully', async () => {
  // Should not throw or crash on abnormal query
  const res = await searchDuckDuckGoLite('');
  assert.equal(res, null);
});
