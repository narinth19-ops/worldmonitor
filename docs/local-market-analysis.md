# Local Market Snapshot and GPT Analysis

This local-only workflow reads the authorized WorldMonitor MCP surface. It does
not expose a new public endpoint, read Redis directly, or require a continuously
running local server.

## Configuration

Add the keys to `.env.local` (already ignored by Git):

```dotenv
WORLDMONITOR_API_KEY=wm_...
OPENAI_API_KEY=sk-...
```

`WORLDMONITOR_API_KEY` is required for both commands. `OPENAI_API_KEY` is only
required for GPT analysis.

## Commands

Create a point-in-time JSON and Markdown snapshot:

```bash
npm run market:snapshot
```

Create the snapshot and a structured GPT market assessment:

```bash
npm run market:analyze
```

Outputs are written to `.local/market-analysis/`, which is ignored by Git:

- `market-snapshot.json`
- `market-snapshot.md`
- `gpt-market-analysis.json`
- `gpt-market-analysis.md`

Use `-- --output-dir <path>` to choose another directory or `-- --model <id>`
to override the default OpenAI model.

The analysis contract separates observed facts from interpretation and lists
directional evidence, conflicts, risks, missing or stale data, and what to watch
next. It deliberately excludes predictive scores, arbitrary weights,
probabilities, and fabricated replacements for missing data.
