import type { MacroEventContext } from '@/services/macro-event-context';

const STORAGE_KEY = 'wm:macro-event-reaction-samples:v1';
const MAX_AGE_MS = 14 * 86_400_000;
const MAX_SAMPLES = 256;
const BASELINE_WINDOW_MS = 60 * 60_000;
const REACTION_TOLERANCE_MS = 3 * 60_000;

export const REACTION_WINDOWS_MINUTES = [5, 15, 30, 60] as const;

export interface ReactionMarketSample {
  observedAt: string;
  gold: number | null;
  dxy: number | null;
  us10y: number | null;
}

export interface MacroEventReaction {
  eventId: string;
  releaseAt: string;
  status: 'awaiting-release' | 'insufficient-data' | 'observed';
  baselineObservedAt: string | null;
  reactionObservedAt: string | null;
  elapsedMinutes: number | null;
  goldChangePct: number | null;
  dxyChangePct: number | null;
  us10yChangeBp: number | null;
  windows: MacroEventReactionWindow[];
}

export interface MacroEventReactionWindow {
  minutes: typeof REACTION_WINDOWS_MINUTES[number];
  observedAt: string | null;
  goldChangePct: number | null;
  dxyChangePct: number | null;
  us10yChangeBp: number | null;
}

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function validSample(value: unknown): ReactionMarketSample | null {
  if (!value || typeof value !== 'object') return null;
  const sample = value as Record<string, unknown>;
  if (typeof sample.observedAt !== 'string' || !Number.isFinite(Date.parse(sample.observedAt))) return null;
  return {
    observedAt: sample.observedAt,
    gold: finite(sample.gold), dxy: finite(sample.dxy), us10y: finite(sample.us10y),
  };
}

export function readReactionSamples(storage?: StorageLike): ReactionMarketSample[] {
  if (!storage) return [];
  try {
    const parsed = JSON.parse(storage.getItem(STORAGE_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.map(validSample).filter((sample): sample is ReactionMarketSample => sample !== null) : [];
  } catch {
    return [];
  }
}

export function persistReactionSample(sample: ReactionMarketSample, storage?: StorageLike): ReactionMarketSample[] {
  const nowMs = Date.parse(sample.observedAt);
  const samples = [...readReactionSamples(storage), sample]
    .filter((item) => nowMs - Date.parse(item.observedAt) <= MAX_AGE_MS)
    .sort((a, b) => a.observedAt.localeCompare(b.observedAt))
    .slice(-MAX_SAMPLES);
  if (storage) {
    try { storage.setItem(STORAGE_KEY, JSON.stringify(samples)); } catch { /* private mode / quota */ }
  }
  return samples;
}

function pct(after: number | null, before: number | null): number | null {
  return after != null && before != null && before !== 0 ? ((after - before) / before) * 100 : null;
}

function changes(
  baseline: ReactionMarketSample,
  reaction: ReactionMarketSample,
): Pick<MacroEventReactionWindow, 'goldChangePct' | 'dxyChangePct' | 'us10yChangeBp'> {
  return {
    goldChangePct: pct(reaction.gold, baseline.gold),
    dxyChangePct: pct(reaction.dxy, baseline.dxy),
    us10yChangeBp: reaction.us10y != null && baseline.us10y != null
      ? (reaction.us10y - baseline.us10y) * 100
      : null,
  };
}

export function isMacroReactionSamplingWindow(
  events: readonly MacroEventContext[],
  now = new Date(),
): boolean {
  const nowMs = now.getTime();
  return events.some((event) => {
    if (!event.releaseAt) return false;
    const releaseMs = Date.parse(event.releaseAt);
    return nowMs >= releaseMs - BASELINE_WINDOW_MS && nowMs <= releaseMs + 120 * 60_000;
  });
}

export function buildMacroEventReactions(
  events: readonly MacroEventContext[],
  samples: readonly ReactionMarketSample[],
  now = new Date(),
): MacroEventReaction[] {
  const nowMs = now.getTime();
  return events.filter((event) => event.releaseAt).map((event) => {
    const releaseMs = Date.parse(event.releaseAt!);
    const baseline = [...samples].reverse().find((sample) => {
      const ts = Date.parse(sample.observedAt);
      return ts < releaseMs && releaseMs - ts <= BASELINE_WINDOW_MS;
    }) ?? null;
    const reaction = samples.find((sample) => Date.parse(sample.observedAt) >= releaseMs) ?? null;
    if (nowMs < releaseMs) return emptyReaction(event.id, event.releaseAt!, 'awaiting-release', baseline, null);
    if (!baseline || !reaction) return emptyReaction(event.id, event.releaseAt!, 'insufficient-data', baseline, reaction);
    const windows = REACTION_WINDOWS_MINUTES.map((minutes): MacroEventReactionWindow => {
      const targetMs = releaseMs + minutes * 60_000;
      const observed = samples
        .filter((sample) => Date.parse(sample.observedAt) >= releaseMs)
        .map((sample) => ({ sample, distance: Math.abs(Date.parse(sample.observedAt) - targetMs) }))
        .filter(({ distance }) => distance <= REACTION_TOLERANCE_MS)
        .sort((a, b) => a.distance - b.distance)[0]?.sample ?? null;
      return {
        minutes,
        observedAt: observed?.observedAt ?? null,
        ...(observed ? changes(baseline, observed) : {
          goldChangePct: null, dxyChangePct: null, us10yChangeBp: null,
        }),
      };
    });
    return {
      eventId: event.id, releaseAt: event.releaseAt!, status: 'observed',
      baselineObservedAt: baseline.observedAt, reactionObservedAt: reaction.observedAt,
      elapsedMinutes: Math.round((Date.parse(reaction.observedAt) - releaseMs) / 60_000),
      ...changes(baseline, reaction),
      windows,
    };
  });
}

function emptyReaction(
  eventId: string, releaseAt: string, status: MacroEventReaction['status'],
  baseline: ReactionMarketSample | null, reaction: ReactionMarketSample | null,
): MacroEventReaction {
  return {
    eventId, releaseAt, status,
    baselineObservedAt: baseline?.observedAt ?? null,
    reactionObservedAt: reaction?.observedAt ?? null,
    elapsedMinutes: null, goldChangePct: null, dxyChangePct: null, us10yChangeBp: null,
    windows: REACTION_WINDOWS_MINUTES.map((minutes) => ({
      minutes, observedAt: null, goldChangePct: null, dxyChangePct: null, us10yChangeBp: null,
    })),
  };
}
