#!/usr/bin/env node

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const MCP_URL = 'https://worldmonitor.app/mcp';
const OPENAI_URL = 'https://api.openai.com/v1/responses';
const DEFAULT_MODEL = 'gpt-5.6-terra';
const DEFAULT_OUTPUT_DIR = '.local/market-analysis';
const MARKET_SYMBOLS = [
  'GC=F', 'SI=F', 'CL=F', 'BZ=F', 'HG=F',
  'DX-Y.NYB', 'EURUSD=X', 'GBPUSD=X', 'JPY=X', 'AUDUSD=X',
  'BTC-USD', 'ETH-USD',
];
const ECONOMIC_DATASETS = [
  'fedfunds', 'yield-curve-eu', 'ecb-fx-rates', 'cbr-rates',
  'cot', 'econ-calendar',
];

const DOMAINS = ['gold', 'fx', 'macroRates', 'commodities', 'crypto'];

export function parseSseOrJson(text, contentType = '') {
  let payload = text;
  if (contentType.includes('text/event-stream') || /^(event|data):/m.test(text)) {
    const lines = text.split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .filter((line) => line && line !== '[DONE]');
    payload = lines.at(-1) || '';
  }
  if (!payload) return null;
  return JSON.parse(payload);
}

export function unwrapMcpResult(value) {
  if (value?.error) throw new Error(value.error.message || 'WorldMonitor MCP request failed');
  const result = value?.result ?? value;
  if (result?.isError) {
    const message = result.content?.find((item) => item.type === 'text')?.text;
    throw new Error(message || 'WorldMonitor MCP tool returned an error');
  }
  if (result?.structuredContent) return result.structuredContent;
  const text = result?.content?.find((item) => item.type === 'text')?.text;
  if (text) return JSON.parse(text);
  return result;
}

function freshness(envelope, now) {
  const timestamp = envelope?.cached_at ?? envelope?.cachedAt ?? null;
  const parsed = timestamp == null ? Number.NaN : Date.parse(timestamp);
  return {
    observedAt: Number.isFinite(parsed) ? new Date(parsed).toISOString() : null,
    ageSeconds: Number.isFinite(parsed) ? Math.max(0, Math.round((now.getTime() - parsed) / 1000)) : null,
    stale: typeof envelope?.stale === 'boolean' ? envelope.stale : null,
    quality: envelope == null ? 'missing' : (envelope.stale === true ? 'stale' : (Number.isFinite(parsed) ? 'available' : 'unknown')),
  };
}

function marketQuotes(data) {
  return [
    ...(data?.['stocks-bootstrap']?.quotes ?? []),
    ...(data?.['commodities-bootstrap']?.quotes ?? []),
    ...(data?.crypto?.quotes ?? []),
  ];
}

function bySymbols(quotes, symbols) {
  const wanted = new Set(symbols.map((symbol) => symbol.toUpperCase()));
  return quotes.filter((quote) => wanted.has(String(quote?.symbol ?? '').toUpperCase()));
}

function section(data, sources) {
  const missing = data == null || (Array.isArray(data) && data.length === 0);
  const freshnessValues = Object.values(sources);
  const stale = freshnessValues.some((value) => value.stale === true);
  return {
    status: missing ? 'missing' : (stale ? 'stale' : 'available'),
    sources,
    data: missing ? null : data,
  };
}

