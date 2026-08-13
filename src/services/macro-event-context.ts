export type MacroEventCategory = 'inflation' | 'labour' | 'monetary-policy' | 'other';

export interface MacroCalendarEvent {
  event: string;
  country?: string;
  date: string;
  impact?: string;
  actual?: string;
  estimate?: string;
  previous?: string;
  unit?: string;
  releaseTime?: string;
  timeZone?: string;
}

export interface MacroEventContext {
  id: string;
  event: string;
  category: MacroEventCategory;
  date: string;
  releaseTime: string | null;
  timeZone: string | null;
  releaseAt: string | null;
  status: 'upcoming' | 'released';
  importance: 'high' | 'medium' | 'low';
  previous: string | null;
  consensus: string | null;
  actual: string | null;
  unit: string | null;
  affectedMarkets: readonly string[];
  hotterOrStronger: string;
  coolerOrWeaker: string;
}

interface EventRule {
  aliases: readonly RegExp[];
  id: string;
  category: MacroEventCategory;
  affectedMarkets: readonly string[];
  hotterOrStronger: string;
  coolerOrWeaker: string;
}

const RULES: readonly EventRule[] = [
  {
    aliases: [/^core cpi$/i], id: 'us-core-cpi', category: 'inflation',
    affectedMarkets: ['gold', 'dxy', 'treasury'],
    hotterOrStronger: 'Gold headwind; upside risk for DXY and Treasury yields.',
    coolerOrWeaker: 'Gold tailwind; downside risk for DXY and Treasury yields.',
  },
  {
    aliases: [/^cpi$/i, /^us cpi$/i], id: 'us-cpi', category: 'inflation',
    affectedMarkets: ['gold', 'dxy', 'treasury'],
    hotterOrStronger: 'Gold headwind; upside risk for DXY and Treasury yields.',
    coolerOrWeaker: 'Gold tailwind; downside risk for DXY and Treasury yields.',
  },
  {
    aliases: [/^core ppi$/i], id: 'us-core-ppi', category: 'inflation',
    affectedMarkets: ['gold', 'dxy', 'treasury'],
    hotterOrStronger: 'Gold headwind through firmer inflation and rate expectations.',
    coolerOrWeaker: 'Gold tailwind through softer inflation and rate expectations.',
  },
  {
    aliases: [/^ppi$/i, /^producer price/i], id: 'us-ppi', category: 'inflation',
    affectedMarkets: ['gold', 'dxy', 'treasury'],
    hotterOrStronger: 'Gold headwind through firmer inflation and rate expectations.',
    coolerOrWeaker: 'Gold tailwind through softer inflation and rate expectations.',
  },
  {
    aliases: [/nonfarm payroll/i, /^nfp$/i], id: 'us-nfp', category: 'labour',
    affectedMarkets: ['gold', 'dxy', 'treasury'],
    hotterOrStronger: 'Gold headwind if stronger hiring lifts DXY and Treasury yields.',
    coolerOrWeaker: 'Gold tailwind if weaker hiring lowers DXY and Treasury yields.',
  },
  {
    aliases: [/unemployment rate/i], id: 'us-unemployment-rate', category: 'labour',
    affectedMarkets: ['gold', 'dxy', 'treasury'],
    hotterOrStronger: 'A lower-than-expected rate can be a gold headwind via tighter policy expectations.',
    coolerOrWeaker: 'A higher-than-expected rate can support gold via easier policy expectations.',
  },
  {
    aliases: [/fomc/i, /fed rate decision/i], id: 'us-fomc', category: 'monetary-policy',
    affectedMarkets: ['gold', 'dxy', 'treasury'],
    hotterOrStronger: 'A more hawkish decision or guidance is a gold headwind.',
    coolerOrWeaker: 'A more dovish decision or guidance is a gold tailwind.',
  },
];

function valueOrNull(value: string | undefined): string | null {
  return value && value.trim() ? value.trim() : null;
}

function ruleFor(event: MacroCalendarEvent): EventRule | null {
  if (event.country && event.country !== 'US') return null;
  return RULES.find((rule) => rule.aliases.some((alias) => alias.test(event.event))) ?? null;
}

export function macroEventReleaseInstant(event: MacroCalendarEvent): Date | null {
  if (!event.releaseTime || !event.timeZone || !/^\d{2}:\d{2}$/.test(event.releaseTime)) return null;
  const wallClockAsUtc = Date.parse(`${event.date}T${event.releaseTime}:00Z`);
  if (!Number.isFinite(wallClockAsUtc)) return null;
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: event.timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    });
    const offsetAt = (instant: number) => {
      const parts = Object.fromEntries(formatter.formatToParts(new Date(instant)).map(part => [part.type, part.value]));
      const representedAsUtc = Date.UTC(
        Number(parts.year), Number(parts.month) - 1, Number(parts.day),
        Number(parts.hour), Number(parts.minute), Number(parts.second),
      );
      return representedAsUtc - instant;
    };
    let instant = wallClockAsUtc - offsetAt(wallClockAsUtc);
    instant = wallClockAsUtc - offsetAt(instant);
    return new Date(instant);
  } catch {
    return null;
  }
}

export function buildMacroEventContext(
  events: readonly MacroCalendarEvent[],
  now = new Date(),
): MacroEventContext[] {
  const today = now.toISOString().slice(0, 10);
  return events.flatMap<MacroEventContext>((event) => {
    const rule = ruleFor(event);
    if (!rule || !event.date) return [];
    const releaseInstant = macroEventReleaseInstant(event);
    return [{
      id: `${rule.id}:${event.date}`,
      event: event.event,
      category: rule.category,
      date: event.date,
      releaseTime: valueOrNull(event.releaseTime),
      timeZone: valueOrNull(event.timeZone),
      releaseAt: releaseInstant?.toISOString() ?? null,
      status: valueOrNull(event.actual) ? 'released' : 'upcoming',
      importance: event.impact === 'medium' ? 'medium' : event.impact === 'low' ? 'low' : 'high',
      previous: valueOrNull(event.previous),
      consensus: valueOrNull(event.estimate),
      actual: valueOrNull(event.actual),
      unit: valueOrNull(event.unit),
      affectedMarkets: rule.affectedMarkets,
      hotterOrStronger: rule.hotterOrStronger,
      coolerOrWeaker: rule.coolerOrWeaker,
    }];
  }).filter((event) => event.status === 'released' || event.date >= today)
    .sort((a, b) => (a.releaseAt ?? a.date).localeCompare(b.releaseAt ?? b.date));
}
