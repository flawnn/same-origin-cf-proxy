import { handleProxy, handleHostProxy, CORS_HEADERS } from './proxy.js';

const USAGE = 'Reverse proxy. Configure PROXY_TARGETS, then request /proxy/<name>/<path>.\n';

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);

    // Preflight — respond immediately with CORS headers
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 200, headers: CORS_HEADERS });
    }

    // Generic host proxy for runtime API subdomains (e.g. /proxy/h/api.example.com/...)
    if (pathname.startsWith('/proxy/h/')) {
      return handleHostProxy(request, env);
    }

    // Named proxy: /proxy/<name>/... → target from PROXY_TARGETS. All methods (apps may POST).
    const match = pathname.match(/^\/proxy\/([^/]+)\//);
    if (match) {
      return handleProxy(request, env, match[1]);
    }

    // Root — usage hint
    if (request.method === 'GET' && pathname === '/') {
      return new Response(USAGE, { headers: { 'content-type': 'text/plain' } });
    }

    return new Response('not found', { status: 404 });
  },
};
