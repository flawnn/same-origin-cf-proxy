// makeUrlHandler — rewrite absolute URLs that point to targetOrigin into proxyPrefix-relative paths.
// Handlers MUST be synchronous — no async/await inside HTMLRewriter element handlers.
const makeUrlHandler = (attrName, targetOrigin, proxyPrefix) => ({
  element(el) {
    const val = el.getAttribute(attrName);
    if (!val) return;
    const targetHost = new URL(targetOrigin).host;
    if (val.startsWith(targetOrigin)) {
      el.setAttribute(attrName, proxyPrefix + val.slice(targetOrigin.length));
    } else if (val.startsWith('//' + targetHost)) {
      el.setAttribute(attrName, proxyPrefix + val.slice(2 + targetHost.length));
    } else if (val.startsWith('/') && !val.startsWith('//')) {
      // Root-relative paths (e.g. /assets/index.js) resolve against the proxy origin, not the target.
      // Prepend the proxy prefix so they route through the Worker to the target.
      el.setAttribute(attrName, proxyPrefix + val);
    }
    // Truly relative paths (no leading /) resolve correctly via <base> tag or current path
  }
});

/**
 * Apply CF HTMLRewriter to an HTML response:
 *   - Strip SRI integrity + crossorigin attributes
 *   - Rewrite absolute URLs (a, link, script, img, form) to proxy prefix
 *   - Rewrite <base href> to prevent bypassing proxy routing
 *   - Inject the client URL-rewriting shim at start of <head>
 *
 * @param {Response} response
 * @param {string}   targetOrigin - e.g. "https://example.com"
 * @param {string}   proxyPrefix  - e.g. "/proxy/example"
 * @param {string}   shimScript   - raw JS source to inject (no <script> wrapper)
 * @returns {Response}
 */
export function applyRewriter(response, targetOrigin, proxyPrefix, shimScript, allowSrc) {
  // Guard — only transform HTML responses
  const ct = response.headers.get('content-type') || '';
  if (!ct.includes('text/html')) return response;

  return new HTMLRewriter()
    // SRI strip — browsers enforce integrity checks; remove them so rewritten content passes
    .on('script[integrity]', { element(el) { el.removeAttribute('integrity'); } })
    .on('link[integrity]',   { element(el) { el.removeAttribute('integrity'); } })
    // crossorigin strip — without crossorigin, browser ignores remaining integrity attr
    .on('script[crossorigin]', { element(el) { el.removeAttribute('crossorigin'); } })
    .on('link[crossorigin]',   { element(el) { el.removeAttribute('crossorigin'); } })
    // URL rewriting — absolute URLs pointing to targetOrigin → proxyPrefix path
    .on('a[href]',       makeUrlHandler('href',   targetOrigin, proxyPrefix))
    .on('link[href]',    makeUrlHandler('href',   targetOrigin, proxyPrefix))
    .on('script[src]',   makeUrlHandler('src',    targetOrigin, proxyPrefix))
    .on('img[src]',      makeUrlHandler('src',    targetOrigin, proxyPrefix))
    .on('form[action]',  makeUrlHandler('action', targetOrigin, proxyPrefix))
    // base tag rewriting — <base href="https://example.com/"> would bypass proxy routing
    .on('base[href]', {
      element(el) {
        const href = el.getAttribute('href');
        if (href && href.startsWith(targetOrigin)) {
          el.setAttribute('href', proxyPrefix + '/');
        }
      }
    })
    // Inject per-target config + URL-rewriting shim at start of <head> — prepend so they run
    // before page scripts. Config tells the shim which host maps to this proxy prefix.
    .on('head', {
      element(el) {
        const cfg = JSON.stringify({
          entryHost: new URL(targetOrigin).host,
          prefix: proxyPrefix,
          allow: allowSrc || '',
        });
        el.prepend(
          `<script>window.__RP_CONFIG=${cfg};</script><script>${shimScript}</script>`,
          { html: true },
        );
      }
    })
    .transform(response);
}
