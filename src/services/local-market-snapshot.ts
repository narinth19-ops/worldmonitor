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
type Freshness = 'current' | 'stale' | 'unknown';
type TimestampBasis = 'source' | 'retrieval-only' | 'missing';

export interface SnapshotSource<T = unknown> {
  status: SourceStatus;
  source: string;
  retrievedAt: string;
  observedAt: string | null;
  timestampBasis: TimestampBasis;
  ageSeconds: number | null;
  freshness: Freshness;
  quality: 'good' | 'degraded' | 'unknown';
  missingFields: string[];
  error: string | null;
  data: T | null;
}

export interface LocalMarketSnapshot {
  schemaVersion: '1.1.0';
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
    positioning: Record<string, SnapshotSource>;
    sentimentLiquidity: Record<string, SnapshotSource>;
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
  fetchGoldIntelligence: () => Promise<unknown>;
  fetchHyperliquidFlow: () => Promise<unknown>;
  fetchEtfFlows: () => Promise<unknown>;
  fetchStablecoins: () => Promise<unknown>;
  fetchFearGreed: () => Promise<unknown>;
  fetchMarketBreadth: () => Promise<unknown>;
  fetchMacroSignals: () => Promise<unknown>;
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
  for (const key of ['reportDate', 'asOf', 'asOfDate', 'date', 'updatedAt', 'fetchedAt', 'timestamp', 'ts']) {
    const candidate = nonEmptyString(obj[key]);
    if (candidate) return candidate;
  }
  for (const key of ['data', 'summary', 'meta']) {
    const nested = observedAt(obj[key]);
    if (nested) return nested;
  }
  const results = record(obj.results);
  if (results) {
    const dates = Object.values(results).flatMap((entry) => {
      const observations = record(entry)?.observations;
      if (!Array.isArray(observations)) return [];
      return observations.map((item) => nonEmptyString(record(item)?.date)).filter((date): date is string => date !== null);
    });
    if (dates.length) {
      dates.sort();
      return dates[dates.length - 1] ?? null;
    }
  }
  return null;
}

interface SourceOptions {
  source: string;
  maxAgeSeconds?: number;
  missingFields?: string[];
  status?: SourceStatus;
  quality?: SnapshotSource['quality'];
}

function sourceMetadata(data: unknown, retrievedAt: string, maxAgeSeconds?: number): Pick<SnapshotSource, 'observedAt' | 'timestampBasis' | 'ageSeconds' | 'freshness'> {
  const timestamp = observedAt(data);
  if (!timestamp) return { observedAt: null, timestampBasis: 'retrieval-only', ageSeconds: null, freshness: 'unknown' };
  const observedMs = Date.parse(timestamp);
  const retrievedMs = Date.parse(retrievedAt);
  if (!Number.isFinite(observedMs) || !Number.isFinite(retrievedMs)) {
    return { observedAt: timestamp, timestampBasis: 'source', ageSeconds: null, freshness: 'unknown' };
  }
  const ageSeconds = Math.max(0, Math.floor((retrievedMs - observedMs) / 1000));
  const freshness: Freshness = maxAgeSeconds == null ? 'unknown' : ageSeconds <= maxAgeSeconds ? 'current' : 'stale';
  return { observedAt: timestamp, timestampBasis: 'source', ageSeconds, freshness };
}

function available<T>(data: T, retrievedAt: string, options: SourceOptions): SnapshotSource<T> {
  const missingFields = options.missingFields ?? [];
  const metadata = sourceMetadata(data, retrievedAt, options.maxAgeSeconds);
  return {
    status: options.status ?? (missingFields.length ? 'partial' : 'available'),
    source: options.source,
    retrievedAt,
    ...metadata,
    quality: options.quality ?? (missingFields.length || metadata.freshness === 'stale' ? 'degraded' : 'good'),
    missingFields,
    error: null,
    data,
  };
}

function missing(error: unknown, retrievedAt: string, source: string): SnapshotSource {
  return {
    status: 'missing', source, retrievedAt, observedAt: null, timestampBasis: 'missing', ageSeconds: null, freshness: 'unknown',
    quality: 'degraded', missingFields: [], error: error instanceof Error ? error.message : String(error), data: null,
  };
}

