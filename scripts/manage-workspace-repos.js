#!/usr/bin/env node

/**
 * manage-workspace-repos.js
 *
 * Implements the Orphan `idle` Branch Workspace Repo Isolation Protocol for
 * rapider-task-worker (ISOLATED-TASK-WORKER):
 *
 *   - All Workspace checkouts live under `rapider-task-worker/WORKSPACES/<projectId>/`.
 *   - At most ONE Workspace repository is checked out on `main` at any moment.
 *   - All other Workspace repositories are parked on an orphan `idle` branch
 *     containing ONLY a minimal `README.md` (<500 bytes) so inactive workspaces
 *     cannot leak context or bloat search/indexing tools.
 *   - Upon `--activate=<projectId>`, pulls remote git repo (if configured via
 *     `/git-infos`) AND synchronizes a sanitized read-only Workspace Context
 *     Snapshot (`models/`, `schemas/`, `templates/`, `apps/`, `mcp/`,
 *     `WORKSPACE_CONTEXT.md`) with all secret/token fields redacted.
 *
 * Usage:
 *   node scripts/manage-workspace-repos.js --status
 *   node scripts/manage-workspace-repos.js --activate=<projectId> [--offline]
 *   node scripts/manage-workspace-repos.js --park=<projectId>
 *   node scripts/manage-workspace-repos.js --park-all
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const {
  authenticateBase,
  switchActiveProject,
  fetchWithRetry,
} = require('./rapider-api-auth');
const { redactSensitiveFields } = require('./security-and-scope-guardrail');

const WORKER_ROOT = path.resolve(__dirname, '..');
const DEFAULT_WORKSPACES_ROOT = path.resolve(WORKER_ROOT, 'WORKSPACES');

function sanitizeFolderSegment(raw) {
  const cleaned = String(raw || '').trim();
  if (!/^[a-zA-Z0-9._-]+$/.test(cleaned) || cleaned.includes('..')) {
    throw new Error(`Invalid workspace identifier "${raw}".`);
  }
  return cleaned;
}

function git(cwd, args, opts = {}) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: opts.stdio || (opts.input !== undefined ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe']),
    ...(opts.input !== undefined ? { input: opts.input } : {}),
  }).trim();
}

function refExists(cwd, ref) {
  try {
    execFileSync('git', ['show-ref', '--verify', '--quiet', ref], {
      cwd,
      stdio: 'ignore',
    });
    return true;
  } catch (_) {
    return false;
  }
}

function getCurrentBranch(cwd) {
  try {
    return git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  } catch (_) {
    return 'unknown';
  }
}

function buildIdleReadme(projectId, workspaceName = '') {
  const label = workspaceName ? `${workspaceName} (${projectId})` : projectId;
  return [
    `# Workspace ${label} — Parked (Idle Branch)`,
    ``,
    `This Workspace repository is parked on the orphan **\`idle\`** branch to maintain strict multi-tenant context isolation.`,
    ``,
    `Activate via:`,
    `\`\`\`bash`,
    `node scripts/manage-workspace-repos.js --activate=${projectId}`,
    `\`\`\``,
    ``,
  ].join('\n');
}

/**
 * Ensures `repoDir` is a valid git repository with both `main` and an orphan `idle`
 * branch containing only `README.md`.
 */
function ensureGitRepoAndIdleBranch(repoDir, projectId, workspaceName = '') {
  fs.mkdirSync(repoDir, { recursive: true });

  if (!fs.existsSync(path.join(repoDir, '.git'))) {
    git(repoDir, ['init', '-b', 'main']);
    git(repoDir, ['config', 'user.name', 'Rapider Task Worker']);
    git(repoDir, ['config', 'user.email', 'task-worker@rapider.local']);
    const readmePath = path.join(repoDir, 'README.md');
    if (!fs.existsSync(readmePath)) {
      fs.writeFileSync(
        readmePath,
        `# Workspace Repository (${workspaceName || projectId})\n`,
        'utf8'
      );
    }
    git(repoDir, ['add', 'README.md']);
    git(repoDir, ['commit', '--no-gpg-sign', '-m', 'chore: initialize workspace repository']);
  } else {
    try {
      git(repoDir, ['config', 'user.name']);
    } catch (_) {
      git(repoDir, ['config', 'user.name', 'Rapider Task Worker']);
      git(repoDir, ['config', 'user.email', 'task-worker@rapider.local']);
    }
  }

  if (!refExists(repoDir, 'refs/heads/idle')) {
    const idleReadme = buildIdleReadme(projectId, workspaceName);
    const blobHash = git(repoDir, ['hash-object', '-w', '--stdin'], { input: idleReadme });
    const treeInput = `100644 blob ${blobHash}\tREADME.md\n`;
    const treeHash = git(repoDir, ['mktree'], { input: treeInput });
    const commitHash = git(repoDir, ['commit-tree', treeHash, '-m', 'chore: create orphan idle branch']);
    git(repoDir, ['branch', 'idle', commitHash]);
  }
}

