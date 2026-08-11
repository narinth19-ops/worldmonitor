import type { MarketData } from '@/types';
import type { FxPanelRows } from '@/services/economic';

const FRED_SERIES = ['DGS1MO', 'DGS3MO', 'DGS6MO', 'DGS1', 'DGS2', 'DGS5', 'DGS10', 'DGS30', 'FEDFUNDS'] as const;
const COMMODITIES = [
  { symbol: 'GC=F', name: 'Gold', display: 'Gold' },
  { symbol: 'SI=F', name: 'Silver', display: 'Silver' },
  { symbol: 'CL=F', name: 'WTI Crude', display: 'WTI' },
  { symbol: 'BZ=F', name: 'Brent Crude', display: 'Brent' },
  { symbol: 'HG=F', name: 'Copper', display: 'Copper' },
];

type SourceStatus = 'available' | 'partial' | 'missing';

export interface SnapshotSource<T = unknown> {
  status: SourceStatus;
  retrievedAt: string;
  observedAt: string | null;
  freshness: 'current' | 'stale' | 'unknown';
  error: string | null;
  data: T | null;
}

export interface LocalMarketSnapshot {
  schemaVersion: '1.0.0';
  generatedAt: string;
  purpose: 'current-market-assessment';
  caveat: string;
  analysisContract: {
    requiredSections: string[];
    prohibited: string[];
  };
  domains: {
    gold: Record<string, SnapshotSource>;
    fx: Record<string, SnapshotSource>;
    macroRates: Record<string, SnapshotSource>;
    commodities: Record<string, SnapshotSource>;
    crypto: Record<string, SnapshotSource>;
  };
}

export interface SnapshotDependencies {
  fetchCommodities: (commodities: typeof COMMODITIES) => Promise<{ data: MarketData[] }>;
  fetchCryptoData: () => Promise<unknown>;
  fetchFx: () => Promise<FxPanelRows>;
  fetchFred: () => Promise<unknown>;
  fetchEuCurve: () => Promise<unknown>;
  fetchCalendar: () => Promise<unknown>;
  fetchCot: () => Promise<unknown>;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function observedAt(value: unknown): string | null {
  const obj = record(value);
  if (!obj) return null;
  for (const key of ['reportDate', 'asOf', 'date', 'updatedAt', 'fetchedAt']) {
    const candidate = nonEmptyString(obj[key]);
    if (candidate) return candidate;
  }
  return null;
}

function available<T>(data: T, retrievedAt: string, status: SourceStatus = 'available'): SnapshotSource<T> {
  return { status, retrievedAt, observedAt: observedAt(data), freshness: 'unknown', error: null, data };
}

function missing(error: unknown, retrievedAt: string): SnapshotSource {
  return {
    status: 'missing', retrievedAt, observedAt: null, freshness: 'unknown',
    error: error instanceof Error ? error.message : String(error), data: null,
  };
}

async function settledSource<T>(promise: Promise<T>, retrievedAt: string): Promise<SnapshotSource<T>> {
  try {
    const value = await promise;
    return available(value, retrievedAt);
  } catch (error) {
    return missing(error, retrievedAt) as SnapshotSource<T>;
  }
}

async function defaultDependencies(): Promise<SnapshotDependencies> {
  const [{ getRpcBaseUrl }, { EconomicServiceClient, MarketServiceClient }, marketService, economicService] = await Promise.all([
    import('@/services/rpc-client'),
    import('@/services/generated-rpc-clients'),
    import('@/services/market'),
    import('@/services/economic'),
  ]);
  const baseUrl = getRpcBaseUrl();
  const economic = new EconomicServiceClient(baseUrl, { fetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args) });
  const market = new MarketServiceClient(baseUrl, { fetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args) });
  const today = new Date();
  const fromDate = today.toISOString().slice(0, 10);
  const toDate = new Date(today.getTime() + 30 * 86_400_000).toISOString().slice(0, 10);
  return {
    fetchCommodities: marketService.fetchCommodityQuotes,
    fetchCryptoData: marketService.fetchCrypto,
    fetchFx: economicService.getFxPanelData,
    fetchFred: () => economic.getFredSeriesBatch({ seriesIds: [...FRED_SERIES], limit: 36 }),
    fetchEuCurve: () => economic.getEuYieldCurve({}),
    fetchCalendar: () => economic.getEconomicCalendar({ fromDate, toDate }),
    fetchCot: () => market.getCotPositioning({}),
  };
}

