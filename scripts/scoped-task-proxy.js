#!/usr/bin/env node

/**
 * scoped-task-proxy.js
 *
 * Host-side loopback (`127.0.0.1`) Capability Proxy for Isolated Sandboxed Tasks.
 *
 * SECURITY ARCHITECTURE:
 *   - Sandboxed `agy` workers NEVER receive `.env` files, database URIs, S3 secrets,
 *     or user/admin JWTs.
 *   - Instead, each active task receives a short-lived cryptographic `X-Task-Nonce`
 *     bound immutably on the host to ONE `projectId` (Workspace) and its allowlisted
 *     Workspace endpoints (`/project-data-manager/*`, `/message-templates*`,
 *     `/template-definitions*`, `/data-schemas*`).
 *   - Cross-tenant endpoints (`/admin/*`, `/users/*`, `/projects*`) are hard-blocked
 *     at the proxy layer, and all JSON responses pass through `redactSensitiveFields`.
 */

const http = require('http');
const crypto = require('crypto');
const {
  authenticateBase,
  switchActiveProject,
  fetchWithRetry,
} = require('./rapider-api-auth');
const { redactSensitiveFields } = require('./security-and-scope-guardrail');
const { compileAndVerifyHandlebarsPure } = require('./workspace-tools-cli');

const ALLOWED_WORKSPACE_PREFIXES = [
  '/project-data-manager/',
  '/project-models',
  '/data-schemas',
  '/message-templates',
  '/template-definitions',
  '/definitions',
];

const BLOCKED_PATH_SEGMENTS = [
  '/admin/',
  '/users',
  '/projects',
  '/api-key',
  '/git-infos',
  '/environment-variables',
  '/integration-providers',
];

