#!/usr/bin/env node

/**
 * rapider-api-auth.js
 *
 * Strictly project-agnostic and environment-driven authentication helper for
 * rapider-task-worker (ISOLATED-TASK-WORKER).
 *
 * SECURITY RULE (ZERO TOLERANCE):
 * Never hardcode credentials, tokens, user emails, passwords, or project IDs in
 * source files. All configuration is loaded dynamically from process.env and
 * gitignored .env files.
 */

const fs = require('fs');
const path = require('path');

const WORKER_ROOT = path.resolve(__dirname, '..');

/**
 * Parses a .env file into a key-value map without mutating process.env.
 *
 * @param {string} filePath Absolute path to an env file.
 * @returns {Record<string, string>}
 */
function parseEnvFile(filePath) {
  const result = {};
  if (!filePath || !fs.existsSync(filePath)) return result;
  try {
    const lines = fs.readFileSync(filePath, 'utf8').split('\n');
    for (const rawLine of lines) {
      const trimmed = rawLine.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx <= 0) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim().replace(/^['"]|['"]$/g, '');
      result[key] = val;
    }
  } catch (_) {}
  return result;
}

/**
 * Loads runtime credentials and endpoint configuration from process.env or local
 * gitignored .env files (without any hardcoded user/project/secret defaults).
 *
 * @returns {{
 *   backendUrl: string,
 *   username: string,
 *   password: string,
 *   serviceToken: string,
 *   defaultProjectId: string
 * }}
 */
function loadCredentials() {
  const candidateEnvFiles = [
    path.resolve(WORKER_ROOT, '.env'),
    path.resolve(WORKER_ROOT, '../rapider-apps/rapider-apps-development/.env'),
    path.resolve(WORKER_ROOT, '../rapider-app-harness/.env'),
    path.resolve(WORKER_ROOT, '../.env'),
  ];

  const mergedFileEnv = {};
  for (let i = candidateEnvFiles.length - 1; i >= 0; i--) {
    Object.assign(mergedFileEnv, parseEnvFile(candidateEnvFiles[i]));
  }

  const getVal = (...keys) => {
    for (const k of keys) {
      if (process.env[k] && String(process.env[k]).trim()) {
        return String(process.env[k]).trim();
      }
    }
    for (const k of keys) {
      if (mergedFileEnv[k] && String(mergedFileEnv[k]).trim()) {
        return String(mergedFileEnv[k]).trim();
      }
    }
    return '';
  };

  const backendUrl = getVal('RAPIDER_API_URL', 'BACKEND_URL').replace(/\/+$/, '');
  const username = getVal('RAPIDER_WORKER_EMAIL', 'RAPIDER_USERNAME', 'HARNESS_TEST_EMAIL');
  const password = getVal('RAPIDER_WORKER_PASSWORD', 'RAPIDER_PASSWORD', 'HARNESS_TEST_PASSWORD');
  const serviceToken = getVal('RAPIDER_SERVICE_TOKEN', 'RAPIDER_AUTH_TOKEN', 'RAPIDER_API_KEY');
  const defaultProjectId = getVal('RAPIDER_DEFAULT_PROJECT_ID', 'HARNESS_TEST_PROJECT_ID');

  if (!backendUrl) {
    throw new Error(
      'Missing RAPIDER_API_URL (or BACKEND_URL) in environment or gitignored .env file.'
    );
  }
  if (!serviceToken && (!username || !password)) {
    throw new Error(
      'Missing worker credentials in environment/.env: set RAPIDER_WORKER_EMAIL + RAPIDER_WORKER_PASSWORD (or RAPIDER_SERVICE_TOKEN).'
    );
  }

  return {
    backendUrl,
    username,
    password,
    serviceToken,
    defaultProjectId,
  };
}

/**
 * Dynamically loads DigitalOcean Spaces / S3 credentials from process.env or
 * gitignored server .env for task attachment image downloads only.
 *
 * @returns {{ accessKeyId: string, secretAccessKey: string, endpointUrl: string }}
 */
function loadSpacesCredentialsFromEnv() {
  const serverEnvPath = path.resolve(WORKER_ROOT, '../rapider-server/rappider/.server.env');
  const localEnvPath = path.resolve(WORKER_ROOT, '.env');
  const fileVars = {
    ...parseEnvFile(serverEnvPath),
    ...parseEnvFile(localEnvPath),
  };

  return {
    accessKeyId:
      process.env.SPACES_KEY ||
      process.env.AWS_ACCESS_KEY_ID ||
      fileVars.SPACES_KEY ||
      fileVars.AWS_ACCESS_KEY_ID ||
      '',
    secretAccessKey:
      process.env.SPACES_SECRET ||
      process.env.AWS_SECRET_ACCESS_KEY ||
      fileVars.SPACES_SECRET ||
      fileVars.AWS_SECRET_ACCESS_KEY ||
      '',
    endpointUrl:
      process.env.SPACES_ENDPOINT_URL ||
      fileVars.SPACES_ENDPOINT_URL ||
      'https://nyc3.digitaloceanspaces.com',
  };
}

/**
 * Resilient HTTP fetch wrapper with linear/exponential backoff on transient socket errors.
 *
 * @param {string} url Request URL
 * @param {RequestInit} [options] Fetch options
 * @param {number} [retries=3] Max retry attempts
 * @returns {Promise<Response>}
 */
async function fetchWithRetry(url, options = {}, retries = 3) {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      return await fetch(url, options);
    } catch (err) {
      if (attempt === retries - 1) throw err;
      await new Promise((resolve) => setTimeout(resolve, 600 * (attempt + 1)));
    }
  }
  throw new Error(`Unreachable fetch state for ${url}`);
}