async function settledSource<T>(promise: Promise<T>, retrievedAt: string, options: SourceOptions): Promise<SnapshotSource<T>> {
  try {
    const value = await promise;
    return available(value, retrievedAt, options);
  } catch (error) {
    return missing(error, retrievedAt, options.source) as SnapshotSource<T>;
  }
}

function withoutHeavyFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutHeavyFields);
  const obj = record(value);
  if (!obj) return value;
  return Object.fromEntries(Object.entries(obj)
    .filter(([key]) => !['sparkline', 'goldSparkline', 'sparkline90d', 'sparkFunding', 'sparkOi', 'sparkScore', 'history'].includes(key))
    .map(([key, item]) => [key, withoutHeavyFields(item)]));
}

function compactGoldIntelligence(value: unknown): { data: unknown; invalidPrevClose: boolean } {
  const obj = record(value);
  if (!obj) return { data: value, invalidPrevClose: false };
  const { cbReserves: _ignoredCentralBanks, ...safe } = obj;
  const session = record(safe.session);
  const goldPrice = typeof safe.goldPrice === 'number' ? safe.goldPrice : null;
  const goldChangePct = typeof safe.goldChangePct === 'number' ? safe.goldChangePct : null;
  const prevClose = typeof session?.prevClose === 'number' ? session.prevClose : null;
  const impliedChangePct = goldPrice != null && prevClose != null && prevClose > 0
    ? ((goldPrice - prevClose) / prevClose) * 100
    : null;
  const invalidPrevClose = impliedChangePct != null && goldChangePct != null
    && Math.abs(impliedChangePct - goldChangePct) > 0.5;
  if (invalidPrevClose && session) safe.session = { ...session, prevClose: null };
  return { data: withoutHeavyFields(safe), invalidPrevClose };
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
    fetchGoldIntelligence: () => market.getGoldIntelligence({}),
    fetchHyperliquidFlow: () => market.getHyperliquidFlow({}),
    fetchEtfFlows: () => market.listEtfFlows({}),
    fetchStablecoins: () => market.listStablecoinMarkets({ coins: [] }),
    fetchFearGreed: () => market.getFearGreedIndex({}),
    fetchMarketBreadth: () => market.getMarketBreadthHistory({}),
    fetchMacroSignals: () => economic.getMacroSignals({}),
  };
}

