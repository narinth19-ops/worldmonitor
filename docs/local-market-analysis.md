# Local Market Snapshot and GPT Analysis

This local-only workflow exports the same public data the dashboard panels load.
It does not expose a new endpoint, read Redis directly, require API keys, or
require a continuously running local server.

For local development without Docker or a local Redis instance, set
`WORLDMONITOR_USE_UPSTREAM_API=true` in `.env.local`. Vite then proxies `/api`
requests to the WorldMonitor upstream API while keeping the browser on the
localhost origin.

## Export a snapshot

Run the local WorldMonitor app and click the `GPT ↓` button in the header. The
browser downloads two files:

- `worldmonitor-market-snapshot-<timestamp>.json`
- `worldmonitor-market-snapshot-<timestamp>.md`

The export loads point-in-time data for Gold, FX, Macro/Rates, Commodities, and
Crypto through the dashboard's existing browser RPC clients. A failed source is
recorded as missing; the exporter never fills in an absent value.

## Analyze with ChatGPT or Codex

Attach either downloaded file to a ChatGPT or Codex conversation and request a
current market assessment. No OpenAI API key is required because the analysis
happens in the conversation rather than through the API.

The Markdown file includes the analysis contract: separate observed facts from
interpretation; list bullish, bearish, and neutral evidence, conflicts, risks,
missing or stale data, and what to watch next. Do not produce predictive scores,
arbitrary weights, probabilities, or fabricated replacements for missing data.
