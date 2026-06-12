# Same-Origin CF RevProxy 

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/flawnn/same-origin-cf-proxy)

A Cloudflare Worker that reverse-proxies a third-party site so it can be embedded
same-origin (in an iframe). It strips framing/security headers, rewrites URLs so the
app keeps working through the proxy, and injects a small client-side shim that keeps
the app's runtime requests (API calls, SPA navigation) routed through the proxy.

> **Responsible use.** This tool strips security headers and injects scripts into
> proxied pages. Only point it at properties you own or are explicitly authorized to
> test. Respect any target's Terms of Service and the privacy of anyone whose
> interactions it records.

## Deploy

**One click:** use the button above — Cloudflare clones the repo and deploys it. It
ships with a placeholder `example.com` target; after deploying, set your own targets:

```sh
npx wrangler deploy   # or edit PROXY_TARGETS in wrangler.toml and redeploy
```

**From the CLI:**

```sh
npm install
cp .dev.vars.example .dev.vars   # then edit PROXY_TARGETS
npm run dev                      # http://localhost:8787
npm run deploy                   # publish to *.workers.dev
```

## How it works

```
Browser ──> Worker (/proxy/<name>/*) ──> target origin
              │  strips X-Frame-Options / CSP / SRI
              │  injects permissive CORS
              │  rewrites HTML + CSS URLs back through the proxy
              └─ injects URL-rewriting shim into <head> (keeps SPA requests on the proxy)
```

- **Server side**: header transforms, redirect/cookie
  rewriting, streaming `HTMLRewriter` for URL rewriting + SRI stripping + shim injection,
  and CSS `url()` rewriting.
- **Client side**: patching `fetch`,
  `XMLHttpRequest`, `history`, `postMessage`, `setAttribute`, and `src`/`href` setters so the
  app's runtime URLs stay routed through the proxy.

## Routes

| Route | Purpose |
|---|---|
| `GET /` | Usage hint (plain text) |
| `/proxy/<name>/*` | Proxy to the configured target `<name>` |
| `/proxy/h/<host>/*` | Proxy an allowlisted external host (e.g. an API subdomain) |

## Configuration

Targets are defined by the `PROXY_TARGETS` env var — a JSON map of `name → { origin, allow }`:

```json
{ "example": { "origin": "https://example.com", "allow": "(^|\\.)example\\.com$" } }
```

- `origin` — upstream the named prefix proxies to (`/proxy/example/*` → `https://example.com/*`)
- `allow` — regex of additional hostnames proxiable via `/proxy/h/<host>/*` (e.g. API subdomains
  the app calls at runtime). Doubles as an SSRF allowlist.

Set it in `wrangler.toml` (`[vars]`) or `.dev.vars` for local development.
