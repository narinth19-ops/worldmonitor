import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  analysisSchema,
  buildAnalysisRequest,
  buildSnapshot,
  extractResponseJson,
  parseSseOrJson,
  snapshotToMarkdown,
  unwrapMcpResult,
} from '../scripts/local-market-analysis.mjs';

describe('local market snapshot', () => {
  it('parses JSON and streamable MCP responses', () => {
    assert.deepEqual(parseSseOrJson('{"ok":true}'), { ok: true });
    assert.deepEqual(parseSseOrJson('event: message\ndata: {"first":1}\n\ndata: {"last":2}\n', 'text/event-stream'), { last: 2 });
  });

  it('unwraps structured and text MCP results', () => {
    assert.deepEqual(unwrapMcpResult({ result: { structuredContent: { data: 1 } } }), { data: 1 });
    assert.deepEqual(unwrapMcpResult({ result: { content: [{ type: 'text', text: '{"data":2}' }] } }), { data: 2 });
  });

  it('preserves observations and marks absent values without fabricating them', () => {
    const now = new Date('2026-08-10T00:10:00.000Z');
    const snapshot = buildSnapshot({
      generatedAt: now,
      market: {
        cached_at: '2026-08-10T00:05:00.000Z', stale: false,
        data: {
          'commodities-bootstrap': { quotes: [{ symbol: 'GC=F', price: 2400, change: 1.2 }] },
          crypto: { quotes: [{ symbol: 'BTC-USD', price: 70000, change: -0.4 }] },
        },
      },
      economic: { cached_at: '2026-08-09T12:00:00.000Z', stale: true, data: { FEDFUNDS: { value: 4.5 } } },
    });
    assert.equal(snapshot.sources.market.ageSeconds, 300);
    assert.equal(snapshot.domains.gold.data.quotes[0].price, 2400);
    assert.equal(snapshot.domains.gold.data.cot, null);
    assert.equal(snapshot.domains.gold.status, 'stale');
    assert.equal(snapshot.domains.gold.sources.economic.stale, true);
    assert.equal(snapshot.domains.macroRates.status, 'stale');
    assert.equal(snapshot.domains.macroRates.data.euYieldCurve, null);
    assert.match(snapshotToMarkdown(snapshot), /"euYieldCurve": null/);
  });
});

describe('GPT market analysis contract', () => {
  it('requires every evidence category for every domain and bans extra fields', () => {
    const schema = analysisSchema();
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(schema.properties.domains.required, ['gold', 'fx', 'macroRates', 'commodities', 'crypto']);
    for (const domain of Object.values(schema.properties.domains.properties)) {
      assert.equal(domain.additionalProperties, false);
      assert.ok(domain.required.includes('observedFacts'));
      assert.ok(domain.required.includes('missingOrStaleData'));
      assert.ok(domain.required.includes('whatToWatchNext'));
    }
  });

  it('uses Responses structured output and explicitly forbids scores and fabrication', () => {
    const request = buildAnalysisRequest({ generatedAt: '2026-08-10T00:00:00Z', domains: {} }, 'test-model');
    assert.equal(request.model, 'test-model');
    assert.equal(request.text.format.type, 'json_schema');
    assert.match(request.instructions, /Never invent/);
    assert.match(request.instructions, /Do not create scores/);
  });

  it('extracts JSON from Responses API output items', () => {
    assert.deepEqual(extractResponseJson({ output: [{ content: [{ type: 'output_text', text: '{"ok":true}' }] }] }), { ok: true });
  });
});
