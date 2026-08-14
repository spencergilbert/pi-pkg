---
name: kagi
description: Web search and content extraction via the Kagi Universal Search API. Use for searching documentation, facts, or any web content, and for extracting readable markdown from URLs. Requires a Kagi account and the KAGI_API_KEY environment variable. Pure Node.js, no browser or npm dependencies.
---

# Kagi

Web search and page-content extraction using the Kagi API (v1). Lightweight — no browser, no npm dependencies, just Node.js 18+ (uses global `fetch`).

## Setup

1. Create an account at https://kagi.com — any paid plan includes API access.
2. Create an API token at https://kagi.com/settings?p=api
3. Add it to your shell profile (`~/.profile`, or `~/.zprofile` for zsh):
   ```bash
   export KAGI_API_KEY="your-token-here"
   ```
4. No other setup required — the scripts run with plain `node`.

## Search

```bash
{baseDir}/search.mjs "query"               # Basic search (10 results)
{baseDir}/search.mjs "query" -n 5          # Fewer results
{baseDir}/search.mjs "query" --time week   # Results from the last week
```

### Options

- `-n <num>` — Number of results (default: 10, max: 1024)
- `--time <period>` — Time filter: `day`, `week`, or `month`

## Extract Page Content

```bash
{baseDir}/extract.mjs https://example.com/article     # Markdown to stdout
{baseDir}/extract.mjs https://a.com https://b.com     # Up to 10 URLs at once
{baseDir}/extract.mjs https://a.com --out article.md  # Write to file
```

Extracts readable content as markdown from up to 10 HTTPS URLs in a single request.

## Output

Both scripts request `format: "markdown"` from the API and pass the response through to stdout unchanged (markdown from search results; page markdown from extraction).

## When to Use

- Searching for documentation or API references
- Looking up facts or current information
- Fetching readable content from specific URLs as markdown
- Any task requiring web search without interactive browsing