/**
 * Formats Authorization header consistently (`Bearer <jwt>` unless already prefixed).
 *
 * @param {string} rawToken Token string
 * @returns {string}
 */
function normalizeAuthHeader(rawToken) {
  if (!rawToken) return '';
  const trimmed = String(rawToken).trim();
  if (/^(Bearer|ApiKey)\s+/i.test(trimmed)) return trimmed;
  return trimmed;
}

/**
 * Acquires a base person-scoped authentication token from Rapider API.
 * Does NOT assume a hardcoded projectId; call `switchActiveProject()` per task!
 *
 * @param {ReturnType<typeof loadCredentials>} [credsInput]
 * @returns {Promise<{ token: string, personId: string | null, creds: ReturnType<typeof loadCredentials> }>}
 */
async function authenticateBase(credsInput) {
  const creds = credsInput || loadCredentials();

  if (creds.serviceToken) {
    return {
      token: normalizeAuthHeader(creds.serviceToken),
      personId: null,
      creds,
    };
  }

  const loginRes = await fetchWithRetry(`${creds.backendUrl}/users/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: creds.username, password: creds.password }),
  });
  const loginData = await loginRes.json().catch(() => ({}));
  if (!loginRes.ok || !loginData.authenticationToken) {
    throw new Error(`Worker login failed (HTTP ${loginRes.status}). Check RAPIDER_WORKER_EMAIL / RAPIDER_WORKER_PASSWORD.`);
  }

  let token = loginData.authenticationToken;
  let personId = null;

  const peopleRes = await fetchWithRetry(`${creds.backendUrl}/users/people`, {
    headers: { Authorization: token },
  });
  if (peopleRes.ok) {
    const peopleData = await peopleRes.json().catch(() => []);
    const people = Array.isArray(peopleData) ? peopleData : peopleData.people || [];
    if (people.length > 0 && people[0]?.id) {
      personId = people[0].id;
      const personRes = await fetchWithRetry(`${creds.backendUrl}/users/change-active-person`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: token },
        body: JSON.stringify({ personId }),
      });
      const personSwitch = await personRes.json().catch(() => ({}));
      if (personSwitch.authenticationToken) {
        token = personSwitch.authenticationToken;
      }
    }
  }

  return { token, personId, creds };
}

/**
 * Exchanges a base token for a strictly isolated project-scoped token (`projectId`).
 *
 * @param {ReturnType<typeof loadCredentials>} creds
 * @param {string} baseToken
 * @param {string} projectId Target Workspace Project ID
 * @returns {Promise<string>} Project-scoped authorization token
 */
async function switchActiveProject(creds, baseToken, projectId) {
  if (!projectId || !String(projectId).trim()) {
    throw new Error('switchActiveProject requires a non-empty projectId.');
  }
  const res = await fetchWithRetry(`${creds.backendUrl}/users/change-active-project`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: baseToken,
    },
    body: JSON.stringify({ projectId: String(projectId).trim() }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      `Failed to switch active project to ${projectId} (HTTP ${res.status}): ${data?.error?.message || 'Forbidden'}`
    );
  }
  return data.authenticationToken || baseToken;
}

module.exports = {
  parseEnvFile,
  loadCredentials,
  loadSpacesCredentialsFromEnv,
  fetchWithRetry,
  authenticateBase,
  switchActiveProject,
};