/**
 * Parks a single Workspace repository onto its orphan `idle` branch and cleans
 * untracked snapshot artifacts so zero schema/data files linger at rest.
 */
function parkWorkspaceRepo(projectId, options = {}) {
  const workspacesRoot = options.workspacesRoot || DEFAULT_WORKSPACES_ROOT;
  const safeId = sanitizeFolderSegment(projectId);
  const repoDir = path.join(workspacesRoot, safeId);

  if (!fs.existsSync(repoDir) || !fs.existsSync(path.join(repoDir, '.git'))) {
    return { projectId: safeId, parked: false, reason: 'Not cloned' };
  }

  ensureGitRepoAndIdleBranch(repoDir, safeId);

  const branch = getCurrentBranch(repoDir);
  if (branch !== 'idle') {
    // Commit any snapshot updates on local main before switching to idle so main stays clean
    const dirty = git(repoDir, ['status', '--porcelain']);
    if (dirty) {
      git(repoDir, ['add', '-A']);
      try {
        git(repoDir, ['commit', '--no-gpg-sign', '-m', 'chore(snapshot): update workspace metadata snapshot']);
      } catch (_) {}
    }
    git(repoDir, ['checkout', '-f', 'idle']);
    git(repoDir, ['clean', '-fd']);
  }

  return { projectId: safeId, parked: true, branch: 'idle' };
}

/**
 * Parks all Workspace repositories under `WORKSPACES/` onto `idle`.
 */
function parkAllWorkspaceRepos(options = {}) {
  const workspacesRoot = options.workspacesRoot || DEFAULT_WORKSPACES_ROOT;
  if (!fs.existsSync(workspacesRoot)) return [];

  const entries = fs.readdirSync(workspacesRoot, { withFileTypes: true }).filter((d) => d.isDirectory());
  const results = [];
  for (const dir of entries) {
    try {
      results.push(parkWorkspaceRepo(dir.name, { workspacesRoot }));
    } catch (err) {
      results.push({ projectId: dir.name, parked: false, error: err.message });
    }
  }
  return results;
}

/**
 * Synchronizes sanitized Workspace metadata (`models/`, `schemas/`, `templates/`,
 * `apps/`, `mcp/`, `WORKSPACE_CONTEXT.md`) from the Rapider API into the active
 * `WORKSPACES/<projectId>/` directory.
 */
