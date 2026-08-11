import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  collectLocalMarketSnapshot,
  localMarketSnapshotToMarkdown,
  type SnapshotDependencies,
} from '../src/services/local-market-snapshot.ts';

function deps(overrides: Partial<SnapshotDependencies> = {}): SnapshotDependencies {
  return {
    fetchCommodities: async () => ({ data: [{ symbol: 'GC=F', name: 'Gold', display: 'Gold', price: 2500, change: 1.2 }] }),
    fetchCryptoData: async () => [{ symbol: 'BTC', name: 'Bitcoin', price: 70000, change: -0.5 }],
    fetchFx: async () => ({ stress: [], usd: [], eur: [], rub: [], degraded: ['stress', 'usd', 'eur', 'rub'] }),
    fetchFred: async () => ({ results: { DGS10: { observations: [{ date: '2026-08-10', value: 4.1 }] } } }),
    fetchEuCurve: async () => ({ data: { rates: { '10Y': 2.5 } } }),
    fetchCalendar: async () => ({ events: [] }),
    fetchCot: async () => ({ reportDate: '2026-08-07', instruments: [] }),
    ...overrides,
  } as SnapshotDependencies;
}

describe('local browser market snapshot', () => {
  it('collects dashboard sources without credentials and preserves missing metadata', async () => {
    const snapshot = await collectLocalMarketSnapshot([], deps(), new Date('2026-08-11T00:00:00Z'));
    assert.equal(snapshot.domains.gold.quotes.status, 'available');
    assert.equal((snapshot.domains.gold.quotes.data as Array<{ price: number }>)[0]?.price, 2500);
    assert.equal(snapshot.domains.fx.dashboardQuotes.status, 'missing');
    assert.equal(snapshot.domains.gold.cot.observedAt, '2026-08-07');
    assert.equal(snapshot.domains.macroRates.fred.freshness, 'unknown');
  });

  it('records an individual source failure instead of fabricating a value', async () => {
    const snapshot = await collectLocalMarketSnapshot([], deps({
      fetchEuCurve: async () => { throw new Error('EU curve unavailable'); },
    }), new Date('2026-08-11T00:00:00Z'));
    assert.equal(snapshot.domains.macroRates.euYieldCurve.status, 'missing');
    assert.equal(snapshot.domains.macroRates.euYieldCurve.data, null);
    assert.equal(snapshot.domains.macroRates.euYieldCurve.error, 'EU curve unavailable');
  });

  it('embeds the no-score and no-fabrication contract in Markdown', async () => {
    const snapshot = await collectLocalMarketSnapshot([], deps(), new Date('2026-08-11T00:00:00Z'));
    const markdown = localMarketSnapshotToMarkdown(snapshot);
    assert.match(markdown, /predictive scores/);
    assert.match(markdown, /fabricated values/);
    assert.match(markdown, /"freshness": "unknown"/);
  });
});
