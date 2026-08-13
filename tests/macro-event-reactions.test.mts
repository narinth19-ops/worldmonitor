import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildMacroEventReactions, isMacroReactionSamplingWindow, persistReactionSample, readReactionSamples } from '../src/services/macro-event-reactions.ts';
import type { MacroEventContext } from '../src/services/macro-event-context.ts';

const event: MacroEventContext = {
  id: 'us-cpi:2026-08-12', event: 'CPI', category: 'inflation', date: '2026-08-12',
  releaseTime: '08:30', timeZone: 'America/New_York', releaseAt: '2026-08-12T12:30:00.000Z',
  status: 'released', importance: 'high', previous: '0.2', consensus: null, actual: '0.3', unit: '%',
  affectedMarkets: ['gold', 'dxy', 'treasury'], hotterOrStronger: 'headwind', coolerOrWeaker: 'tailwind',
};

describe('macro event reactions', () => {
  it('calculates observable market changes from the nearest pre/post samples', () => {
    const reactions = buildMacroEventReactions([event], [
      { observedAt: '2026-08-12T12:20:00.000Z', gold: 2500, dxy: 100, us10y: 4.2 },
      { observedAt: '2026-08-12T12:35:00.000Z', gold: 2475, dxy: 100.5, us10y: 4.28 },
    ], new Date('2026-08-12T12:45:00.000Z'));
    assert.equal(reactions[0]?.status, 'observed');
    assert.equal(reactions[0]?.elapsedMinutes, 5);
    assert.equal(reactions[0]?.goldChangePct, -1);
    assert.equal(reactions[0]?.dxyChangePct, 0.5);
    assert.ok(Math.abs((reactions[0]?.us10yChangeBp ?? 0) - 8) < 1e-9);
    assert.equal(reactions[0]?.windows[0]?.minutes, 5);
    assert.equal(reactions[0]?.windows[0]?.observedAt, '2026-08-12T12:35:00.000Z');
  });

  it('limits collection to one hour before and two hours after release', () => {
    assert.equal(isMacroReactionSamplingWindow([event], new Date('2026-08-12T11:29:59.000Z')), false);
    assert.equal(isMacroReactionSamplingWindow([event], new Date('2026-08-12T11:30:00.000Z')), true);
    assert.equal(isMacroReactionSamplingWindow([event], new Date('2026-08-12T14:30:00.000Z')), true);
    assert.equal(isMacroReactionSamplingWindow([event], new Date('2026-08-12T14:30:01.000Z')), false);
  });

  it('reports insufficient data instead of estimating a missing baseline', () => {
    const [reaction] = buildMacroEventReactions([event], [
      { observedAt: '2026-08-12T12:40:00.000Z', gold: 2475, dxy: 100.5, us10y: 4.28 },
    ], new Date('2026-08-12T12:45:00.000Z'));
    assert.equal(reaction?.status, 'insufficient-data');
    assert.equal(reaction?.goldChangePct, null);
  });

  it('validates persisted samples and tolerates unavailable storage', () => {
    const memory = new Map<string, string>();
    const storage = {
      getItem: (key: string) => memory.get(key) ?? null,
      setItem: (key: string, value: string) => { memory.set(key, value); },
    };
    persistReactionSample({ observedAt: '2026-08-12T12:20:00.000Z', gold: 2500, dxy: null, us10y: 4.2 }, storage);
    assert.equal(readReactionSamples(storage).length, 1);
    assert.deepEqual(readReactionSamples(undefined), []);
  });
});