export async function collectLocalMarketSnapshot(
  dashboardMarkets: MarketData[] = [],
  deps?: SnapshotDependencies,
  now = new Date(),
): Promise<LocalMarketSnapshot> {
  const sources = deps ?? await defaultDependencies();
  const retrievedAt = now.toISOString();
  const [commodities, crypto, fx, fred, euCurve, calendar, cot, goldIntelligenceRaw, hyperliquidRaw, etfFlowsRaw, stablecoinsRaw, fearGreedRaw, marketBreadthRaw, macroSignalsRaw] = await Promise.all([
    settledSource(sources.fetchCommodities(COMMODITIES), retrievedAt, { source: 'market quotes' }),
    settledSource(sources.fetchCryptoData(), retrievedAt, { source: 'crypto markets' }),
    settledSource(sources.fetchFx(), retrievedAt, { source: 'ECB/market FX panel', maxAgeSeconds: 172_800 }),
    settledSource(sources.fetchFred(), retrievedAt, { source: 'FRED', maxAgeSeconds: 432_000 }),
    settledSource(sources.fetchEuCurve(), retrievedAt, { source: 'ECB AAA yield curve', maxAgeSeconds: 432_000 }),
    settledSource(sources.fetchCalendar(), retrievedAt, { source: 'economic calendar' }),
    settledSource(sources.fetchCot(), retrievedAt, { source: 'CFTC COT', maxAgeSeconds: 864_000 }),
    settledSource(sources.fetchGoldIntelligence(), retrievedAt, { source: 'gold intelligence', maxAgeSeconds: 172_800 }),
    settledSource(sources.fetchHyperliquidFlow(), retrievedAt, { source: 'Hyperliquid 24/7 positioning', maxAgeSeconds: 900 }),
    settledSource(sources.fetchEtfFlows(), retrievedAt, { source: 'ETF flows', maxAgeSeconds: 172_800 }),
    settledSource(sources.fetchStablecoins(), retrievedAt, { source: 'stablecoin markets', maxAgeSeconds: 7_200 }),
    settledSource(sources.fetchFearGreed(), retrievedAt, { source: 'fear and greed', maxAgeSeconds: 7_200 }),
    settledSource(sources.fetchMarketBreadth(), retrievedAt, { source: 'market breadth', maxAgeSeconds: 172_800 }),
    settledSource(sources.fetchMacroSignals(), retrievedAt, { source: 'macro signals', maxAgeSeconds: 7_200 }),
  ]);
  const commodityData = commodities.data && record(commodities.data);
  const commodityQuotes = Array.isArray(commodityData?.data) ? commodityData.data as MarketData[] : [];
  const goldQuotes = commodityQuotes.filter((quote) => quote.symbol === 'GC=F');
  const compactDashboard = dashboardMarkets
    .filter((quote) => ['DX-Y.NYB', '^TNX', '^GSPC', 'GC=F', 'BTC-USD'].includes(quote.symbol))
    .map(({ sparkline: _sparkline, ...quote }) => quote);
  const dashboard = available(compactDashboard, retrievedAt, {
    source: 'dashboard cross-asset cache',
    status: compactDashboard.length > 0 ? 'available' : 'missing',
    quality: compactDashboard.length > 0 ? 'good' : 'degraded',
  });
  if (dashboardMarkets.length === 0) dashboard.error = 'Dashboard market cache was empty at export time';

  const compact = (source: SnapshotSource, transform: (value: unknown) => unknown = withoutHeavyFields): SnapshotSource => (
    source.data == null ? source : { ...source, data: transform(source.data) }
  );
  const compactGold = goldIntelligenceRaw.data == null
    ? { data: null, invalidPrevClose: false }
    : compactGoldIntelligence(goldIntelligenceRaw.data);
  const goldIntelligence: SnapshotSource = {
    ...goldIntelligenceRaw,
    data: compactGold.data,
    ...(compactGold.invalidPrevClose ? {
      status: 'partial' as const,
      quality: 'degraded' as const,
      missingFields: [...goldIntelligenceRaw.missingFields, 'session.prevClose'],
      error: 'session.prevClose was removed because its implied daily change conflicts with goldChangePct',
    } : {}),
  };
  const hyperliquid = compact(hyperliquidRaw);
  const etfFlows = compact(etfFlowsRaw);
  const stablecoins = compact(stablecoinsRaw);
  const fearGreed = compact(fearGreedRaw);
  const marketBreadth = compact(marketBreadthRaw);
  const macroSignals = compact(macroSignalsRaw);

  return {
    schemaVersion: '1.1.0',
    generatedAt: retrievedAt,
    purpose: 'current-market-assessment',
    caveat: 'Point-in-time browser observations only. Missing values are null and must not be inferred.',
    analysisContract: {
      requiredSections: ['observed facts', 'interpretation', 'bullish evidence', 'bearish evidence', 'neutral evidence', 'conflicting evidence', 'risks', 'missing or stale data', 'what to watch next'],
      prohibited: ['predictive scores', 'arbitrary weights', 'probabilities', 'fabricated values'],
    },
    domains: {
      gold: {
        quotes: available(goldQuotes.map(({ sparkline: _sparkline, ...quote }) => quote), retrievedAt, {
          source: 'market quotes', status: goldQuotes.length ? 'available' : 'missing', quality: goldQuotes.length ? 'good' : 'degraded',
        }),
        intelligence: goldIntelligence,
        cot,
      },
      fx: { crossAssetDrivers: dashboard, panel: compact(fx) },
      macroRates: { fred: compact(fred), euYieldCurve: compact(euCurve), economicCalendar: compact(calendar), macroSignals },
      positioning: { hyperliquid24x7: hyperliquid, cot },
      sentimentLiquidity: { fearGreed, marketBreadth, etfFlows, stablecoins },
      commodities: { quotes: compact(commodities), cot },
      crypto: { quotes: compact(crypto), etfFlows, stablecoins, macroSignals },
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
