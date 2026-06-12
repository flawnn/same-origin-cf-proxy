// REWRITE_SHIM is injected into every proxied HTML page so the app's *runtime* requests
// (API calls, lazy-loaded assets, SPA navigation) stay routed through the proxy. Server-side
// HTML/CSS rewriting only catches URLs in the initial markup — it can't catch URLs an app
// constructs in JavaScript at runtime, which is what this client shim handles.
//
// It is a self-contained IIFE: no telemetry, no event capture, no external dependencies.
// Per-target values (entryHost, allow) are injected by the Worker as window.__RP_CONFIG.
export const REWRITE_SHIM = `(function() {
  const PROXY_ORIGIN = self.location.origin;
  const CFG = self.__RP_CONFIG || {};
  const ENTRY_HOST = CFG.entryHost || '';                          // the main proxied site's host
  const ALLOW_RE = CFG.allow ? new RegExp(CFG.allow, 'i') : null;  // extra hosts → generic /proxy/h/

  // Derive current proxy prefix from the page pathname: /proxy/<name>/page → /proxy/<name>
  // Must be computed BEFORE replaceState below, which changes location.pathname.
  const _pathParts = self.location.pathname.split('/');
  const CURRENT_PREFIX = _pathParts.length >= 3 && _pathParts[1] === 'proxy'
    ? '/' + _pathParts[1] + '/' + _pathParts[2]
    : null;

  // Strip the proxy prefix from the visible URL so an SPA router sees its own route (e.g. /page,
  // not /proxy/<name>/page). Must run synchronously before the app bundle executes.
  if (CURRENT_PREFIX) {
    const stripped = self.location.pathname.slice(CURRENT_PREFIX.length) || '/';
    try { history.replaceState(null, '', stripped + self.location.search + self.location.hash); } catch (_) {}
  }

  // Map the entry host, allowlisted external hosts, and root-relative paths back through the proxy.
  function rewriteUrl(url) {
    if (!url || url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('#')) return url;
    try {
      const u = new URL(url, self.location.href);
      if (ENTRY_HOST && u.hostname === ENTRY_HOST && CURRENT_PREFIX) {
        return PROXY_ORIGIN + CURRENT_PREFIX + u.pathname + u.search + u.hash;
      }
      if (ALLOW_RE && u.origin !== PROXY_ORIGIN && ALLOW_RE.test(u.hostname)) {
        return PROXY_ORIGIN + '/proxy/h/' + u.hostname + u.pathname + u.search + u.hash;
      }
      if (CURRENT_PREFIX && u.origin === PROXY_ORIGIN && !u.pathname.startsWith('/proxy/')) {
        return PROXY_ORIGIN + CURRENT_PREFIX + u.pathname + u.search + u.hash;
      }
    } catch (_) {}
    return url;
  }

  // fetch patch — rewrite URLs before requests go out
  const _fetch = self.fetch.bind(self);
  self.fetch = function(input, init) {
    const url = typeof input === 'string' ? input
      : input instanceof Request ? input.url
      : String(input);
    const rewritten = rewriteUrl(url);
    if (rewritten !== url) {
      input = typeof input === 'string' ? rewritten : new Request(rewritten, input);
    }
    return _fetch(input, init);
  };

  // XHR patch
  const _open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    return _open.call(this, method, rewriteUrl(url), ...rest);
  };

  // Property-setter patching — catches asset URLs assigned imperatively (e.g. new Image().src),
  // which bypass fetch/XHR and race the MutationObserver.
  function patchUrlSetter(proto, attr) {
    if (!proto) return;
    const desc = Object.getOwnPropertyDescriptor(proto, attr);
    if (!desc || !desc.set) return;
    Object.defineProperty(proto, attr, {
      configurable: true,
      enumerable: desc.enumerable,
      get() { return desc.get.call(this); },
      set(v) { desc.set.call(this, typeof v === 'string' ? rewriteUrl(v) : v); },
    });
  }
  patchUrlSetter(self.HTMLImageElement && HTMLImageElement.prototype, 'src');
  patchUrlSetter(self.HTMLScriptElement && HTMLScriptElement.prototype, 'src');
  patchUrlSetter(self.HTMLMediaElement && HTMLMediaElement.prototype, 'src');
  patchUrlSetter(self.HTMLSourceElement && HTMLSourceElement.prototype, 'src');
  patchUrlSetter(self.HTMLLinkElement && HTMLLinkElement.prototype, 'href');

  // setAttribute fallback — catches el.setAttribute('src'|'href'|'action', ...)
  const _setAttr = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function(name, value) {
    if (typeof value === 'string' && (name === 'src' || name === 'href' || name === 'action' || name === 'xlink:href')) {
      value = rewriteUrl(value);
    }
    return _setAttr.call(this, name, value);
  };

  // postMessage patch — some apps hardcode a foreign target origin for parent messaging, which the
  // browser rejects because the proxy parent is a different origin. Relax it so the message delivers.
  function patchPostMessage(win) {
    if (!win) return;
    try { if (win.__rp_pm_patched) return; } catch (_) { return; }
    let orig;
    try { orig = win.postMessage; } catch (_) { return; }
    if (typeof orig !== 'function') return;
    const bound = orig.bind(win);
    try {
      win.__rp_pm_patched = true;
      win.postMessage = function(message, targetOrigin, transfer) {
        const relaxed = (targetOrigin && targetOrigin !== '*' && targetOrigin !== PROXY_ORIGIN) ? '*' : targetOrigin;
        return bound(message, relaxed, transfer);
      };
    } catch (_) {}
  }
  patchPostMessage(self);
  if (self.parent && self.parent !== self) patchPostMessage(self.parent);
  if (self.top && self.top !== self && self.top !== self.parent) patchPostMessage(self.top);

  // MutationObserver — rewrite src/href on elements added dynamically after the initial parse.
  new MutationObserver(function(mutations) {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== 1) continue; // element nodes only
        const tag = node.tagName;
        if (tag === 'IMG' || tag === 'LINK') {
          const attr = tag === 'IMG' ? 'src' : 'href';
          const val = node.getAttribute(attr);
          if (val) { const rw = rewriteUrl(val); if (rw !== val) node.setAttribute(attr, rw); }
        } else if (tag === 'A') {
          const val = node.getAttribute('href');
          if (val) { const rw = rewriteUrl(val); if (rw !== val) node.setAttribute('href', rw); }
        } else if (tag === 'SCRIPT') {
          // src can't change after a script is appended — clone with a rewritten src and replace.
          const val = node.getAttribute('src');
          if (val) {
            const rw = rewriteUrl(val);
            if (rw !== val) {
              const clone = node.cloneNode(true);
              clone.setAttribute('src', rw);
              node.parentNode.replaceChild(clone, node);
            }
          }
        }
      }
    }
  }).observe(document.documentElement, { subtree: true, childList: true });
})()`;
