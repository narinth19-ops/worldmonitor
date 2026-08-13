import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildMacroEventContext, macroEventReleaseInstant } from '../src/services/macro-event-context.ts';
import { buildGoldContext, buildMacroEvents } from '../server/worldmonitor/intelligence/v1/chat-analyst-context.ts';

describe('macro event context', () => {
  it('converts official New York release time to UTC across daylight saving time', () => {
    assert.equal(macroEventReleaseInstant({
      event: 'CPI', date: '2026-08-12', releaseTime: '08:30', timeZone: 'America/New_York',
    })?.toISOString(), '2026-08-12T12:30:00.000Z');
    assert.equal(macroEventReleaseInstant({
      event: 'CPI', date: '2026-01-13', releaseTime: '08:30', timeZone: 'America/New_York',
    })?.toISOString(), '2026-01-13T13:30:00.000Z');
  });

  it('keeps only Tier 1 US events and never invents consensus', () => {
    const events = buildMacroEventContext([
      { event: 'CPI', country: 'US', date: '2026-08-14', impact: 'high', previous: '2.8', estimate: '' },
      { event: 'GDP', country: 'US', date: '2026-08-15', impact: 'high' },
      { event: 'EU HICP (CPI)', country: 'EU', date: '2026-08-16', impact: 'high' },
    ], new Date('2026-08-13T00:00:00Z'));

    assert.equal(events.length, 1);
    assert.equal(events[0]?.id, 'us-cpi:2026-08-14');
    assert.equal(events[0]?.previous, '2.8');
    assert.equal(events[0]?.consensus, null);
    assert.match(events[0]?.hotterOrStronger ?? '', /Gold headwind/);
  });

  it('marks an event released only when an actual is present', () => {
    const [event] = buildMacroEventContext([
      { event: 'Nonfarm Payrolls', country: 'US', date: '2026-08-13', actual: '+120', estimate: '+100', unit: 'K', releaseTime: '08:30', timeZone: 'America/New_York' },
    ], new Date('2026-08-13T12:00:00Z'));
    assert.equal(event?.status, 'released');
    assert.equal(event?.consensus, '+100');
    assert.equal(event?.actual, '+120');
    assert.equal(event?.releaseAt, '2026-08-13T12:30:00.000Z');
  });

  it('formats a bounded analyst block with explicit missing consensus', () => {
    const block = buildMacroEvents({
      events: [{ event: 'FOMC Rate Decision', country: 'US', date: '2099-01-01', impact: 'high' }],
    });
    assert.match(block, /Tier 1 US Macro Events/);
    assert.match(block, /consensus unavailable/);
    assert.match(block, /hawkish/);
  });

  it('assembles the gold, DXY, yield, COT and ETF facts used around an event', () => {
    const block = buildGoldContext(
      { quotes: [{ symbol: 'GC=F', price: 2500, change: 0.4 }] },
      { drivers: [{ symbol: 'DX-Y.NYB', value: 101.2, changePct: -0.2 }, { symbol: '^TNX', value: 4.3, changePct: 0.1 }] },
      { instruments: [{ code: 'GC', reportDate: '2026-08-07', managedMoney: { netPct: 72.5 } }] },
      { tonnes: 900, changeW1Tonnes: 3.2, changeM1Tonnes: 8.4 },
    );
    assert.match(block, /Gold: \$2500\.00/);
    assert.match(block, /DXY: 101\.20/);
    assert.match(block, /US 10Y yield: 4\.30/);
    assert.match(block, /72\.5%/);
    assert.match(block, /1M \+8\.40t/);
  });
});
