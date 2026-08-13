import { buildMacroEventContext, type MacroCalendarEvent } from '@/services/macro-event-context';
import { isMacroReactionSamplingWindow, persistReactionSample } from '@/services/macro-event-reactions';

const CALENDAR_CACHE_MS = 30 * 60_000;

interface CalendarResponse {
  events: MacroCalendarEvent[];
}

interface GoldResponse {
  goldPrice: number;
  unavailable: boolean;
  drivers: Array<{ symbol: string; value: number }>;
}

export interface MacroReactionSamplerDependencies {
  fetchCalendar(fromDate: string, toDate: string): Promise<CalendarResponse>;
  fetchGoldIntelligence(): Promise<GoldResponse>;
  storage?: Storage;
}

let calendarCache: { fetchedAt: number; events: MacroCalendarEvent[] } | null = null;

function dateAt(now: Date, dayOffset: number): string {
  return new Date(now.getTime() + dayOffset * 86_400_000).toISOString().slice(0, 10);
}

async function defaultDependencies(): Promise<MacroReactionSamplerDependencies> {
  const [{ EconomicServiceClient, MarketServiceClient }, { getRpcBaseUrl }] = await Promise.all([
    import('@/services/generated-rpc-clients'),
    import('@/services/rpc-client'),
  ]);
  const options = { fetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args) };
  const baseUrl = getRpcBaseUrl();
  const economic = new EconomicServiceClient(baseUrl, options);
  const market = new MarketServiceClient(baseUrl, options);
  return {
    fetchCalendar: (fromDate, toDate) => economic.getEconomicCalendar({ fromDate, toDate }),
    fetchGoldIntelligence: () => market.getGoldIntelligence({}),
    storage: typeof localStorage === 'undefined' ? undefined : localStorage,
  };
}

export async function sampleMacroEventReactions(
  now = new Date(),
  dependencies?: MacroReactionSamplerDependencies,
): Promise<boolean> {
  const deps = dependencies ?? await defaultDependencies();
  if (!calendarCache || now.getTime() - calendarCache.fetchedAt >= CALENDAR_CACHE_MS || dependencies) {
    const calendar = await deps.fetchCalendar(dateAt(now, -1), dateAt(now, 1));
    calendarCache = { fetchedAt: now.getTime(), events: calendar.events ?? [] };
  }
  const contexts = buildMacroEventContext(calendarCache.events, now);
  if (!isMacroReactionSamplingWindow(contexts, now)) return false;

  const gold = await deps.fetchGoldIntelligence();
  if (gold.unavailable) return false;
  const driverValue = (symbol: string) => {
    const value = gold.drivers.find((driver) => driver.symbol === symbol)?.value;
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  };
  persistReactionSample({
    observedAt: now.toISOString(),
    gold: Number.isFinite(gold.goldPrice) ? gold.goldPrice : null,
    dxy: driverValue('DX-Y.NYB'),
    us10y: driverValue('^TNX'),
  }, deps.storage);
  return true;
}
