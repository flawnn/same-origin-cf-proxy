import { applyRewriter } from './rewriter.js';
import { REWRITE_SHIM } from './rewrite-shim.js';

// Single source of truth — imported by index.js
export const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, HEAD, POST, OPTIONS, PUT, PATCH, DELETE',
  'access-control-allow-headers': '*',
  'access-control-expose-headers': '*',
};

const STRIP_HEADERS = [
  'x-frame-options',
  'content-security-policy',
  'content-security-policy-report-only',
  'strict-transport-security',
  'public-key-pins',
  'public-key-pins-report-only',
  'x-content-type-options',
  'content-encoding',    // HTMLRewriter decompresses; remove to prevent double-decompress
  'content-length',      // length changes after rewriting
  'transfer-encoding',
];

// Headers we must not forward to the upstream target
const OUTBOUND_STRIP = new Set([
  'origin',
  'referer',
  'cf-connecting-ip',
  'cf-ipcountry',
  'cf-ray',
  'cf-visitor',
  'x-forwarded-for',
  'x-real-ip',
  'host',
]);

/**
 * Rewrite an upstream location/pjax URL back into a /proxy/<target>/... path.
 * Returns the original value unchanged if it doesn't match the target origin.
 *
 * @param {string} value       - Raw header value from upstream
 * @param {string} targetOrigin - e.g. "https://example.com"
 * @param {string} proxyPrefix  - e.g. "/proxy/example"
 * @returns {string}
 */
const rewriteLocationHeader = (value, targetOrigin, proxyPrefix) => {
  if (value.startsWith(targetOrigin)) {
    return proxyPrefix + value.slice(targetOrigin.length);
  }

  if (value.startsWith('//')) {
    // Protocol-relative — strip the leading "//" and the host portion
    const withoutScheme = value.slice(2);
    const slashIdx = withoutScheme.indexOf('/');
    const path = slashIdx === -1 ? '/' : withoutScheme.slice(slashIdx);
    return proxyPrefix + path;
  }

  // Relative path — leave as-is; browser resolves it against the proxy origin
  return value;
};

/**
 * Rewrite a single Set-Cookie header value:
 *   - Strip domain attribute
 *   - Strip all SameSite variants
 *   - Append SameSite=None; Secure
 *
 * @param {string} cookie
 * @returns {string}
 */
const rewriteSetCookie = (cookie) => {
  let rewritten = cookie
    // Strip domain=<value> (with optional trailing semicolon + spaces)
    .replace(/;\s*domain=[^;]*/gi, '')
    // Strip any existing SameSite attribute (strict/lax/none or bare "samesite=")
    .replace(/;\s*samesite=[^;]*/gi, '');

  return rewritten + '; SameSite=None; Secure';
};

/**
 * Parse the PROXY_TARGETS env var: a JSON map of name → { origin, allow }.
 *   - `origin`: upstream origin the named prefix proxies to (e.g. "https://example.com")
 *   - `allow`:  regex (string) of additional hostnames that may be proxied via /proxy/h/<host>/
 *               (e.g. API subdomains the app calls at runtime). Also injected into the shim
 *               so client-side URL rewriting matches the same hosts.
 *
 * Example: {"example":{"origin":"https://example.com","allow":"(^|\\.)example\\.com$"}}
 *
 * @param {object} env
 * @returns {Record<string, {origin: string, allow?: string}>}
 */
const getTargets = (env) => {
  try { return JSON.parse(env.PROXY_TARGETS || '{}'); } catch (_) { return {}; }
};

/**
 * Named reverse-proxy handler: /proxy/<name>/<path> → <target.origin>/<path>
 *
 * @param {Request} request
 * @param {object}  env   - Cloudflare Worker env bindings
 * @param {string}  name  - target key from PROXY_TARGETS
 * @returns {Promise<Response>}
 */
export async function handleProxy(request, env, name) {
  const target = getTargets(env)[name];
  if (!target || !target.origin) return new Response('unknown target', { status: 404 });
  return proxyTo(request, target.origin, `/proxy/${name}`, target.allow || '');
}

/**
 * Generic host proxy: /proxy/h/<hostname>/<path> → https://<hostname>/<path>
 * Used for runtime API subdomains an app calls (e.g. an API host). Restricted to the union of
 * every target's `allow` pattern, so it can't be used as an open proxy / SSRF vector.
 *
 * @param {Request} request
 * @param {object}  env
 * @returns {Promise<Response>}
 */
export async function handleHostProxy(request, env) {
  const incomingUrl = new URL(request.url);
  const rest = incomingUrl.pathname.slice('/proxy/h/'.length);
  const slashIdx = rest.indexOf('/');
  const host = slashIdx === -1 ? rest : rest.slice(0, slashIdx);
  const allowed = Object.values(getTargets(env)).some(
    (t) => t.allow && new RegExp(t.allow, 'i').test(host),
  );
  if (!host || !allowed) return new Response('host not allowed', { status: 403 });
  return proxyTo(request, 'https://' + host, '/proxy/h/' + host, '');
}

