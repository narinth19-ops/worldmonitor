import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { sampleMacroEventReactions } from '../src/services/macro-reaction-sampler.ts';

const event = {
  event: 'CPI', country: 'US', date: '2026-08-12', impact: 'high', actual: '', estimate: '2.7', previous: '2.8',
  unit: '%', releaseTime: '08:30', timeZone: 'America/New_York',
};

describe('macro reaction sampler', () => {
  it('does not fetch live markets outside an event window', async () => {
    let marketFetches = 0;
    const sampled = await sampleMacroEventReactions(new Date('2026-08-12T10:00:00.000Z'), {
      fetchCalendar: async () => ({ events: [event] }),
      fetchGoldIntelligence: async () => {
        marketFetches++;
        return { goldPrice: 2500, unavailable: false, drivers: [] };
      },
    });
    assert.equal(sampled, false);
    assert.equal(marketFetches, 0);
  });

  it('persists gold, DXY and US 10Y during an event window', async () => {
    const memory = new Map<string, string>();
    const storage = {
      getItem: (key: string) => memory.get(key) ?? null,
      setItem: (key: string, value: string) => { memory.set(key, value); },
      removeItem: (key: string) => { memory.delete(key); },
      clear: () => { memory.clear(); },
      key: () => null,
      length: 0,
    };
    const sampled = await sampleMacroEventReactions(new Date('2026-08-12T12:20:00.000Z'), {
      fetchCalendar: async () => ({ events: [event] }),
      fetchGoldIntelligence: async () => ({
        goldPrice: 2500, unavailable: false,
        drivers: [{ symbol: 'DX-Y.NYB', value: 100 }, { symbol: '^TNX', value: 4.2 }],
      }),
      storage,
    });
    assert.equal(sampled, true);
    const stored = JSON.parse([...memory.values()][0] ?? '[]');
    assert.deepEqual(stored[0], { observedAt: '2026-08-12T12:20:00.000Z', gold: 2500, dxy: 100, us10y: 4.2 });
  });
});
