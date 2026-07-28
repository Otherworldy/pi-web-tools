# pi-web-tools

Web search, fetch, source-check, and session content tools for [Pi Agent](https://github.com/badlogic/pi-mono).

Pluggable providers: Brave, Tavily, Serper, Exa, You.com, Jina, Firecrawl, Perplexity, SearXNG, Ollama, OneSearch Relay.

## Install

```bash
pi install npm:pi-web-tools
```

Config: `~/.pi/agent/extensions/pi-web-tools/config.json` (chmod 0600). Legacy `rpiv-web-tools` config is auto-migrated.

## Tools

| Tool | Purpose |
|---|---|
| `one_search` | Concurrent multi-source search. Params: `query`/`queries`, `max_results`, `recencyFilter`, `domainFilter`, `provider`, `includeContent`, `workflow` |
| `web_fetch` | Fetch `url` or `urls[]`. GitHub interceptor, PDF text extract, RSC parse, Jina/provider fallbacks, SSRF-safe |
| `get_search_content` | Page stored search/fetch/research by `responseId` + `offset`/`limit` |
| `source_check` | Claim check with passage citations → research artifact |

## Commands

- `/web-tools` — configure sources (keys, enable/disable, result counts)
- `/websearch q1, q2` — run searches, store `responseId`
- `/search` — list stored session results
- `/curator [on\|off\|none\|auto-summary]` — default search workflow
- `/activity [on\|off\|toggle\|show\|clear]` — web activity monitor (widget or one-shot dump)

## Search providers

| Source | Env |
|---|---|
| Brave | `BRAVE_SEARCH_API_KEY` |
| Tavily | `TAVILY_API_KEY` |
| Serper | `SERPER_API_KEY` |
| Exa | `EXA_API_KEY` |
| You.com | `YOUCOM_API_KEY` |
| Jina | `JINA_API_KEY` |
| Firecrawl | `FIRECRAWL_API_KEY` |
| Perplexity | `PERPLEXITY_API_KEY` |
| SearXNG | `SEARXNG_URL` (+ optional key) |
| Ollama | `OLLAMA_HOST` / `OLLAMA_API_KEY` |
| OneSearch | `ONESEARCH_URL` / `ONESEARCH_API_KEY` |

`one_search` queries **all enabled sources in parallel** and de-duplicates by URL.

## Fetch pipeline

```
GitHub interceptor?
→ SSRF-safe HTTP (DNS preflight + redirect validation)
→ PDF? pdftotext → ~/Downloads/*.md
→ HTML? RSC → htmlToText
→ thin/blocked? configured fetch providers → Jina Reader
```

## Security config

```json
{
  "ssrf": {
    "allowRanges": ["198.18.0.0/15"],
    "trustEnvProxy": false
  },
  "fetchContent": {
    "domainPolicy": {
      "allow": ["docs.example.com"],
      "deny": ["tracker.example.com"]
    }
  },
  "workflow": "none"
}
```

- **DNS preflight** blocks hostnames that resolve to private/reserved IPs
- **Redirects** re-validated (manual redirect following)
- **allowRanges** for TUN/fake-IP proxies
- **trustEnvProxy** skips local DNS preflight for proxied hosts (opt-in)
- PDF extraction requires system `pdftotext` (poppler-utils)

## License

MIT