function isAllowedWorkspaceApiPath(rawPath, method = 'GET') {
  const clean = String(rawPath || '').trim();
  if (!clean.startsWith('/') || clean.includes('..') || clean.startsWith('//')) {
    return false;
  }
  const lower = clean.toLowerCase();
  for (const blocked of BLOCKED_PATH_SEGMENTS) {
    if (lower.startsWith(blocked)) return false;
  }
  if (method.toUpperCase() === 'DELETE') {
    return false;
  }
  return ALLOWED_WORKSPACE_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

function readJsonBody(req, maxBytes = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error('Request payload exceeds 2MB proxy limit.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (err) {
        reject(new Error(`Invalid JSON body: ${err.message}`));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

class ScopedTaskProxyServer {
  constructor(options = {}) {
    this.host = '127.0.0.1';
    this.port = options.port || 0;
    this.leases = new Map();
    this.projectTokenCache = new Map();
    this.server = null;
    this.customHandler = options.customUpstreamFetch || null;
  }

  registerTaskLease({
    workItemId,
    projectId,
    workspaceName = '',
    allowedTables = null,
    ttlMs = 45 * 60 * 1000,
  }) {
    if (!workItemId || !projectId) {
      throw new Error('registerTaskLease requires both workItemId and projectId.');
    }
    const nonce = crypto.randomBytes(24).toString('hex');
    const lease = {
      nonce,
      workItemId: String(workItemId),
      projectId: String(projectId),
      workspaceName: String(workspaceName || projectId),
      allowedTables: Array.isArray(allowedTables) ? new Set(allowedTables) : null,
      createdAt: Date.now(),
      expiresAt: Date.now() + ttlMs,
    };
    this.leases.set(nonce, lease);
    return {
      nonce,
      proxyUrl: this.getBaseUrl(),
    };
  }

  revokeTaskLease(nonce) {
    if (nonce) this.leases.delete(nonce);
  }

  getBaseUrl() {
    if (!this.server) return null;
    const addr = this.server.address();
    if (!addr || typeof addr === 'string') return null;
    return `http://127.0.0.1:${addr.port}`;
  }

  async resolveProjectAuth(projectId) {
    if (this.customHandler) {
      return { backendUrl: 'http://mock.rapider.local', projectToken: 'mock-token' };
    }
    const cached = this.projectTokenCache.get(projectId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached;
    }
    const { token: baseToken, creds } = await authenticateBase();
    const projectToken = await switchActiveProject(creds, baseToken, projectId);
    const entry = {
      backendUrl: creds.backendUrl,
      projectToken,
      expiresAt: Date.now() + 8 * 60 * 1000,
    };
    this.projectTokenCache.set(projectId, entry);
    return entry;
  }

  async upstreamFetch(projectId, endpointPath, init = {}) {
    if (this.customHandler) {
      return this.customHandler(projectId, endpointPath, init);
    }
    const { backendUrl, projectToken } = await this.resolveProjectAuth(projectId);
    const headers = {
      Accept: 'application/json',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      Authorization: projectToken,
    };
    const res = await fetchWithRetry(`${backendUrl}${endpointPath}`, {
      method: init.method || 'GET',
      headers,
      ...(init.body ? { body: init.body } : {}),
    });
    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : null;
    } catch (_) {
      json = { rawText: text };
    }
    return { ok: res.ok, status: res.status, data: redactSensitiveFields(json) };
  }

  async handleRequest(req, res) {
    try {
      const nonce = String(req.headers['x-task-nonce'] || '').trim();
      const lease = nonce ? this.leases.get(nonce) : null;
      if (!lease || lease.expiresAt < Date.now()) {
        if (lease) this.leases.delete(nonce);
        return sendJson(res, 401, {
          error: 'Unauthorized or expired X-Task-Nonce capability token.',
        });
      }

      const parsedUrl = new URL(req.url || '/', 'http://127.0.0.1');
      const pathname = parsedUrl.pathname;
      const method = (req.method || 'GET').toUpperCase();

      if (method === 'GET' && pathname === '/task-proxy/context') {
        return sendJson(res, 200, {
          ok: true,
          workItemId: lease.workItemId,
          projectId: lease.projectId,
          workspaceName: lease.workspaceName,
          allowedTables: lease.allowedTables ? Array.from(lease.allowedTables) : null,
        });
      }

      if (method === 'GET' && pathname === '/task-proxy/models') {
        const filter = JSON.stringify({
          include: [
            { relation: 'projectModelFields' },
            { relation: 'projectModelRelations' },
          ],
        });
        const upstream = await this.upstreamFetch(
          lease.projectId,
          `/project-models?filter=${encodeURIComponent(filter)}`
        );
        return sendJson(res, upstream.status, upstream.data);
      }

      if (method === 'GET' && pathname === '/task-proxy/templates') {
        const [msgTemplates, templateDefs] = await Promise.all([
          this.upstreamFetch(lease.projectId, '/message-templates'),
          this.upstreamFetch(lease.projectId, '/template-definitions'),
        ]);
        return sendJson(res, 200, {
          messageTemplates: msgTemplates.data || [],
          templateDefinitions: templateDefs.data || [],
        });
      }

      const dataMatch = pathname.match(/^\/task-proxy\/data\/([a-zA-Z0-9._-]+)(\/count)?$/);
      if (method === 'GET' && dataMatch) {
        const table = dataMatch[1];
        const isCount = Boolean(dataMatch[2]);
        if (lease.allowedTables && !lease.allowedTables.has(table)) {
          return sendJson(res, 403, {
            error: `Table "${table}" is not in this Workspace's authorized model list.`,
          });
        }
        const qs = parsedUrl.search || '';
        const target = isCount
          ? `/project-data-manager/${encodeURIComponent(table)}/count${qs}`
          : `/project-data-manager/${encodeURIComponent(table)}${qs}`;
        const upstream = await this.upstreamFetch(lease.projectId, target);
        return sendJson(res, upstream.status, upstream.data);
      }

      if (method === 'POST' && pathname === '/task-proxy/templates/message') {
        const body = await readJsonBody(req);
        const key = String(body.key || '').trim();
        const content = String(body.content || '');
        if (!key || !content.trim()) {
          return sendJson(res, 400, { error: 'key and content are required.' });
        }
        // Compile-verify Handlebars syntax before persisting
        compileAndVerifyHandlebarsPure(content, body.sampleData || {});

        const existingRes = await this.upstreamFetch(
          lease.projectId,
          `/message-templates?filter=${encodeURIComponent(JSON.stringify({ where: { key } }))}`
        );
        const existingList = Array.isArray(existingRes.data) ? existingRes.data : [];
        const payload = {
          key,
          subject: body.subject || key,
          content,
          type: body.type || 'EMAIL',
          environmentKey: body.environmentKey || 'DEV',
        };

        if (existingList.length > 0 && existingList[0].id) {
          const updated = await this.upstreamFetch(
            lease.projectId,
            `/message-templates/${encodeURIComponent(existingList[0].id)}`,
            { method: 'PATCH', body: JSON.stringify(payload) }
          );
          return sendJson(res, updated.status, {
            ok: updated.ok,
            action: 'updated',
            id: existingList[0].id,
            key,
          });
        }

        const created = await this.upstreamFetch(
          lease.projectId,
          '/message-templates',
          { method: 'POST', body: JSON.stringify(payload) }
        );
        return sendJson(res, created.status, {
          ok: created.ok,
          action: 'created',
          template: created.data,
        });
      }

      if (method === 'POST' && pathname === '/task-proxy/workspace-api') {
        const body = await readJsonBody(req);
        const targetMethod = String(body.method || 'GET').toUpperCase();
        const targetPath = String(body.path || '').trim();
        if (!isAllowedWorkspaceApiPath(targetPath, targetMethod)) {
          return sendJson(res, 403, {
            error: `Endpoint "${targetMethod} ${targetPath}" is blocked by the Workspace Capability Proxy.`,
          });
        }
        const upstream = await this.upstreamFetch(lease.projectId, targetPath, {
          method: targetMethod,
          ...(body.body !== undefined ? { body: JSON.stringify(body.body) } : {}),
        });
        return sendJson(res, upstream.status, upstream.data);
      }

      return sendJson(res, 404, { error: `Unknown proxy endpoint: ${method} ${pathname}` });
    } catch (err) {
      return sendJson(res, 500, { error: err.message });
    }
  }

  async start() {
    if (this.server) return this.getBaseUrl();
    this.server = http.createServer((req, res) => this.handleRequest(req, res));
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.port, this.host, resolve);
    });
    return this.getBaseUrl();
  }

  async stop() {
    this.leases.clear();
    if (!this.server) return;
    const srv = this.server;
    this.server = null;
    await new Promise((resolve) => srv.close(() => resolve()));
  }
}

module.exports = {
  ScopedTaskProxyServer,
  isAllowedWorkspaceApiPath,
};
