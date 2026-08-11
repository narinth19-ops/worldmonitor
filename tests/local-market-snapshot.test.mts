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
    fetchGoldIntelligence: async () => ({ updatedAt: '2026-08-10T23:59:00Z', goldPrice: 2500, drivers: [], cbReserves: { totalTonnes: 0 }, goldSparkline: [1, 2] }),
    fetchHyperliquidFlow: async () => ({ fetchedAt: '2026-08-10T23:58:00Z', warmup: false, assets: [{ symbol: 'BTC', sparkFunding: [1] }] }),
    fetchEtfFlows: async () => ({ updatedAt: '2026-08-10T20:00:00Z', etfs: [] }),
    fetchStablecoins: async () => ({ updatedAt: '2026-08-10T23:30:00Z', stablecoins: [] }),
    fetchFearGreed: async () => ({ updatedAt: '2026-08-10T23:30:00Z', cnnFearGreed: 50, history: [1] }),
    fetchMarketBreadth: async () => ({ updatedAt: '2026-08-10T20:00:00Z', currentPctAbove50d: 55, history: [1] }),
    fetchMacroSignals: async () => ({ timestamp: '2026-08-10T23:30:00Z', verdict: 'NEUTRAL', signals: { liquidity: { status: 'normal', sparkline: [1] } } }),
    ...overrides,
  } as SnapshotDependencies;
}

describe('local browser market snapshot', () => {
  it('collects dashboard sources without credentials and preserves missing metadata', async () => {
    const snapshot = await collectLocalMarketSnapshot([], deps(), new Date('2026-08-11T00:00:00Z'));
    assert.equal(snapshot.domains.gold.quotes.status, 'available');
    assert.equal(snapshot.domains.gold.quotes.timestampBasis, 'retrieval-only');
    assert.equal(snapshot.domains.gold.quotes.observedAt, null);
    assert.equal((snapshot.domains.gold.quotes.data as Array<{ price: number }>)[0]?.price, 2500);
    assert.equal(snapshot.domains.fx.crossAssetDrivers.status, 'missing');
    assert.equal(snapshot.domains.gold.cot.observedAt, '2026-08-07');
    assert.equal(snapshot.domains.macroRates.fred.freshness, 'current');
    assert.equal(snapshot.domains.positioning.hyperliquid24x7.freshness, 'current');
    assert.equal(snapshot.domains.gold.intelligence.observedAt, '2026-08-10T23:59:00Z');
    assert.equal(snapshot.domains.gold.intelligence.timestampBasis, 'source');
    assert.equal((snapshot.domains.gold.intelligence.data as Record<string, unknown>).cbReserves, undefined);
    assert.equal((snapshot.domains.gold.intelligence.data as Record<string, unknown>).goldSparkline, undefined);
    assert.equal((snapshot.domains.sentimentLiquidity.fearGreed.data as Record<string, unknown>).history, undefined);
  });

  it('removes an inconsistent gold previous close instead of exporting a misleading value', async () => {
    const snapshot = await collectLocalMarketSnapshot([], deps({
      fetchGoldIntelligence: async () => ({
        updatedAt: '2026-08-10T23:59:00Z', goldPrice: 4418.9, goldChangePct: -0.02,
        session: { dayHigh: 4495, dayLow: 4416.8, prevClose: 3353.1 },
      }),
    }), new Date('2026-08-11T00:00:00Z'));
    const source = snapshot.domains.gold.intelligence;
    assert.equal(source.status, 'partial');
    assert.equal(source.quality, 'degraded');
    assert.deepEqual(source.missingFields, ['session.prevClose']);
    assert.equal((source.data as { session: { prevClose: number | null } }).session.prevClose, null);
    assert.match(source.error ?? '', /implied daily change/);
  });

  it('records an individual source failure instead of fabricating a value', async () => {
    const snapshot = await collectLocalMarketSnapshot([], deps({
      fetchEuCurve: async () => { throw new Error('EU curve unavailable'); },
    }), new Date('2026-08-11T00:00:00Z'));
    assert.equal(snapshot.domains.macroRates.euYieldCurve.status, 'missing');
    assert.equal(snapshot.domains.macroRates.euYieldCurve.data, null);
    assert.equal(snapshot.domains.macroRates.euYieldCurve.error, 'EU curve unavailable');
  });

  it('marks an aged source stale and degrades its quality', async () => {
    const snapshot = await collectLocalMarketSnapshot([], deps({
      fetchHyperliquidFlow: async () => ({ fetchedAt: '2026-08-10T20:00:00Z', warmup: false, assets: [] }),
    }), new Date('2026-08-11T00:00:00Z'));
    assert.equal(snapshot.domains.positioning.hyperliquid24x7.freshness, 'stale');
    assert.equal(snapshot.domains.positioning.hyperliquid24x7.quality, 'degraded');
  });

  it('embeds the no-score and no-fabrication contract in Markdown', async () => {
    const snapshot = await collectLocalMarketSnapshot([], deps(), new Date('2026-08-11T00:00:00Z'));
    const markdown = localMarketSnapshotToMarkdown(snapshot);
    assert.match(markdown, /predictive scores/);
    assert.match(markdown, /fabricated values/);
    assert.match(markdown, /"ageSeconds"/);
    assert.match(markdown, /"quality"/);
  });
});