/**
 * Core reverse-proxy logic shared by named and host proxies.
 *
 * @param {Request} request
 * @param {string}  targetOrigin - e.g. "https://example.com"
 * @param {string}  proxyPrefix  - e.g. "/proxy/example"
 * @param {string}  allowSrc     - regex string of allowed external hosts, injected into the shim
 * @returns {Promise<Response>}
 */
async function proxyTo(request, targetOrigin, proxyPrefix, allowSrc) {
  const incomingUrl = new URL(request.url);

  // Strip the proxy prefix; keep remaining path + search
  const remainingPath = incomingUrl.pathname.slice(proxyPrefix.length) || '/';
  const targetUrl = new URL(remainingPath + incomingUrl.search, targetOrigin);

  // --- Build outbound request headers ---
  const outboundHeaders = new Headers();
  for (const [key, value] of request.headers.entries()) {
    if (!OUTBOUND_STRIP.has(key.toLowerCase())) {
      outboundHeaders.set(key, value);
    }
  }
  const targetHost = new URL(targetOrigin).host;
  outboundHeaders.set('host', targetHost);
  outboundHeaders.set('origin', targetOrigin);
  outboundHeaders.set('referer', targetOrigin + '/');

  // --- Fetch from upstream with manual redirect handling ---
  const upstream = await fetch(targetUrl.toString(), {
    method: request.method,
    headers: outboundHeaders,
    body: request.method !== 'GET' && request.method !== 'HEAD' ? request.body : undefined,
    redirect: 'manual',
  });

  // --- 3xx redirect rewriting ---
  if (upstream.status >= 300 && upstream.status < 400) {
    const location = upstream.headers.get('location');
    const modifiedHeaders = new Headers();

    for (const [k, v] of upstream.headers.entries()) {
      if (!STRIP_HEADERS.includes(k.toLowerCase())) {
        modifiedHeaders.set(k, v);
      }
    }

    // Inject CORS on redirect responses too
    for (const [k, v] of Object.entries(CORS_HEADERS)) {
      modifiedHeaders.set(k, v);
    }

    if (location) {
      modifiedHeaders.set('location', rewriteLocationHeader(location, targetOrigin, proxyPrefix));
    }

    return new Response(null, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: modifiedHeaders,
    });
  }

  // --- Build modified response headers ---
  const modifiedHeaders = new Headers();

  for (const [k, v] of upstream.headers.entries()) {
    // Skip set-cookie — handled separately below to preserve multiple values
    if (k.toLowerCase() === 'set-cookie') continue;
    if (STRIP_HEADERS.includes(k.toLowerCase())) continue;
    modifiedHeaders.set(k, v);
  }

  // Inject CORS headers
  for (const [k, v] of Object.entries(CORS_HEADERS)) {
    modifiedHeaders.set(k, v);
  }

  // Rewrite Set-Cookie headers (getAll is CF Workers-only, valid for set-cookie)
  for (const cookie of upstream.headers.getAll('set-cookie')) {
    modifiedHeaders.append('set-cookie', rewriteSetCookie(cookie));
  }

  // Rewrite x-pjax-url if present (some apps use pjax navigation)
  const pjaxUrl = upstream.headers.get('x-pjax-url');
  if (pjaxUrl) {
    modifiedHeaders.set('x-pjax-url', rewriteLocationHeader(pjaxUrl, targetOrigin, proxyPrefix));
  }

  const baseResponse = new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: modifiedHeaders,
  });

  const contentType = (modifiedHeaders.get('content-type') || '').toLowerCase();

  // HTML → stream through HTMLRewriter (URL rewrite + SRI strip + rewrite-shim injection)
  if (contentType.includes('text/html')) {
    return applyRewriter(baseResponse, targetOrigin, proxyPrefix, REWRITE_SHIM, allowSrc);
  }

  // CSS → rewrite url(...) refs and absolute target URLs so background-images/fonts resolve via proxy
  if (contentType.includes('text/css')) {
    const css = await baseResponse.text();
    return new Response(rewriteCss(css, targetOrigin, proxyPrefix), {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: modifiedHeaders,
    });
  }

  // Everything else (JS, JSON, images, fonts) — pass through unmodified
  return baseResponse;
}

/**
 * Rewrite URL references inside a CSS body so they route through the proxy:
 *   - Absolute target URLs (https://example.com/x) → proxyPrefix/x
 *   - Root-relative url(/x) → url(proxyPrefix/x)
 * Protocol-relative url(//host/x) is left untouched (resolves correctly via scheme).
 *
 * @param {string} css
 * @param {string} targetOrigin
 * @param {string} proxyPrefix
 * @returns {string}
 */
const rewriteCss = (css, targetOrigin, proxyPrefix) => {
  return css
    .split(targetOrigin).join(proxyPrefix)
    .replace(/url\(\s*(['"]?)\/(?!\/)/gi, `url($1${proxyPrefix}/`);
};