async function syncWorkspaceMetadataSnapshot(repoDir, projectId) {
  const { token: baseToken, creds } = await authenticateBase();
  const projectToken = await switchActiveProject(creds, baseToken, projectId);
  const headers = { Authorization: projectToken };

  const fetchJsonSafe = async (endpointPath) => {
    try {
      const res = await fetchWithRetry(`${creds.backendUrl}${endpointPath}`, { headers });
      if (!res.ok) return [];
      const data = await res.json().catch(() => []);
      return redactSensitiveFields(data);
    } catch (_) {
      return [];
    }
  };

  // Fetch workspace entity metadata in parallel
  const [
    projectsList,
    projectModelsRaw,
    dataSchemasRaw,
    messageTemplatesRaw,
    templateDefsRaw,
    dataSourcesRaw,
    gitInfoRaw,
  ] = await Promise.all([
    fetchJsonSafe('/projects'),
    fetchJsonSafe('/project-models?filter=' + encodeURIComponent(JSON.stringify({ include: [{ relation: 'projectModelFields' }, { relation: 'projectModelRelations' }] }))),
    fetchJsonSafe('/data-schemas'),
    fetchJsonSafe('/message-templates'),
    fetchJsonSafe('/template-definitions'),
    fetchJsonSafe('/data-sources'),
    fetchJsonSafe('/git-infos'),
  ]);

  const matchedProject = Array.isArray(projectsList)
    ? projectsList.find((p) => p && p.id === projectId)
    : null;
  const workspaceName = matchedProject?.name || projectId;

  const projectModels = Array.isArray(projectModelsRaw)
    ? projectModelsRaw
    : await fetchJsonSafe('/project-models');
  const modelsList = Array.isArray(projectModels) ? projectModels : [];
  const dataSchemas = Array.isArray(dataSchemasRaw) ? dataSchemasRaw : [];
  const messageTemplates = Array.isArray(messageTemplatesRaw) ? messageTemplatesRaw : [];
  const templateDefs = Array.isArray(templateDefsRaw) ? templateDefsRaw : [];
  const dataSources = Array.isArray(dataSourcesRaw) ? dataSourcesRaw : [];

  const dirs = ['models', 'schemas', 'templates', 'mcp', 'docs'];
  for (const sub of dirs) {
    fs.mkdirSync(path.join(repoDir, sub), { recursive: true });
  }

  fs.writeFileSync(
    path.join(repoDir, 'models/project-models.json'),
    JSON.stringify(modelsList, null, 2),
    'utf8'
  );
  for (const model of modelsList) {
    const tableKey = String(model.dataTableName || model.name || model.id || 'model')
      .replace(/[^a-zA-Z0-9._-]/g, '_');
    fs.writeFileSync(
      path.join(repoDir, 'models', `${tableKey}.model.json`),
      JSON.stringify(model, null, 2),
      'utf8'
    );
  }

  fs.writeFileSync(
    path.join(repoDir, 'schemas/data-schemas.json'),
    JSON.stringify(dataSchemas, null, 2),
    'utf8'
  );
  fs.writeFileSync(
    path.join(repoDir, 'templates/message-templates.json'),
    JSON.stringify(messageTemplates, null, 2),
    'utf8'
  );
  fs.writeFileSync(
    path.join(repoDir, 'templates/template-definitions.json'),
    JSON.stringify(templateDefs, null, 2),
    'utf8'
  );
  fs.writeFileSync(
    path.join(repoDir, 'mcp/datasources-and-tools.json'),
    JSON.stringify(dataSources, null, 2),
    'utf8'
  );

  // Build concise AI-readable WORKSPACE_CONTEXT.md
  const modelLines =
    modelsList.length === 0
      ? '_No ProjectModels defined in this Workspace._'
      : modelsList
          .map((m) => {
            const fields = Array.isArray(m.projectModelFields)
              ? m.projectModelFields.map((f) => `${f.key || f.name} (${f.type || 'any'})`).join(', ')
              : 'see `models/' + (m.dataTableName || m.name || m.id) + '.model.json`';
            return `- **${m.name || m.dataTableName}** — Table: \`${m.dataTableName || m.name}\` | Endpoint: \`/project-data-manager/${m.dataTableName || m.name}\` | Fields: ${fields}`;
          })
          .join('\n');

  const templateLines =
    messageTemplates.length === 0 && templateDefs.length === 0
      ? '_No existing templates registered yet._'
      : [
          ...messageTemplates.map(
            (t) => `- **MessageTemplate (Handlebars):** \`${t.key}\` (\`env: ${t.environmentKey}\`, \`type: ${t.type}\`, subject: "${t.subject || ''}")`
          ),
          ...templateDefs.map(
            (t) => `- **TemplateDefinition:** \`${t.key}\` — ${t.description || 'No description'}`
          ),
        ].join('\n');

  const dsLines =
    dataSources.length === 0
      ? '_No external DataSources / MCP connectors configured._'
      : dataSources
          .map(
            (ds) =>
              `- **${ds.name || ds.key || ds.id}** (\`id: ${ds.id}\`, type: \`${ds.type || ds.provider || 'connector'}\`)`
          )
          .join('\n');

  const contextMd = [
    `# Workspace Context Snapshot — ${workspaceName}`,
    ``,
    `- **Workspace Name:** ${workspaceName}`,
    `- **Project ID:** \`${projectId}\``,
    `- **Synced At (UTC):** \`${new Date().toISOString()}\``,
    gitInfoRaw && gitInfoRaw.repoName ? `- **Remote Git Repo:** \`${gitInfoRaw.repoName}\`` : `- **Remote Git Repo:** _(Workspace API-managed)_`,
    ``,
    `---`,
    ``,
    `## 1. Workspace Database Models (\`/project-data-manager/{dataTableName}\`)`,
    ``,
    modelLines,
    ``,
    `---`,
    ``,
    `## 2. Workspace Templates (\`templates/\`)`,
    ``,
    templateLines,
    ``,
    `---`,
    ``,
    `## 3. Configured Workspace Connectors & MCP DataSources (\`mcp/\`)`,
    ``,
    dsLines,
    ``,
  ].join('\n');

  fs.writeFileSync(path.join(repoDir, 'WORKSPACE_CONTEXT.md'), contextMd, 'utf8');

  return {
    workspaceName,
    modelsCount: modelsList.length,
    templatesCount: messageTemplates.length + templateDefs.length,
    dataSourcesCount: dataSources.length,
    remoteRepoName: gitInfoRaw && gitInfoRaw.repoName ? gitInfoRaw.repoName : null,
  };
}