export function buildSnapshot({ market, economic, generatedAt = new Date() }) {
  const marketData = market?.data ?? null;
  const economicData = economic?.data ?? null;
  const quotes = marketQuotes(marketData);
  const mf = freshness(market, generatedAt);
  const ef = freshness(economic, generatedAt);
  return {
    schemaVersion: '1.0.0',
    generatedAt: generatedAt.toISOString(),
    purpose: 'current-market-assessment',
    caveat: 'Point-in-time observations only. Missing values are null and must not be inferred.',
    sources: {
      market: { provider: 'WorldMonitor MCP/get_market_data', ...mf },
      economic: { provider: 'WorldMonitor MCP/get_economic_data', ...ef },
    },
    domains: {
      gold: section({
        quotes: bySymbols(quotes, ['GC=F']),
        cot: economicData?.cot ?? null,
      }, { market: mf, economic: ef }),
      fx: section({
        quotes: bySymbols(quotes, ['DX-Y.NYB', 'EURUSD=X', 'GBPUSD=X', 'JPY=X', 'AUDUSD=X']),
        ecbRates: economicData?.['ecb-fx-rates'] ?? null,
        cbrRates: economicData?.['cbr-rates'] ?? null,
      }, { market: mf, economic: ef }),
      macroRates: section({
        fedFunds: economicData?.FEDFUNDS ?? null,
        euYieldCurve: economicData?.['yield-curve-eu'] ?? null,
        economicCalendar: economicData?.['econ-calendar'] ?? null,
      }, { economic: ef }),
      commodities: section({
        quotes: bySymbols(quotes, ['GC=F', 'SI=F', 'CL=F', 'BZ=F', 'HG=F']),
        cot: economicData?.cot ?? null,
      }, { market: mf, economic: ef }),
      crypto: section({
        quotes: bySymbols(quotes, ['BTC-USD', 'ETH-USD']),
      }, { market: mf }),
    },
  };
}

export function snapshotToMarkdown(snapshot) {
  const lines = [
    '# Market Snapshot', '',
    `Generated: ${snapshot.generatedAt}`, '',
    '> Point-in-time observations only. Missing values are shown as null and are not inferred.', '',
  ];
  for (const [name, domain] of Object.entries(snapshot.domains)) {
    lines.push(`## ${name}`, '', `Status: ${domain.status}`, '', '```json', JSON.stringify(domain, null, 2), '```', '');
  }
  return `${lines.join('\n')}\n`;
}

function domainSchema() {
  const list = { type: 'array', items: { type: 'string' } };
  return {
    type: 'object', additionalProperties: false,
    properties: {
      assessment: { type: 'string', enum: ['bullish', 'bearish', 'neutral', 'mixed', 'insufficient-data'] },
      observedFacts: list,
      interpretation: list,
      bullishEvidence: list,
      bearishEvidence: list,
      neutralEvidence: list,
      conflictingEvidence: list,
      risks: list,
      missingOrStaleData: list,
      whatToWatchNext: list,
    },
    required: ['assessment', 'observedFacts', 'interpretation', 'bullishEvidence', 'bearishEvidence', 'neutralEvidence', 'conflictingEvidence', 'risks', 'missingOrStaleData', 'whatToWatchNext'],
  };
}

export function analysisSchema() {
  return {
    type: 'object', additionalProperties: false,
    properties: {
      summary: { type: 'array', items: { type: 'string' } },
      dataQualitySummary: { type: 'array', items: { type: 'string' } },
      domains: {
        type: 'object', additionalProperties: false,
        properties: Object.fromEntries(DOMAINS.map((name) => [name, domainSchema()])),
        required: DOMAINS,
      },
    },
    required: ['summary', 'dataQualitySummary', 'domains'],
  };
}

export function buildAnalysisRequest(snapshot, model = DEFAULT_MODEL) {
  return {
    model,
    instructions: [
      'Produce a current market assessment from only the supplied snapshot.',
      'Separate observed facts from interpretation. Never invent, interpolate, or silently repair missing values.',
      'Treat stale and unknown-freshness data as limitations and list them explicitly.',
      'Evidence labels describe the current directional balance only; they are not forecasts.',
      'Do not create scores, probabilities, weights, price targets, or predictive claims.',
      'Keep each factual statement traceable to a concrete field in the snapshot.',
    ].join(' '),
    input: JSON.stringify(snapshot),
    text: {
      verbosity: 'medium',
      format: {
        type: 'json_schema',
        name: 'market_assessment',
        strict: true,
        schema: analysisSchema(),
      },
    },
  };
}

export function extractResponseJson(response) {
  if (typeof response?.output_text === 'string') return JSON.parse(response.output_text);
  const text = response?.output?.flatMap((item) => item.content ?? [])
    .find((item) => item.type === 'output_text')?.text;
  if (!text) throw new Error('OpenAI response did not contain output text');
  return JSON.parse(text);
}

