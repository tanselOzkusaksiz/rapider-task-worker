#!/usr/bin/env node

/**
 * management-ui/server.js
 *
 * Standalone Admin Task Management & Monitoring Web UI Server.
 *   - Serves offline-ready static assets (`public/`, bundled Tailwind & FontAwesome)
 *     on `http://127.0.0.1:4310` (configurable via `MANAGEMENT_UI_PORT` / `MANAGEMENT_UI_HOST`).
 *   - Proxies `/api/*` requests cleanly to the Rapider Backend API (`RAPIDER_BACKEND_URL` /
 *     `BACKEND_URL`, defaulting to `http://localhost:8081`) forwarding ONLY the browser
 *     caller's `Authorization` header (never injecting server-side credentials!).
 */

const fs = require('fs');
const http = require('http');
const path = require('path');
const { loadCredentials } = require('../scripts/rapider-api-auth');

const PUBLIC_DIR = path.resolve(__dirname, 'public');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

function resolveBackendBaseUrl() {
  const creds = loadCredentials();
  return (
    process.env.RAPIDER_BACKEND_URL ||
    process.env.BACKEND_URL ||
    creds.backendUrl ||
    'http://localhost:8081'
  ).replace(/\/+$/, '');
}

function createManagementUiServer(options = {}) {
  const backendBaseUrl = (options.backendBaseUrl || resolveBackendBaseUrl()).replace(
    /\/+$/,
    ''
  );

  const server = http.createServer(async (req, res) => {
    try {
      const parsed = new URL(req.url || '/', 'http://localhost');

      if (parsed.pathname === '/healthz') {
        const body = JSON.stringify({
          ok: true,
          service: 'rapider-task-management-ui',
          backendBaseUrl,
        });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(body);
        return;
      }

      // Reverse-proxy `/api/*` -> `${backendBaseUrl}/*` using caller's own JWT header
      if (parsed.pathname === '/api' || parsed.pathname.startsWith('/api/')) {
        const upstreamPath = parsed.pathname.slice(4) || '/';
        const targetUrl = `${backendBaseUrl}${upstreamPath}${parsed.search || ''}`;

        const chunks = [];
        for await (const chunk of req) {
          chunks.push(chunk);
        }
        const rawBody = chunks.length > 0 ? Buffer.concat(chunks) : undefined;

        const forwardHeaders = {
          Accept: req.headers['accept'] || 'application/json',
        };
        if (req.headers['content-type']) {
          forwardHeaders['Content-Type'] = req.headers['content-type'];
        }
        if (req.headers['authorization']) {
          forwardHeaders['Authorization'] = req.headers['authorization'];
        }

        const upstreamRes = await fetch(targetUrl, {
          method: req.method || 'GET',
          headers: forwardHeaders,
          ...(rawBody && !['GET', 'HEAD'].includes((req.method || 'GET').toUpperCase())
            ? { body: rawBody }
            : {}),
        });

        const respBuf = Buffer.from(await upstreamRes.arrayBuffer());
        res.writeHead(upstreamRes.status, {
          'Content-Type':
            upstreamRes.headers.get('content-type') ||
            'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        res.end(respBuf);
        return;
      }

      // Serve static files from `public/`
      const relPath =
        parsed.pathname === '/'
          ? 'index.html'
          : parsed.pathname.replace(/^\/+/, '');
      const safeTarget = path.resolve(PUBLIC_DIR, relPath);
      if (!safeTarget.startsWith(PUBLIC_DIR)) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }

      let fileToServe = safeTarget;
      if (!fs.existsSync(fileToServe) || fs.statSync(fileToServe).isDirectory()) {
        fileToServe = path.join(PUBLIC_DIR, 'index.html');
      }

      const ext = path.extname(fileToServe).toLowerCase();
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';
      const content = fs.readFileSync(fileToServe);
      const isVendorAsset = relPath.startsWith('vendor/');
      res.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': isVendorAsset ? 'public, max-age=3600' : 'no-cache',
      });
      res.end(content);
    } catch (err) {
      const errBody = JSON.stringify({
        error: { message: `Management UI gateway error: ${err.message}` },
      });
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(errBody);
    }
  });

  return server;
}

if (require.main === module) {
  const port = parseInt(process.env.MANAGEMENT_UI_PORT || '4310', 10) || 4310;
  const host = process.env.MANAGEMENT_UI_HOST || '0.0.0.0';
  const backendBaseUrl = resolveBackendBaseUrl();
  const server = createManagementUiServer({ backendBaseUrl });
  server.listen(port, host, () => {
    console.log(
      `[TaskManagementUI] Listening on http://localhost:${port} (proxying /api -> ${backendBaseUrl})`
    );
  });
}

module.exports = {
  createManagementUiServer,
};