/**
 * Activates `WORKSPACES/<projectId>/` on `main` after parking all other workspaces to `idle`.
 */
async function activateWorkspaceRepo(projectId, options = {}) {
  const workspacesRoot = options.workspacesRoot || DEFAULT_WORKSPACES_ROOT;
  const offline = Boolean(options.offline);
  const safeId = sanitizeFolderSegment(projectId);

  fs.mkdirSync(workspacesRoot, { recursive: true });

  // 1. Park every other workspace repo to `idle` first
  const existingDirs = fs
    .readdirSync(workspacesRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== safeId);

  for (const dir of existingDirs) {
    parkWorkspaceRepo(dir.name, { workspacesRoot });
  }

  // 2. Ensure target repo exists & checkout `main`
  const repoDir = path.join(workspacesRoot, safeId);
  ensureGitRepoAndIdleBranch(repoDir, safeId);

  const currentBranch = getCurrentBranch(repoDir);
  if (currentBranch !== 'main') {
    if (refExists(repoDir, 'refs/heads/main')) {
      git(repoDir, ['checkout', '-f', 'main']);
    } else {
      git(repoDir, ['checkout', '-b', 'main']);
    }
  }

  let syncSummary = null;
  if (!offline) {
    syncSummary = await syncWorkspaceMetadataSnapshot(repoDir, safeId);
    const dirty = git(repoDir, ['status', '--porcelain']);
    if (dirty) {
      git(repoDir, ['add', '-A']);
      try {
        git(repoDir, ['commit', '--no-gpg-sign', '-m', `chore(snapshot): sync workspace ${safeId} context`]);
      } catch (_) {}
    }
  }

  return {
    projectId: safeId,
    repoDir,
    branch: 'main',
    syncSummary,
  };
}

/**
 * Lists active vs parked status for all Workspace folders under `WORKSPACES/`.
 */
function getWorkspaceReposStatus(options = {}) {
  const workspacesRoot = options.workspacesRoot || DEFAULT_WORKSPACES_ROOT;
  if (!fs.existsSync(workspacesRoot)) return [];

  return fs
    .readdirSync(workspacesRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const repoDir = path.join(workspacesRoot, d.name);
      const branch = fs.existsSync(path.join(repoDir, '.git')) ? getCurrentBranch(repoDir) : 'uninitialized';
      return {
        projectId: d.name,
        branch,
        state: branch === 'idle' ? 'PARKED (idle)' : `ACTIVE (${branch})`,
        repoDir,
      };
    });
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const getArg = (name) => {
    const prefix = `--${name}=`;
    const hit = args.find((a) => a.startsWith(prefix));
    return hit ? hit.slice(prefix.length) : null;
  };
  const hasFlag = (flag) => args.includes(`--${flag}`);

  (async () => {
    const activateId = getArg('activate') || getArg('project');
    const parkId = getArg('park');

    if (hasFlag('park-all')) {
      const res = parkAllWorkspaceRepos();
      console.log(`[WorkspaceRepos] Parked ${res.length} workspace repo(s) onto 'idle'.`);
      return;
    }

    if (parkId) {
      const res = parkWorkspaceRepo(parkId);
      console.log(`[WorkspaceRepos] Parked ${res.projectId} -> branch '${res.branch || 'N/A'}'.`);
      return;
    }

    if (activateId && !hasFlag('status')) {
      const res = await activateWorkspaceRepo(activateId, { offline: hasFlag('offline') });
      console.log(
        `[WorkspaceRepos] Activated WORKSPACES/${res.projectId} on '${res.branch}'` +
          (res.syncSummary
            ? ` (Models: ${res.syncSummary.modelsCount}, Templates: ${res.syncSummary.templatesCount}, Connectors: ${res.syncSummary.dataSourcesCount})`
            : '')
      );
      return;
    }

    const statuses = getWorkspaceReposStatus();
    console.log('===============================================================');
    console.log('          ISOLATED WORKSPACE REPOSITORIES STATUS               ');
    console.log('===============================================================');
    if (statuses.length === 0) {
      console.log('No Workspace repositories cloned yet under WORKSPACES/.');
    } else {
      for (const s of statuses) {
        console.log(`  - ${s.projectId.padEnd(38)} | ${s.state}`);
      }
    }
  })().catch((err) => {
    console.error(`[WorkspaceRepos] Fatal error: ${err.message}`);
    process.exit(1);
  });
}

module.exports = {
  ensureGitRepoAndIdleBranch,
  parkWorkspaceRepo,
  parkAllWorkspaceRepos,
  activateWorkspaceRepo,
  getWorkspaceReposStatus,
  syncWorkspaceMetadataSnapshot,
};
