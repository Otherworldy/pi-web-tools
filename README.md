# rpiv-web-tools

<div align="center">
  <a href="https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-web-tools">
    <picture>
      <img src="https://raw.githubusercontent.com/juicesharp/rpiv-mono/main/packages/rpiv-web-tools/docs/cover.png" alt="rpiv-web-tools cover" width="50%">
    </picture>
  </a>
</div>

Let the model search the web and read pages. `rpiv-web-tools` adds `one_search` and `web_fetch` tools to [Pi Agent](https://github.com/badlogic/pi-mono) with pluggable providers (Brave, Tavily, Serper, Exa, You.com, Jina, Firecrawl, Perplexity, [SearXNG](https://docs.searxng.org/), [Ollama](https://ollama.com), OneSearch Relay), plus `/web-tools` for interactive search-source setup. `one_search` queries every enabled/configured search source concurrently and merges duplicate URLs; `web_fetch` uses URL interceptors, enabled/configured fetch-capable sources, then generic HTML fetch.

![Search source configuration prompt](https://raw.githubusercontent.com/juicesharp/rpiv-mono/main/packages/rpiv-web-tools/docs/config.jpg)

## Providers

Configure one or more search sources. `one_search` uses all enabled/configured search sources in parallel and de-duplicates merged URLs.

| Source | Env var | Signup | Fetch mode |
|---|---|---|---|
| Brave | `BRAVE_SEARCH_API_KEY` | [brave.com/search/api](https://brave.com/search/api/) | raw HTTP → htmlToText, `raw: true` available |
| Tavily | `TAVILY_API_KEY` | [tavily.com](https://tavily.com) | native extraction (plain text) |
| Serper | `SERPER_API_KEY` | [serper.dev](https://serper.dev) | raw HTTP → htmlToText, `raw: true` available |
| Exa | `EXA_API_KEY` | [exa.ai](https://exa.ai) | native extraction (plain text) |
| You.com | `YOUCOM_API_KEY` | [you.com](https://you.com) | native extraction (markdown) |
| Jina | `JINA_API_KEY` | [jina.ai/reader](https://jina.ai/reader) | native extraction (markdown) |
| Firecrawl | `FIRECRAWL_API_KEY` | [firecrawl.dev](https://firecrawl.dev) | native extraction (markdown) |
| Perplexity | `PERPLEXITY_API_KEY` | [docs.perplexity.ai](https://docs.perplexity.ai/) | raw HTTP → htmlToText, `raw: true` available |
| SearXNG | `SEARXNG_URL` (+ optional `SEARXNG_API_KEY`) | self-hosted | raw HTTP → htmlToText, `raw: true` available |
| Ollama | `OLLAMA_HOST` / `OLLAMA_API_KEY` | local or [ollama.com](https://ollama.com) | native extraction |
| OneSearch | `ONESEARCH_URL` (+ optional `ONESEARCH_API_KEY`) | self-hosted OneSearch Relay | generic raw HTTP fallback |

## Features

- **Read any URL** - fetch http/https pages with HTML-to-text extraction, or get the raw response with `raw: true` (honoured by generic HTTP fetch and raw-HTTP providers; extraction providers — Tavily/Exa/You.com/Jina/Firecrawl/Ollama — always return their parsed text).
- **GitHub URL interceptor** - github.com URLs route through `gh`/`git` for full repository content (file tree, README, individual file contents) instead of the rendered HTML page. Enabled by default; disable with `"interceptors": { "github": false }` when needed. See [§GitHub URL interceptor](#github-url-interceptor).
- **Large-page spillover** - oversized responses truncate inline and spill the full body to a temp file the model can read on demand.
- **SSRF guard** - refuses loopback, RFC 1918, link-local, and cloud-metadata addresses (`localhost`, `127.0.0.0/8`, `10.0.0.0/8`, `169.254.0.0/16`, `172.16.0.0/12`, `192.168.0.0/16`, `::1`, `fc00::/7`, `fe80::/10`).
- **Interactive setup** - `/web-tools` lists search sources (configured/disabled ones marked) and writes to `~/.pi/agent/extensions/rpiv-web-tools/config.json` (chmod 0600); source env vars also work and take precedence over persisted keys unless that source has `enabled: false`. Configure multiple sources to enable multi-source search.

## Install

```bash
pi install npm:@juicesharp/rpiv-web-tools
```

Then restart your Pi session.

## Tools

- **`one_search`** - query all enabled/configured search sources concurrently, merge titled snippets, and de-duplicate results by URL.
  Each source uses `search.defaultResults` as its default request count (10), sources can override with `search.sources.<source>.resultLimit`, `search.sources.<source>.enabled=false` disables a source, and the final merged result count defaults to `search.mergedResults` (20) or per-call `max_results`. No built-in maximum is imposed.
- **`web_fetch`** - read an http/https URL. Lookup order: URL interceptors
  (see [§GitHub URL interceptor](#github-url-interceptor)), enabled/configured fetch-capable sources
  (Tavily/Exa/You.com/Jina/Firecrawl/Ollama), then generic raw HTTP + HTML-to-text fallback. Large responses truncate
  inline and spill the full body to a temp file the model can read on demand.

### Schema - `one_search`

```ts
one_search({
  query: string,                    // natural-language query
  max_results?: number,             // positive integer; overrides the final merged result count (default 20)
})
```

Returns:

```ts
{
  content: [{ type: "text", text: string }], // markdown list of "**title**\n url\n snippet"
  details: {
    query: string,
    backend: string, // comma-separated source names, retained for compatibility
    backends: Array<"brave" | "tavily" | "serper" | "exa" | "youcom" | "jina" | "firecrawl" | "perplexity" | "searxng" | "ollama" | "onesearch">,
    sourceResultLimits: Record<string, number>, // per-source request counts
    sourceResultCounts: Record<string, number>, // raw successful results returned per source
    mergedResultLimit: number,
    resultCount: number,
    results?: Array<{ title: string, url: string, snippet: string, source?: string }>,
    failures?: string[], // source warnings when at least one source still succeeded
  }
}
```

Throws when no enabled/configured search source succeeds. If one source fails but another succeeds, the successful merged results are returned and source warnings are reported in `details.failures`.

### Schema - `web_fetch`

```ts
web_fetch({
  url: string,                      // http or https only
  raw?: boolean,                    // true → return raw HTML; default false → strip to text
  forceClone?: boolean,             // GitHub only: clone even above maxRepoSizeMB; default false
})
```

Returns:

```ts
{
  content: [{ type: "text", text: string }], // header (URL/title/content-type) + body
  details: {
    url: string,
    title?: string,                 // <title> element, if present (HTML, non-raw)
    contentType?: string,
    contentLength?: number,         // from Content-Length header
    truncation?: TruncationResult,  // present when body exceeded inline limits
    fullOutputPath?: string,        // temp-file path containing the un-truncated body
  }
}
```

Throws on invalid URL, non-http(s) protocol, private/loopback hostnames (SSRF guard), non-2xx response, or `image/` / `video/` / `audio/` content types. Extraction providers (Tavily/Exa/You.com/Jina/Firecrawl) additionally throw when the API returns an empty body or a vendor-level failure (e.g. Firecrawl `success: false`, Tavily `failed_results`).

## Commands

- **`/web-tools`** - configure a search source API key and, when needed, its base URL interactively.
  Sources already configured show `(configured)`. Pressing Enter on an empty input keeps the existing value for the chosen source. Pass `show` to see all source keys (masked), env var status, per-source request counts, merged result count, and current URL interceptor states (see [§GitHub URL interceptor](#github-url-interceptor)).
- **`/web-tools default-results <positive-integer>`** - set the default per-source request count. Default: 10.
- **`/web-tools source-results <source> <positive-integer>`** - set one source's request count, e.g. `/web-tools source-results exa 15`.
- **`/web-tools source-enable <source>`** - explicitly enable one source, e.g. `/web-tools source-enable onesearch`.
- **`/web-tools source-disable <source>`** - disable one source even if its env vars are set, e.g. `/web-tools source-disable brave`.
- **`/web-tools merged-results <positive-integer>`** - set the default final merged result count. Default: 20. Per-call `max_results` overrides this count.

## API key resolution (per source)

First match wins for each source:

1. The source environment variable: `BRAVE_SEARCH_API_KEY`, `TAVILY_API_KEY`, `SERPER_API_KEY`, `EXA_API_KEY`, `YOUCOM_API_KEY`, `JINA_API_KEY`, `FIRECRAWL_API_KEY`, `PERPLEXITY_API_KEY`, `SEARXNG_API_KEY`, `OLLAMA_API_KEY`, or `ONESEARCH_API_KEY`
2. `search.sources.<source>.apiKey` field in `~/.pi/agent/extensions/rpiv-web-tools/config.json`
3. Legacy `apiKey` field (Brave only — auto-migrated to `search.sources.brave.apiKey`)

For `one_search`, every configured and enabled source is queried concurrently. Set `search.sources.<source>.enabled` to `false` (or run `/web-tools source-disable <source>`) to skip a source even when its env vars are set. Set it to `true` (or run `/web-tools source-enable <source>`) to explicitly enable a source; providers that require API keys still need a key. If no source is enabled/configured, search asks the user to run `/web-tools` instead of assuming a default source. Each source request uses `search.sources.<source>.resultLimit` when set, otherwise `search.defaultResults` (default 10). Final results are round-robin merged and limited by per-call `max_results` or `search.mergedResults` (default 20).

For `web_fetch`, URL interceptors run first, enabled/configured fetch-capable sources may provide vendor extraction, and generic HTML fetch is used as the fallback.

## OneSearch Relay (self-hosted)

OneSearch Relay is a self-hosted multi-search aggregation gateway. This provider calls its native `POST /v1/search` endpoint and maps OneSearch results (`title`, `url`, `snippet`/`content`) into `one_search` results. It is search-only in `rpiv-web-tools`; `web_fetch` still uses URL interceptors, configured extraction providers, then generic HTML fetch.

```bash
export ONESEARCH_URL=http://localhost:5173
# Optional when OneSearch Relay has API_AUTH_REQUIRED=false; otherwise use an osr_ API token or oak_ admin API key
export ONESEARCH_API_KEY=...
```

Resolution order for the URL: `ONESEARCH_URL` env var → `search.sources.onesearch.baseUrl` in `~/.pi/agent/extensions/rpiv-web-tools/config.json` → default `http://localhost:5173`. `/web-tools` prompts for the URL first and the optional token second.

The provider sends:

```json
{ "query": "...", "limit": 10, "include_raw": false }
```

to `<ONESEARCH_URL>/v1/search` with `Authorization: Bearer <ONESEARCH_API_KEY>` when a token is configured.

## SearXNG (self-hosted)

SearXNG talks to an instance you control, so it needs a base URL instead of (or in addition to) an API key.

```bash
export SEARXNG_URL=http://localhost:8080
# Optional: only if your instance sits behind a Bearer-auth reverse proxy
export SEARXNG_API_KEY=…
```

Resolution order for the URL: `SEARXNG_URL` env var → `search.sources.searxng.baseUrl` in `~/.pi/agent/extensions/rpiv-web-tools/config.json` → default `http://localhost:8080`. `/web-tools` prompts for the URL first and the (optional) API key second.

Your instance must have `json` enabled in `settings.yml` under `search.formats` — default SearXNG installs ship with JSON disabled and will return `403 Forbidden` otherwise (per the [SearXNG search API docs](https://docs.searxng.org/dev/search_api.html)). The provider surfaces that case with an actionable hint. SearXNG is search-only in `rpiv-web-tools`, so URLs returned by `one_search` are fetched by the normal `web_fetch` fallback pipeline without any extra setup.

The SSRF guard (which refuses loopback and RFC-1918 addresses) applies to URLs `web_fetch` retrieves on the model's behalf, not to the SearXNG search endpoint itself: a `SEARXNG_URL` pointing at `http://localhost:8080` or another private host is intentionally reachable, since SearXNG is self-hosted by design.

### Running SearXNG locally with Docker

The `searxng/searxng` entrypoint **overwrites** `/etc/searxng/settings.yml` on first start with the bundled default (ships with `formats: [html]` only). Pre-populating the mounted file doesn't stick — wait for the entrypoint, then patch:

```bash
mkdir -p ~/.searxng
docker run -d --name searxng --restart unless-stopped \
  -p 8080:8080 -v "$HOME/.searxng":/etc/searxng \
  -e BASE_URL=http://localhost:8080/ searxng/searxng:latest
sleep 5  # wait for entrypoint to write settings.yml
sed -i.bak '/^  formats:$/,/^[^ ]/ { /- html/a\
    - json
}' ~/.searxng/settings.yml
docker restart searxng

# Sanity check — a number > 0 means it's wired correctly
curl -sf 'http://localhost:8080/search?q=hello&format=json' | jq '.results | length'
```

`403` means JSON is still disabled — re-check `~/.searxng/settings.yml`. Works identically on Docker Desktop or OrbStack. For a throwaway test instance, swap `~/.searxng` for `/tmp/searxng` and drop `--restart unless-stopped`.

## Ollama (local or cloud)

Ollama provides web search and fetch as built-in capabilities — no third-party API key needed for local usage. For cloud access, an API key is required.

### Local Ollama

Run Ollama locally, then enable the Ollama search source with `/web-tools` (press Enter for the default URL) or set `OLLAMA_HOST`:

```bash
ollama serve
```

No API key needed for local usage. Once enabled, the source talks to `http://localhost:11434` by default.

### Ollama Cloud

For cloud access via [Ollama Cloud](https://ollama.com), set the base URL and API key:

```bash
export OLLAMA_HOST=https://ollama.com
export OLLAMA_API_KEY=your_api_key   # generate at https://ollama.com/settings/keys
```

Or configure interactively via `/web-tools` — select "Ollama" and enter the URL and key.

Resolution order:
- **Base URL**: `OLLAMA_HOST` env var → `search.sources.ollama.baseUrl` in config → default `http://localhost:11434`
- **API key**: `OLLAMA_API_KEY` env var → `search.sources.ollama.apiKey` in config (optional for local, required for cloud)

The provider automatically uses the correct API paths:
- **Local** (`localhost`, `127.0.0.1`, `0.0.0.0`): `/api/experimental/web_search` and `/api/experimental/web_fetch`
- **Cloud** (any other host): `/api/web_search` and `/api/web_fetch`

## GitHub URL interceptor

Routes github.com URLs through `gh` / `git` to return repository content (file tree, README, file content) instead of the rendered HTML. **Enabled by default.** Disable it per user when needed:

```json
// ~/.pi/agent/extensions/rpiv-web-tools/config.json — end-user disable
{ "interceptors": { "github": false } }
```

```ts
// or per-consumer at registration time when user config is absent
registerWebTools(pi, { interceptors: { github: false } });
```

When enabled, github.com URLs are parsed into `owner/repo/ref/path`; non-code paths (`/issues`, `/pulls`, `/discussions`, `/releases`, …) fall through to normal `web_fetch` handling. The interceptor probes for `gh`, falls back to plain `git clone` (with a stderr hint to install `gh`), and uses the `gh api` JSON view for SHA-pinned URLs and repos above `maxRepoSizeMB`. To override that size guard after user confirmation, call `web_fetch` again with `forceClone: true`. Shallow clones (`--depth 1 --single-branch`) land in `clonePath`; successful clones cache by `owner/repo@ref` for the session. Auth flows through `gh`'s normal `GH_TOKEN`/`GITHUB_TOKEN` precedence — export `GITHUB_TOKEN` to reach private repos.

Replace the boolean shorthand with an object to tune the defaults; object form keeps the interceptor enabled unless `enabled` is set to `false`.

```json
{
  "interceptors": {
    "github": {
      "maxRepoSizeMB": 1000,
      "cloneTimeoutSeconds": 90,
      "clonePath": "/Users/me/.cache/pi-github-repos",
      "cloneTtlHours": 24
    }
  }
}
```

| Field | Default | Purpose |
|---|---|---|
| `enabled` | `true` | Master switch |
| `maxRepoSizeMB` | `350` | Repos above this threshold skip the clone and use the API view |
| `cloneTimeoutSeconds` | `30` | Kill the clone process after this many seconds |
| `clonePath` | `$TMPDIR/pi-github-repos` | Where shallow clones land; one subdir per `owner/repo@ref` |
| `cloneTtlHours` | `24` | Startup cleanup removes clone directories older than this many hours |

`/web-tools show` reports the current state at the bottom of its output (resolved token masked, `clonePath`, `maxRepoSizeMB`, `cloneTtlHours`). The SSRF guard still runs first — a URL with a private/loopback host can't bypass it via a github.com path shape.

## Executor guidance overrides

Override the `promptSnippet` / `promptGuidelines` the model sees for each tool by editing `~/.pi/agent/extensions/rpiv-web-tools/config.json`. Note the per-tool nesting under `guidance.web_search` / `guidance.web_fetch` — this differs from the flat `guidance` shape used by single-tool siblings (`rpiv-advisor`, `rpiv-todo`, `rpiv-ask-user-question`):

```json
{
  "search": {
    "defaultResults": 10,
    "mergedResults": 20,
    "sources": {
      "exa": { "enabled": false, "apiKey": "sk-...", "resultLimit": 15 },
      "onesearch": { "enabled": true, "baseUrl": "http://localhost:18080", "resultLimit": 50 },
      "brave": { "apiKey": "sk-..." }
    }
  },
  "interceptors": {
    "github": true
  },
  "guidance": {
    "web_search": {
      "promptSnippet": "Search the web for current docs and library versions",
      "promptGuidelines": [
        "Only call one_search when training-data answers may be stale.",
        "Always include a Sources: section with markdown hyperlinks."
      ]
    },
    "web_fetch": {
      "promptSnippet": "Fetch a specific URL and read its content"
    }
  }
}
```

Each field is independent: omit one and the built-in default is kept. Invalid values (empty string, wrong type, empty array) silently fall back to defaults. Changes take effect on the next Pi session start.

The `interceptors` key configures the GitHub URL interceptor — see [§GitHub URL interceptor](#github-url-interceptor) for the full schema (boolean shorthand or per-field overrides).

## Security note: `web_fetch` host guard

`web_fetch` refuses URLs targeting loopback (`localhost`, `127.0.0.0/8`, `::1`), RFC 1918 private ranges (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), link-local (`169.254.0.0/16`, including cloud-metadata at `169.254.169.254`), and IPv6 unique-local / link-local (`fc00::/7`, `fe80::/10`). Attempts surface as `Refusing to fetch private/loopback address: <host>`. This blocks the most common SSRF class — direct-literal targeting of internal services or cloud-metadata endpoints — without preventing legitimate public-web fetches.

The guard is host-literal only; it does NOT resolve DNS or validate redirects. A public hostname that resolves to a private IP, or a public URL that 302-redirects to one, will still reach the target. For untrusted automation environments, layer an egress proxy or firewall on top.

## License

[![npm version](https://img.shields.io/npm/v/@juicesharp/rpiv-web-tools.svg)](https://www.npmjs.com/package/@juicesharp/rpiv-web-tools)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

MIT