export async function collectLocalMarketSnapshot(
  dashboardMarkets: MarketData[] = [],
  deps?: SnapshotDependencies,
  now = new Date(),
): Promise<LocalMarketSnapshot> {
  const sources = deps ?? await defaultDependencies();
  const retrievedAt = now.toISOString();
  const [commodities, crypto, fx, fred, euCurve, calendar, cot] = await Promise.all([
    settledSource(sources.fetchCommodities(COMMODITIES), retrievedAt),
    settledSource(sources.fetchCryptoData(), retrievedAt),
    settledSource(sources.fetchFx(), retrievedAt),
    settledSource(sources.fetchFred(), retrievedAt),
    settledSource(sources.fetchEuCurve(), retrievedAt),
    settledSource(sources.fetchCalendar(), retrievedAt),
    settledSource(sources.fetchCot(), retrievedAt),
  ]);
  const commodityData = commodities.data && record(commodities.data);
  const commodityQuotes = Array.isArray(commodityData?.data) ? commodityData.data as MarketData[] : [];
  const goldQuotes = commodityQuotes.filter((quote) => quote.symbol === 'GC=F');
  const dashboard = available(dashboardMarkets, retrievedAt, dashboardMarkets.length > 0 ? 'available' : 'missing');
  if (dashboardMarkets.length === 0) dashboard.error = 'Dashboard market cache was empty at export time';

  return {
    schemaVersion: '1.0.0',
    generatedAt: retrievedAt,
    purpose: 'current-market-assessment',
    caveat: 'Point-in-time browser observations only. Missing values are null and must not be inferred.',
    analysisContract: {
      requiredSections: ['observed facts', 'interpretation', 'bullish evidence', 'bearish evidence', 'neutral evidence', 'conflicting evidence', 'risks', 'missing or stale data', 'what to watch next'],
      prohibited: ['predictive scores', 'arbitrary weights', 'probabilities', 'fabricated values'],
    },
    domains: {
      gold: { quotes: available(goldQuotes, retrievedAt, goldQuotes.length ? 'available' : 'missing'), cot },
      fx: { dashboardQuotes: dashboard, panel: fx },
      macroRates: { fred, euYieldCurve: euCurve, economicCalendar: calendar },
      commodities: { quotes: commodities, cot },
      crypto: { quotes: crypto },
    },
  };
}

export function localMarketSnapshotToMarkdown(snapshot: LocalMarketSnapshot): string {
  const lines = [
    '# WorldMonitor Market Snapshot', '',
    `Generated: ${snapshot.generatedAt}`, '',
    `> ${snapshot.caveat}`, '',
    '## Analysis contract', '',
    `Required: ${snapshot.analysisContract.requiredSections.join('; ')}`, '',
    `Prohibited: ${snapshot.analysisContract.prohibited.join('; ')}`, '',
  ];
  for (const [name, domain] of Object.entries(snapshot.domains)) {
    lines.push(`## ${name}`, '', '```json', JSON.stringify(domain, null, 2), '```', '');
  }
  return `${lines.join('\n')}\n`;
}

function download(content: string, filename: string, type: string): void {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function downloadLocalMarketSnapshot(snapshot: LocalMarketSnapshot): void {
  const stamp = snapshot.generatedAt.replace(/[:.]/g, '-');
  const base = `worldmonitor-market-snapshot-${stamp}`;
  download(`${JSON.stringify(snapshot, null, 2)}\n`, `${base}.json`, 'application/json');
  download(localMarketSnapshotToMarkdown(snapshot), `${base}.md`, 'text/markdown;charset=utf-8');
}