export function analysisToMarkdown(analysis, generatedAt) {
  const lines = ['# GPT Market Analysis', '', `Generated: ${generatedAt}`, '', '## Summary', ''];
  lines.push(...analysis.summary.map((item) => `- ${item}`), '', '## Data quality', '');
  lines.push(...analysis.dataQualitySummary.map((item) => `- ${item}`), '');
  for (const [name, domain] of Object.entries(analysis.domains)) {
    lines.push(`## ${name}`, '', `Assessment: ${domain.assessment}`, '');
    for (const [key, values] of Object.entries(domain)) {
      if (key === 'assessment') continue;
      lines.push(`### ${key}`, '', ...(values.length ? values.map((item) => `- ${item}`) : ['- None reported']), '');
    }
  }
  return `${lines.join('\n')}\n`;
}

async function loadLocalEnv(env) {
  const merged = { ...env };
  for (const file of ['.env.local', '.env']) {
    try {
      const text = await readFile(file, 'utf8');
      for (const line of text.split(/\r?\n/)) {
        const match = line.match(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/);
        if (!match || merged[match[1]]) continue;
        merged[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return merged;
}

async function callMcp(fetchImpl, apiKey, name, args) {
  const response = await fetchImpl(MCP_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'user-agent': 'worldmonitor-local-market-analysis/1.0',
      'X-WorldMonitor-Key': apiKey,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: name, method: 'tools/call', params: { name, arguments: args } }),
  });
  const body = parseSseOrJson(await response.text(), response.headers.get('content-type') || '');
  if (!response.ok) throw new Error(`WorldMonitor ${name} failed (${response.status})`);
  return unwrapMcpResult(body);
}

async function runOpenAi(fetchImpl, apiKey, request) {
  const response = await fetchImpl(OPENAI_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(request),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body?.error?.message || `OpenAI request failed (${response.status})`);
  return extractResponseJson(body);
}

function parseCli(argv) {
  const out = { snapshotOnly: false, outputDir: DEFAULT_OUTPUT_DIR, model: DEFAULT_MODEL };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--snapshot-only') out.snapshotOnly = true;
    else if (argv[i] === '--output-dir') out.outputDir = argv[++i];
    else if (argv[i] === '--model') out.model = argv[++i];
    else throw new Error(`Unknown option: ${argv[i]}`);
  }
  return out;
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const options = parseCli(argv);
  const env = await loadLocalEnv(dependencies.env ?? process.env);
  const fetchImpl = dependencies.fetch ?? globalThis.fetch;
  if (!env.WORLDMONITOR_API_KEY) throw new Error('Set WORLDMONITOR_API_KEY in .env.local or the shell');
  const [market, economic] = await Promise.all([
    callMcp(fetchImpl, env.WORLDMONITOR_API_KEY, 'get_market_data', { symbols: MARKET_SYMBOLS, limit: 30 }),
    callMcp(fetchImpl, env.WORLDMONITOR_API_KEY, 'get_economic_data', { dataset: ECONOMIC_DATASETS, limit: 30 }),
  ]);
  const snapshot = buildSnapshot({ market, economic });
  const outputDir = resolve(options.outputDir);
  await mkdir(outputDir, { recursive: true });
  await Promise.all([
    writeFile(resolve(outputDir, 'market-snapshot.json'), `${JSON.stringify(snapshot, null, 2)}\n`),
    writeFile(resolve(outputDir, 'market-snapshot.md'), snapshotToMarkdown(snapshot)),
  ]);
  if (options.snapshotOnly) return { outputDir, snapshot, analysis: null };
  if (!env.OPENAI_API_KEY) throw new Error('Snapshot saved. Set OPENAI_API_KEY to generate GPT analysis');
  const analysis = await runOpenAi(fetchImpl, env.OPENAI_API_KEY, buildAnalysisRequest(snapshot, options.model));
  await Promise.all([
    writeFile(resolve(outputDir, 'gpt-market-analysis.json'), `${JSON.stringify(analysis, null, 2)}\n`),
    writeFile(resolve(outputDir, 'gpt-market-analysis.md'), analysisToMarkdown(analysis, snapshot.generatedAt)),
  ]);
  return { outputDir, snapshot, analysis };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(({ outputDir, analysis }) => {
    console.log(`Saved market snapshot${analysis ? ' and GPT analysis' : ''} to ${outputDir}`);
  }).catch((error) => {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  });
}
