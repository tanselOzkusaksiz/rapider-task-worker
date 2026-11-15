#!/usr/bin/env node

/**
 * prepare-workspace-repo.js
 *
 * Deterministic Pre-Task Workspace Git Repository Preparation Pipeline for
 * `rapider-task-worker` (both Parallel Isolated Task Orchestrator and Single Worker).
 *
 * Before any Rapider task (`WorkItem` with `kind: "task"`) starts, this module:
 *   1. Resolves the Workspace's GitHub repository name (`GitInfo.repoName`, e.g.
 *      `${projectName}--${projectId}`), checks whether it exists on the physical
 *      drive, switches to the branch specified in the task (or `main` if no branch
 *      is specified), and pulls the latest remote commits (`git pull`).
 *   2. Fetches the Workspace's full Project Models, Fields & Relations AI context
 *      from `GET /project-models/model-descriptions-for-ai-context` and overwrites
 *      `<repo root>/.agents/project-data-models.md`.
 *   3. Updates `<repo root>/AGENTS.md` to reference the prepared `.agents/*.md`,
 *      `_notebooks/`, and `*.env` files, and generates/overwrites
 *      `<repo root>/.agents/project-data-manager-guide.md` explaining how the
 *      isolated AI reads, filters, counts, creates, bulk-inserts, updates, and
 *      soft-deletes Workspace data via `/project-data-manager/{dataTableName}`
 *      (including an exact `Entity -> dataTableName` lookup table).
 *   4. Inspects all Workspace `DataSource`s, connected OAuth integrations (e.g.
 *      Jira, Slack, Google Drive, GitHub, Salesforce via Nango), MCP servers,
 *      OpenAPI specs, and dynamic capabilities, and overwrites
 *      `<repo root>/.agents/workspace-datasources-and-integrations.md` with live
 *      tool schemas and invocation instructions.
 *   5. Syncs all Workspace Notebooks / Knowledge Spaces (metadata in Rapider
 *      MongoDB / space manifests + Markdown content in DigitalOcean Spaces S3,
 *      plus legacy `ProjectFolder`/`ProjectDocument` files) into
 *      `<repo root>/_notebooks/` preserving full folder/page hierarchy.
 *   6. Generates and overwrites `<repo root>/dev.env`, `<repo root>/stage.env`,
 *      and `<repo root>/prod.env` from Workspace `ProjectSetting` (shared across
 *      environments) and `EnvironmentVariable` (`DEV`, `QA`/`STAGE`, `PROD`)
 *      records in Rapider MongoDB, matching Rapider's Project Code Generator.
 *   7. Stages and commits all overwritten/updated files onto the Workspace branch
 *      so the branch reflects the exact latest Workspace state before task launch.
 *
 * Usage:
 *   node scripts/prepare-workspace-repo.js --project=<projectId> [--branch=main]
 *   node scripts/prepare-workspace-repo.js --project=<projectId> --step=models
 *   node scripts/prepare-workspace-repo.js --project=<projectId> --step=datasources
 *   node scripts/prepare-workspace-repo.js --project=<projectId> --step=notebooks
 *   node scripts/prepare-workspace-repo.js --project=<projectId> --step=envs
 */

const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const {
  authenticateBase,
  switchActiveProject,
  fetchWithRetry,
} = require('./rapider-api-auth');
const { redactSensitiveFields } = require('./security-and-scope-guardrail');

const WORKER_ROOT = path.resolve(__dirname, '..');
const DEFAULT_WORKSPACES_ROOT = path.resolve(WORKER_ROOT, 'WORKSPACES');

const MANAGED_AGENTS_BLOCK_START = '<!-- BEGIN RAPIDER WORKSPACE CONTEXT -->';
const MANAGED_AGENTS_BLOCK_END = '<!-- END RAPIDER WORKSPACE CONTEXT -->';

const MANAGED_COMMIT_PATHS = [
  'AGENTS.md',
  '.agents/project-data-models.md',
  '.agents/project-data-manager-guide.md',
  '.agents/workspace-datasources-and-integrations.md',
  '_notebooks',
  'dev.env',
  'stage.env',
  'prod.env',
];

// ─────────────────────────────────────────────────────────────────────────────
// Pure Helpers & Sanitizers
// ─────────────────────────────────────────────────────────────────────────────

function sanitizeFolderSegment(raw) {
  const cleaned = String(raw || '').trim();
  if (!/^[a-zA-Z0-9._-]+$/.test(cleaned) || cleaned.includes('..')) {
    throw new Error(`Invalid repository or workspace identifier "${raw}".`);
  }
  return cleaned;
}

function sanitizePathSegment(raw, fallback = 'item') {
  const cleaned = String(raw || '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96);
  return cleaned || fallback;
}

function sanitizeGitBranchName(rawBranch) {
  if (!rawBranch || typeof rawBranch !== 'string') return 'main';
  const trimmed = rawBranch.trim().replace(/^refs\/heads\//, '');
  if (
    !trimmed ||
    trimmed === 'idle' ||
    trimmed === 'HEAD' ||
    trimmed.startsWith('-') ||
    trimmed.includes('..') ||
    trimmed.includes('@{') ||
    !/^[a-zA-Z0-9._/-]+$/.test(trimmed)
  ) {
    return 'main';
  }
  return trimmed;
}

/**
 * Deterministically resolves the target git branch from a Rapider WorkItem task.
 * Defaults to `'main'` when no branch is specified on the task.
 */
function extractTaskTargetBranch(workItem) {
  if (!workItem || typeof workItem !== 'object') return 'main';
  const candidates = [
    workItem.branch,
    workItem.branchName,
    workItem.gitBranch,
    workItem.targetBranch,
    workItem.source?.branch,
    workItem.source?.branchName,
    workItem.metadata?.branch,
    workItem.metadata?.branchName,
    workItem.payload?.branch,
    workItem.context?.branch,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) {
      return sanitizeGitBranchName(c);
    }
  }
  return 'main';
}

/**
 * Computes the canonical expected GitHub repository name matching Rapider's
 * `GitInfoRepository.calculateRemoteRepoName` and `project-generator.service.ts`
 * (`${project.key}--${projectId}`, or slugified `${project.name}--${projectId}`).
 *
 * Accepts either a `Project` object (`{ key, name }`) or a string (`keyOrName`).
 */
function calculateExpectedWorkspaceRepoName(projectOrName, projectId) {
  const safeId = sanitizeFolderSegment(projectId);
  const rawKey =
    projectOrName && typeof projectOrName === 'object'
      ? String(projectOrName.key || '').trim()
      : '';
  const rawName =
    projectOrName && typeof projectOrName === 'object'
      ? String(projectOrName.name || projectOrName.workspaceName || '').trim()
      : String(projectOrName || '').trim();

  if (
    rawKey &&
    /^[a-zA-Z0-9._-]+$/.test(rawKey) &&
    !rawKey.includes('..') &&
    rawKey.toLowerCase() !== safeId.toLowerCase()
  ) {
    return `${rawKey}--${safeId}`;
  }

  const slug = (rawKey || rawName || 'workspace')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');

  const prefix = !slug || slug === safeId.toLowerCase() ? 'workspace' : slug;
  return `${prefix}--${safeId}`;
}

const calculateFallbackRepoName = calculateExpectedWorkspaceRepoName;

function normalizeLf(text) {
  return String(text || '').replace(/\r\n/g, '\n').trimEnd() + '\n';
}

const NON_INTERACTIVE_GIT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_MERGE_AUTOEDIT: 'no',
};

function git(cwd, args, opts = {}) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: opts.timeout || 60000,
    env: NON_INTERACTIVE_GIT_ENV,
    stdio:
      opts.stdio ||
      (opts.input !== undefined ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe']),
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

function hasAnyCommits(cwd) {
  try {
    execFileSync('git', ['rev-parse', '--verify', 'HEAD'], {
      cwd,
      stdio: 'ignore',
    });
    return true;
  } catch (_) {
    return false;
  }
}

function getRemotes(cwd) {
  try {
    const out = git(cwd, ['remote']);
    return out
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  } catch (_) {
    return [];
  }
}

function ensureIdleOrphanBranch(repoDir, projectId, workspaceName = '') {
  if (refExists(repoDir, 'refs/heads/idle')) return;
  const label = workspaceName ? `${workspaceName} (${projectId})` : projectId;
  const idleReadme = [
    `# Workspace ${label} — Parked (Idle Branch)`,
    ``,
    `This Workspace repository is parked on the orphan **\`idle\`** branch to maintain strict multi-tenant context isolation.`,
    ``,
  ].join('\n');
  const blobHash = git(repoDir, ['hash-object', '-w', '--stdin'], { input: idleReadme });
  const treeInput = `100644 blob ${blobHash}\tREADME.md\n`;
  const treeHash = git(repoDir, ['mktree'], { input: treeInput });
  const commitHash = git(repoDir, [
    'commit-tree',
    treeHash,
    '-m',
    'chore: create orphan idle branch',
  ]);
  git(repoDir, ['branch', 'idle', commitHash]);
}

function ensureGitAuthorConfig(repoDir) {
  try {
    git(repoDir, ['config', 'user.name']);
  } catch (_) {
    git(repoDir, ['config', 'user.name', 'Rapider Task Orchestrator']);
    git(repoDir, ['config', 'user.email', 'task-orchestrator@rapider.local']);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 1: Physical GitHub Repo Resolution, Branch Checkout & `git pull`
// ─────────────────────────────────────────────────────────────────────────────

function ensureRemoteGithubRepoCli({
  githubOwner,
  repoName,
  description = '',
  customRemoteRepoCreator = null,
}) {
  if (typeof customRemoteRepoCreator === 'function') {
    const res = customRemoteRepoCreator({ githubOwner, repoName, description });
    return {
      created: Boolean(res?.created ?? res),
      remoteUrl: res?.remoteUrl || null,
    };
  }

  const safeOwner = String(githubOwner || '').trim();
  const safeRepo = String(repoName || '').trim();
  if (
    !safeOwner ||
    !safeRepo ||
    !/^[a-zA-Z0-9._-]+$/.test(safeOwner) ||
    !/^[a-zA-Z0-9._-]+$/.test(safeRepo) ||
    process.env.IS_GITHUB_INTEGRATION_ENABLED === 'false'
  ) {
    return { created: false, remoteUrl: null };
  }

  const checkRes = spawnSync('gh', ['api', `/repos/${safeOwner}/${safeRepo}`], {
    encoding: 'utf8',
    timeout: 20000,
    env: NON_INTERACTIVE_GIT_ENV,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (checkRes.status === 0) {
    return { created: false, remoteUrl: `git@github.com:${safeOwner}/${safeRepo}.git` };
  }

  const createArgs = ['repo', 'create', `${safeOwner}/${safeRepo}`, '--private'];
  if (description) {
    createArgs.push('--description', String(description).slice(0, 200));
  }
  const templateRepo = process.env.BOILERPLATE_BUNDLE_1_REPOSITORY_URL || '';
  if (templateRepo && /^[a-zA-Z0-9._/-]+$/.test(templateRepo)) {
    createArgs.push('--template', templateRepo);
  }

  const createRes = spawnSync('gh', createArgs, {
    encoding: 'utf8',
    timeout: 45000,
    env: NON_INTERACTIVE_GIT_ENV,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  return {
    created: createRes.status === 0,
    remoteUrl:
      createRes.status === 0 ? `git@github.com:${safeOwner}/${safeRepo}.git` : null,
  };
}

/**
 * Resolves the physical repository directory on disk for a Workspace, checking:
 *   1. `<codeGenReposRoot>/<expectedRepoName>` (if `RAPIDER_CODEGEN_REPOS_DIR` is set & exists)
 *   2. `<workspacesRoot>/<expectedRepoName>` (canonical GitHub repo name `${project.key}--${projectId}`)
 *   3. Any existing `<workspacesRoot>/*--<projectId>` git folder
 *   4. Legacy `<workspacesRoot>/<projectId>` folder (migrated to `<workspacesRoot>/<expectedRepoName>`)
 *
 * If the repo exists on disk, switches to `targetBranch` (or `main` if unspecified)
 * and pulls the latest commits from `origin` when online.
 * If no repo exists yet, creates the repository with the expected name (`${project.key}--${projectId}`)
 * both on GitHub (when configured) and on the physical drive (`WORKSPACES/<expectedRepoName>`).
 */
function preparePhysicalGitRepo({
  projectId,
  workspaceName = '',
  workspaceKey = '',
  repoName = null,
  remoteUrl = null,
  targetBranch = 'main',
  workspacesRoot = DEFAULT_WORKSPACES_ROOT,
  codeGenReposRoot = process.env.RAPIDER_CODEGEN_REPOS_DIR || null,
  offline = false,
  customRemoteRepoCreator = null,
}) {
  const safeId = sanitizeFolderSegment(projectId);
  const expectedRepoName = repoName
    ? sanitizeFolderSegment(repoName)
    : calculateExpectedWorkspaceRepoName(
        { key: workspaceKey, name: workspaceName },
        safeId
      );
  const branch = sanitizeGitBranchName(targetBranch);

  fs.mkdirSync(workspacesRoot, { recursive: true });

  const canonicalWorkspaceDir = path.join(workspacesRoot, expectedRepoName);
  const legacyBareIdDir = path.join(workspacesRoot, safeId);

  // Migrate legacy bare `<workspacesRoot>/<projectId>` checkout to `<workspacesRoot>/<expectedRepoName>`
  if (
    expectedRepoName !== safeId &&
    !fs.existsSync(canonicalWorkspaceDir) &&
    fs.existsSync(path.join(legacyBareIdDir, '.git'))
  ) {
    fs.renameSync(legacyBareIdDir, canonicalWorkspaceDir);
  }

  const candidateDirs = [];
  if (codeGenReposRoot) {
    candidateDirs.push(path.resolve(codeGenReposRoot, expectedRepoName));
  }
  candidateDirs.push(canonicalWorkspaceDir);

  // Also check if another `<prefix>--<projectId>` directory already exists under `workspacesRoot`
  const existingSuffixed = fs
    .readdirSync(workspacesRoot, { withFileTypes: true })
    .find(
      (d) =>
        d.isDirectory() &&
        d.name.endsWith(`--${safeId}`) &&
        fs.existsSync(path.join(workspacesRoot, d.name, '.git'))
    );
  if (existingSuffixed) {
    candidateDirs.push(path.join(workspacesRoot, existingSuffixed.name));
  }

  let repoDir = candidateDirs.find((dir) => fs.existsSync(path.join(dir, '.git'))) || null;
  let existedOnDisk = Boolean(repoDir);
  let clonedFromRemote = false;
  let pulledFromRemote = false;
  let createdLocalRepo = false;
  let createdRemoteRepo = false;

  const githubOwner =
    process.env.RAPIDER_GITHUB_OWNER || process.env.GITHUB_OWNER || '';
  let effectiveRemoteUrl =
    remoteUrl ||
    (githubOwner
      ? `git@github.com:${githubOwner}/${expectedRepoName}.git`
      : null);

  if (!repoDir) {
    // Always create missing Workspace repo under its expected `${project.key}--${projectId}` folder!
    repoDir = canonicalWorkspaceDir;

    if (!offline && (effectiveRemoteUrl || githubOwner || customRemoteRepoCreator)) {
      if (effectiveRemoteUrl) {
        const cloneRes = spawnSync(
          'git',
          ['clone', '--no-tags', effectiveRemoteUrl, repoDir],
          {
            encoding: 'utf8',
            timeout: 90000,
            env: NON_INTERACTIVE_GIT_ENV,
            stdio: ['ignore', 'pipe', 'pipe'],
          }
        );
        if (cloneRes.status === 0 && fs.existsSync(path.join(repoDir, '.git'))) {
          clonedFromRemote = true;
        } else {
          fs.rmSync(repoDir, { recursive: true, force: true });
        }
      }

      // Remote repo did not exist yet -> create remote repo with expected name!
      if (!clonedFromRemote && (githubOwner || customRemoteRepoCreator)) {
        const ensuredRemote = ensureRemoteGithubRepoCli({
          githubOwner,
          repoName: expectedRepoName,
          description: workspaceName || expectedRepoName,
          customRemoteRepoCreator,
        });
        if (ensuredRemote.created) {
          createdRemoteRepo = true;
          if (ensuredRemote.remoteUrl) {
            effectiveRemoteUrl = ensuredRemote.remoteUrl;
          }
          // Try cloning in case remote repo was created from a non-empty boilerplate template
          if (effectiveRemoteUrl) {
            const retryClone = spawnSync(
              'git',
              ['clone', '--no-tags', effectiveRemoteUrl, repoDir],
              {
                encoding: 'utf8',
                timeout: 90000,
                env: NON_INTERACTIVE_GIT_ENV,
                stdio: ['ignore', 'pipe', 'pipe'],
              }
            );
            if (retryClone.status === 0 && fs.existsSync(path.join(repoDir, '.git'))) {
              clonedFromRemote = true;
            } else {
              fs.rmSync(repoDir, { recursive: true, force: true });
            }
          }
        }
      }
    }

    // Initialize local physical repository on `main` (and `targetBranch`) with expected name!
    if (!fs.existsSync(path.join(repoDir, '.git'))) {
      fs.mkdirSync(repoDir, { recursive: true });
      git(repoDir, ['init', '-b', 'main']);
      ensureGitAuthorConfig(repoDir);
      const readmePath = path.join(repoDir, 'README.md');
      if (!fs.existsSync(readmePath)) {
        fs.writeFileSync(
          readmePath,
          `# ${workspaceName || expectedRepoName}\n\nRepository: \`${expectedRepoName}\`\n`,
          'utf8'
        );
      }
      git(repoDir, ['add', 'README.md']);
      git(repoDir, [
        'commit',
        '--no-gpg-sign',
        '-m',
        `chore: initialize workspace repository ${expectedRepoName}`,
      ]);
      if (branch !== 'main') {
        git(repoDir, ['checkout', '-b', branch]);
      }
      if (effectiveRemoteUrl) {
        try {
          git(repoDir, ['remote', 'add', 'origin', effectiveRemoteUrl]);
        } catch (_) {}
      }
      createdLocalRepo = true;
    }
  } else if (effectiveRemoteUrl && getRemotes(repoDir).length === 0) {
    try {
      git(repoDir, ['remote', 'add', 'origin', effectiveRemoteUrl]);
    } catch (_) {}
  }

  ensureGitAuthorConfig(repoDir);
  ensureIdleOrphanBranch(repoDir, safeId, workspaceName);

  const remotes = getRemotes(repoDir);
  const hasOrigin = remotes.includes('origin');

  // Fetch latest remote refs when online & `origin` remote is configured
  if (!offline && hasOrigin) {
    spawnSync('git', ['fetch', 'origin', '--prune'], {
      cwd: repoDir,
      encoding: 'utf8',
      timeout: 60000,
      env: NON_INTERACTIVE_GIT_ENV,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }

  // Discard any untracked debris left on `idle` before switching branches
  try {
    const curr = git(repoDir, ['rev-parse', '--abbrev-ref', 'HEAD']);
    if (curr === 'idle') {
      git(repoDir, ['clean', '-fd']);
    }
  } catch (_) {}

  // Checkout targetBranch (or create from origin/<branch> / main)
  const localBranchRef = `refs/heads/${branch}`;
  const remoteBranchRef = `refs/remotes/origin/${branch}`;

  if (refExists(repoDir, localBranchRef)) {
    git(repoDir, ['checkout', '-f', branch]);
  } else if (hasOrigin && refExists(repoDir, remoteBranchRef)) {
    git(repoDir, ['checkout', '-B', branch, `origin/${branch}`]);
  } else if (branch !== 'main' && refExists(repoDir, 'refs/heads/main')) {
    git(repoDir, ['checkout', '-B', branch, 'main']);
  } else if (branch !== 'main' && hasOrigin && refExists(repoDir, 'refs/remotes/origin/main')) {
    git(repoDir, ['checkout', '-B', branch, 'origin/main']);
  } else {
    git(repoDir, ['checkout', '-b', branch]);
  }

  // Pull latest changes from `origin/<branch>` if it exists on the remote
  if (!offline && hasOrigin && refExists(repoDir, remoteBranchRef) && !clonedFromRemote) {
    const pullFf = spawnSync('git', ['pull', '--ff-only', 'origin', branch], {
      cwd: repoDir,
      encoding: 'utf8',
      timeout: 60000,
      env: NON_INTERACTIVE_GIT_ENV,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (pullFf.status === 0) {
      pulledFromRemote = true;
    } else {
      // Fallback: merge preferring remote changes so diverged histories reconcile cleanly
      const mergeRes = spawnSync(
        'git',
        ['merge', '--no-edit', '-X', 'theirs', `origin/${branch}`],
        {
          cwd: repoDir,
          encoding: 'utf8',
          timeout: 60000,
          env: NON_INTERACTIVE_GIT_ENV,
          stdio: ['ignore', 'pipe', 'pipe'],
        }
      );
      if (mergeRes.status === 0) {
        pulledFromRemote = true;
      } else {
        spawnSync('git', ['merge', '--abort'], {
          cwd: repoDir,
          env: NON_INTERACTIVE_GIT_ENV,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      }
    }
  } else if (clonedFromRemote) {
    pulledFromRemote = true;
  }

  return {
    repoDir,
    repoName: path.basename(repoDir),
    expectedRepoName,
    branch,
    existedOnDisk,
    createdLocalRepo,
    createdRemoteRepo,
    clonedFromRemote,
    pulledFromRemote,
    hasOrigin,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 2 & 3: `.agents/project-data-models.md` + `.agents/project-data-manager-guide.md`
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pure fallback formatter producing the exact same Markdown layout as Rapider's
 * `GET /project-models/model-descriptions-for-ai-context` (`buildProjectModelsContextString`).
 */
function buildProjectModelsContextMarkdownPure(models = []) {
  const sorted = [...(Array.isArray(models) ? models : [])].sort((a, b) =>
    String(a?.title || a?.name || '').localeCompare(String(b?.title || b?.name || ''))
  );

  if (sorted.length === 0) {
    return normalizeLf(
      [
        'Project Data Models Context:',
        '',
        'No project data models are currently defined in this Workspace.',
      ].join('\n')
    );
  }

  const blocks = ['Project Data Models Context:', ''];

  for (const model of sorted) {
    const entityTitle = model.title || model.name || model.dataTableName || 'Unnamed Entity';
    const desc = model.description ? String(model.description).trim() : 'No description provided.';
    blocks.push(`Entity: ${entityTitle}`);
    blocks.push(`Entity Description: ${desc}`);
    blocks.push('');
    blocks.push('Available Fields:');

    const fields = Array.isArray(model.projectModelFields) ? model.projectModelFields : [];
    if (fields.length === 0) {
      blocks.push('No custom fields defined.');
    } else {
      for (const f of fields) {
        const fKey = f.key || f.name || 'field';
        const fType = f.isArray ? `${f.type || 'any'}[]` : f.type || 'string';
        const fDesc = f.description ? `: ${String(f.description).trim()}` : '';
        blocks.push(`- ${fKey}  (${fType})${fDesc}`);
      }
    }

    blocks.push('');
    blocks.push('Available Relations:');
    const relations = Array.isArray(model.projectModelRelations)
      ? model.projectModelRelations
      : [];
    if (relations.length === 0) {
      blocks.push('No relations defined.');
    } else {
      for (const rel of relations) {
        const rName = rel.name || rel.key || 'relation';
        const rType = rel.type || 'belongsTo';
        const targetTitle =
          rel.targetModelTitle || rel.targetModelName || rel.referencedModelId || 'Entity';
        const keyFrom = rel.sourceFieldKey || rel.foreignKey || 'id';
        const keyTo = rel.targetFieldKey || 'id';
        const rDesc = rel.description ? `: ${String(rel.description).trim()}` : '';
        blocks.push(`- ${rName} (${rType} -> ${targetTitle}) [${keyFrom} -> ${keyTo}]${rDesc}`);
      }
    }

    blocks.push('');
    blocks.push('---');
    blocks.push('');
  }

  return normalizeLf(blocks.join('\n'));
}

/**
 * Pure generator for `<repo root>/.agents/project-data-manager-guide.md`.
 * Connects `.agents/project-data-models.md` (`Entity: <Title>`) directly to
 * Rapider's `ProjectDataManagerController` (`/project-data-manager/{dataTableName}`).
 */
function buildProjectDataManagerGuideMarkdownPure({
  projectId,
  workspaceName = '',
  models = [],
}) {
  const sortedModels = [...(Array.isArray(models) ? models : [])].sort((a, b) =>
    String(a?.title || a?.name || '').localeCompare(String(b?.title || b?.name || ''))
  );

  const lookupRows =
    sortedModels.length === 0
      ? '| _(No models defined)_ | — | — | — | — |'
      : sortedModels
          .map((m) => {
            const entityTitle = String(m.title || m.name || m.dataTableName || '').replace(/\|/g, '\\|');
            const modelName = String(m.name || m.dataTableName || '').replace(/\|/g, '\\|');
            const tableName = String(m.dataTableName || m.name || '').replace(/\|/g, '\\|');
            const fieldCount = Array.isArray(m.projectModelFields)
              ? m.projectModelFields.length
              : 0;
            const relNames = Array.isArray(m.projectModelRelations)
              ? m.projectModelRelations
                  .map((r) => r.name || r.key)
                  .filter(Boolean)
                  .join(', ')
              : '';
            return `| **${entityTitle}** | \`${modelName}\` | \`${tableName}\` | ${fieldCount} field(s) | ${relNames ? `\`${relNames}\`` : '_None_'} |`;
          })
          .join('\n');

  const exampleTable =
    (sortedModels[0] && (sortedModels[0].dataTableName || sortedModels[0].name)) ||
    'expenses';

  return normalizeLf(
    [
      `# Workspace Project Data Manager Guide (\`/project-data-manager/{dataTableName}\`)`,
      ``,
      `- **Workspace:** ${workspaceName || projectId} (\`${projectId}\`)`,
      `- **Canonical Model Definitions:** [\`.agents/project-data-models.md\`](./project-data-models.md)`,
      ``,
      `This guide explains how an isolated AI agent reads, filters, counts, creates, bulk-inserts, updates, and soft-deletes live Workspace data using the entity definitions in \`.agents/project-data-models.md\` and Rapider's **Project Data Manager API**.`,
      ``,
      `---`,
      ``,
      `## 1. Entity to \`dataTableName\` Mapping Table`,
      ``,
      `\`.agents/project-data-models.md\` lists each model by its display **\`Entity:\`** title along with \`Available Fields:\` and \`Available Relations:\`. When calling \`/project-data-manager/{dataTableName}\`, always pass the exact **\`dataTableName\`** column below:`,
      ``,
      `| Entity (in \`project-data-models.md\`) | Model Name | \`dataTableName\` (API Path Param) | Fields | Relations (\`include\`) |`,
      `| --- | --- | --- | --- | --- |`,
      lookupRows,
      ``,
      `> **Automatic System Fields on Every Record:** Every record automatically carries \`id\` (UUID primary key), \`projectId\`, \`createdDate\`, \`updatedDate\`, \`createdByPersonId\`, and \`isDeleted\`. Soft-deleted rows (\`isDeleted: true\`) are **automatically excluded** on the server by \`project-data-manager\` — do **not** add manual \`isDeleted\` filters to \`where\` clauses.`,
      ``,
      `---`,
      ``,
      `## 2. How to Call \`project-data-manager\` from the Isolated Agent`,
      ``,
      `### Mode A — Inside Isolated Task Sandbox (\`rapider-task-cli.js\` / Capability Proxy — Preferred)`,
      `Inside the isolated task worker, authentication to Workspace \`${projectId}\` is injected automatically by the loopback capability proxy (\`$RAPIDER_TASK_PROXY_URL\` + \`$RAPIDER_TASK_NONCE\`):`,
      ``,
      `\`\`\`bash`,
      `# 1. Paginated / bulk read (auto-paginates when --all is passed)`,
      `node ../tools/rapider-task-cli.js query-data --table=${exampleTable} --all --out=../output/rows.json`,
      ``,
      `# 2. Filtered read with LoopBack 4 where / order / include / fields`,
      `node ../tools/rapider-task-cli.js query-data --table=${exampleTable} --filter='{"where":{"status":"active"},"order":["createdDate DESC"],"limit":50}'`,
      ``,
      `# 3. Count matching records`,
      `node ../tools/rapider-task-cli.js count-data --table=${exampleTable} --where='{"status":"active"}'`,
      ``,
      `# 4. Fetch a single record by ID (with optional relations)`,
      `node ../tools/rapider-task-cli.js get-record --table=${exampleTable} --id="<record-uuid>" --filter='{"include":[{"relation":"attachments"}]}'`,
      ``,
      `# 5. Create a single record (validated against the entity schema in project-data-models.md)`,
      `node ../tools/rapider-task-cli.js create-record --table=${exampleTable} --data='{"status":"open"}'`,
      ``,
      `# 6. Bulk create multiple records in one transaction`,
      `node ../tools/rapider-task-cli.js bulk-create-records --table=${exampleTable} --file=../output/new-rows.json`,
      ``,
      `# 7. Partial update (PATCH) an existing record by ID`,
      `node ../tools/rapider-task-cli.js update-record --table=${exampleTable} --id="<record-uuid>" --data='{"status":"approved"}'`,
      ``,
      `# 8. Soft-delete a single record by ID (ONLY when explicitly requested by the user task)`,
      `node ../tools/rapider-task-cli.js delete-record --table=${exampleTable} --id="<record-uuid>"`,
      `\`\`\``,
      ``,
      `You can also invoke any \`/project-data-manager/*\` path directly via \`workspace-api\`:`,
      `\`\`\`bash`,
      `node ../tools/rapider-task-cli.js workspace-api --method=GET --path="/project-data-manager/${exampleTable}?filter=%7B%22limit%22%3A25%7D"`,
      `\`\`\``,
      ``,
      `### Mode B — Direct Rapider Backend REST API (Application Code / Backend Services)`,
      `When writing application or service code inside this repository, call \`$BACKEND_URL/project-data-manager/{dataTableName}\` with \`Authorization: Bearer <jwt>\` or \`x-api-key: <PROJECT_API_KEY>\` (configured in \`dev.env\`, \`stage.env\`, \`prod.env\`).`,
      ``,
      `---`,
      ``,
      `## 3. Complete \`ProjectDataManagerController\` Endpoint Reference`,
      ``,
      `| Operation | HTTP Method & Path | Query / Body Payload | Response |`,
      `| --- | --- | --- | --- |`,
      `| **Query Records** | \`GET /project-data-manager/{dataTableName}\` | \`?filter={"where":{...},"fields":{...},"order":["createdDate DESC"],"limit":100,"skip":0,"include":[{"relation":"..."}]}\` | \`200 OK\` — \`Array<Record>\` |`,
      `| **Count Records** | \`GET /project-data-manager/{dataTableName}/count\` | \`?where={"status":"active"}\` | \`200 OK\` — \`{ "count": number }\` |`,
      `| **Find By ID** | \`GET /project-data-manager/{dataTableName}/{id}\` | \`?filter={"include":[{"relation":"..."}]}\` | \`200 OK\` — \`Record\` |`,
      `| **Create Record** | \`POST /project-data-manager/{dataTableName}\` | JSON object matching \`Available Fields\` in \`project-data-models.md\` | \`200 OK\` — Created \`Record\` |`,
      `| **Bulk Create** | \`POST /project-data-manager/bulk/{dataTableName}\` | JSON array \`[ { ... }, { ... } ]\` | \`200 OK\` — \`Array<Record>\` |`,
      `| **Partial Update** | \`PATCH /project-data-manager/{dataTableName}/{id}\` | Partial JSON object containing only fields to modify | \`204 No Content\` |`,
      `| **Full Replace** | \`PATCH /project-data-manager/{dataTableName}/{id}/replace\` | Complete JSON object validated against full schema | \`204 No Content\` |`,
      `| **Soft Delete** | \`DELETE /project-data-manager/{dataTableName}/{id}\` | _(No body)_ — marks \`isDeleted = true\` | \`204 No Content\` |`,
      ``,
      `---`,
      ``,
      `## 4. LoopBack 4 Filter, Operator & Relation Traversal Cheat-Sheet`,
      ``,
      `### Common \`where\` Operators`,
      `- **Equality:** \`{ "status": "approved" }\``,
      `- **Set membership (\`inq\` / \`nin\`):** \`{ "status": { "inq": ["draft", "submitted"] } }\``,
      `- **Numeric / Date Comparisons (\`gt\`, \`gte\`, \`lt\`, \`lte\`, \`between\`, \`neq\`):**`,
      `  \`{ "amountMinor": { "gte": 10000 }, "expenseDate": { "between": ["2026-01-01T00:00:00.000Z", "2026-12-31T23:59:59.999Z"] } }\``,
      `- **Substring / Case-Insensitive Regex:** \`{ "merchantName": { "like": "Amazon", "options": "i" } }\``,
      `- **Logical Composition (\`and\` / \`or\`):** \`{ "and": [ { "status": "open" }, { "or": [ { "priority": "high" }, { "priority": "urgent" } ] } ] }\``,
      ``,
      `### Including Related Entities (\`Available Relations\` in \`project-data-models.md\`)`,
      `In \`.agents/project-data-models.md\`, relations follow the pattern:`,
      `- \`finExpenseReport (belongsTo -> Report) [reportId -> id]\`: Set \`reportId\` when creating/updating a child row, or include the parent via \`"include": [{ "relation": "finExpenseReport" }]\`.`,
      `- \`attachments (hasMany -> Expense Attachment) [id -> expenseId]\`: Include child rows via \`"include": [{ "relation": "attachments" }]\` or query the child's \`dataTableName\` with \`where: { "expenseId": "<parent-id>" }\`.`,
      `- \`tags (referencesMany -> Tag) [tagIds -> id]\`: Pass an array of target UUIDs in \`tagIds\` and include via \`"include": [{ "relation": "tags" }]\`.`,
    ].join('\n')
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 4: `.agents/workspace-datasources-and-integrations.md`
// ─────────────────────────────────────────────────────────────────────────────

function extractToolInputSummary(tool) {
  const schema =
    tool?.inputSchema ||
    tool?.parameters ||
    tool?.function?.parameters ||
    null;
  if (!schema || typeof schema !== 'object') {
    return { required: [], propertiesSummary: '{}' };
  }
  const required = Array.isArray(schema.required) ? schema.required : [];
  const props = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
  const sampleObj = {};
  for (const key of Object.keys(props).sort()) {
    const p = props[key] || {};
    const t = Array.isArray(p.type) ? p.type[0] : p.type || 'string';
    if (required.includes(key) || Object.keys(sampleObj).length < 3) {
      sampleObj[key] =
        p.example !== undefined
          ? p.example
          : t === 'number' || t === 'integer'
            ? 1
            : t === 'boolean'
              ? true
              : t === 'array'
                ? []
                : t === 'object'
                  ? {}
                  : `<${key}>`;
    }
  }
  return {
    required,
    propertiesSummary: JSON.stringify(sampleObj),
    propertyDescriptions: Object.keys(props)
      .sort()
      .map((k) => {
        const p = props[k] || {};
        const reqBadge = required.includes(k) ? 'required' : 'optional';
        const typeStr = Array.isArray(p.type) ? p.type.join('|') : p.type || 'any';
        const desc = p.description ? ` — ${String(p.description).replace(/\s+/g, ' ').trim()}` : '';
        return `\`${k}\` (${typeStr}, ${reqBadge})${desc}`;
      }),
  };
}

/**
 * Pure generator for `<repo root>/.agents/workspace-datasources-and-integrations.md`.
 * Documents all configured DataSources, external OAuth integrations (e.g. Jira, Slack,
 * Google Drive, Salesforce), MCP servers, OpenAPI connectors, and dynamic capabilities.
 */
function buildWorkspaceDatasourcesGuideMarkdownPure({
  projectId,
  workspaceName = '',
  dataSources = [],
  toolsByDataSourceId = {},
  nangoConnections = [],
  integrationProviders = [],
  capabilityDefinitions = [],
}) {
  const providersByKey = new Map();
  for (const p of Array.isArray(integrationProviders) ? integrationProviders : []) {
    if (p && p.key) providersByKey.set(String(p.key).toLowerCase(), p);
    if (p && p.id) providersByKey.set(String(p.id).toLowerCase(), p);
  }

  const sortedSources = [...(Array.isArray(dataSources) ? dataSources : [])].sort((a, b) =>
    String(a?.title || a?.name || a?.id || '').localeCompare(
      String(b?.title || b?.name || b?.id || '')
    )
  );

  const lines = [
    `# Workspace DataSources, Connected Integrations, MCP & API Guide`,
    ``,
    `- **Workspace:** ${workspaceName || projectId} (\`${projectId}\`)`,
    `- **Configured DataSources:** ${sortedSources.length}`,
    ``,
    `This guide lists every external integration (e.g. Jira, Slack, Google Drive, GitHub, Salesforce), MCP tool server, OpenAPI connector, database, and ingested file/web DataSource configured for this Workspace, and explains exactly how the isolated AI agent fetches data or invokes actions through them.`,
    ``,
    `---`,
    ``,
    `## 1. How to Query & Execute DataSources and MCP / Integration Tools`,
    ``,
    `### A. Inside the Isolated Task Sandbox (\`rapider-task-cli.js\`)`,
    `All external OAuth tokens (Nango vault), API keys, and MCP container/SSE credentials remain safely on the Rapider server. Invoke tools through the sandbox capability proxy:`,
    ``,
    `\`\`\`bash`,
    `# 1. List all DataSources configured in this Workspace`,
    `node ../tools/rapider-task-cli.js list-datasources`,
    ``,
    `# 2. Inspect live MCP / Integration / OpenAPI tools & JSON input schemas for a DataSource`,
    `node ../tools/rapider-task-cli.js list-datasource-tools --datasource="<dataSourceId>"`,
    ``,
    `# 3. Execute an integrated tool (e.g., Jira issue search, Slack lookup, OpenAPI GET/POST, MCP tool)`,
    `node ../tools/rapider-task-cli.js run-datasource-tool \\`,
    `  --datasource="<dataSourceId>" \\`,
    `  --tool="<toolName>" \\`,
    `  --input='{"jql":"project = ENG ORDER BY updated DESC"}'`,
    `\`\`\``,
    ``,
    `### B. Direct Rapider REST API (\`ToolGatewayService\`)`,
    `- **List Tools & Schemas:** \`GET /data-sources/{dataSourceId}/tools\` -> returns \`{ toolsMcp, toolsJsonSchema, connector, disabledTools }\`.`,
    `- **Execute Tool:** \`POST /data-sources/{dataSourceId}/tools/{toolName}/execute\` with JSON request body matching \`inputSchema\`.`,
    `- **Tabular / Synced Model DataSources:** When a DataSource ingests rows into a Workspace \`ProjectModel\`, query its table directly via \`/project-data-manager/{dataTableName}\` (see [\`.agents/project-data-manager-guide.md\`](./project-data-manager-guide.md)).`,
    ``,
    `---`,
    ``,
    `## 2. Configured Workspace DataSources Inventory`,
    ``,
  ];

  if (sortedSources.length === 0) {
    lines.push(`_No DataSources or external MCP/API connectors are currently configured in this Workspace._`);
    lines.push(``);
  } else {
    for (const ds of sortedSources) {
      const dsId = ds.id || 'unknown-id';
      const dsTitle = ds.title || ds.name || dsId;
      const connector = ds.connector || 'mongodb';
      const providerKey =
        ds.integrationConfig?.providerConfigKey ||
        ds.integrationConfig?.provider ||
        ds.config?.providerConfigKey ||
        ds.config?.provider ||
        ds.config?.mcpType ||
        null;
      const providerMeta = providerKey
        ? providersByKey.get(String(providerKey).toLowerCase())
        : null;
      const connectionStatus =
        ds.integrationConfig?.status ||
        (ds.nangoConnectionId ? 'connected' : ds.syncStatus || 'configured');

      const toolBundle = toolsByDataSourceId[dsId] || {};
      const disabledSet = new Set(
        Array.isArray(toolBundle.disabledTools || ds.disabledTools)
          ? toolBundle.disabledTools || ds.disabledTools
          : []
      );
      const rawTools =
        Array.isArray(toolBundle.toolsMcp) && toolBundle.toolsMcp.length > 0
          ? toolBundle.toolsMcp
          : Array.isArray(ds.toolsMcp) && ds.toolsMcp.length > 0
            ? ds.toolsMcp
            : Array.isArray(toolBundle.toolsJsonSchema)
              ? toolBundle.toolsJsonSchema
              : Array.isArray(ds.toolsJsonSchema)
                ? ds.toolsJsonSchema
                : [];
      const enabledTools = rawTools
        .map((t) => {
          const name = t?.name || t?.function?.name;
          if (!name || disabledSet.has(name)) return null;
          return {
            name,
            description: t?.description || t?.function?.description || '',
            ...extractToolInputSummary(t),
          };
        })
        .filter(Boolean)
        .sort((a, b) => a.name.localeCompare(b.name));

      lines.push(`### ${dsTitle} (\`${ds.name || dsId}\`)`);
      lines.push(`- **DataSource ID:** \`${dsId}\``);
      lines.push(`- **Connector Type:** \`${connector}\``);
      if (providerKey || providerMeta) {
        lines.push(
          `- **Integration Provider:** \`${providerKey || providerMeta?.key}\`${providerMeta?.title ? ` (${providerMeta.title})` : ''}`
        );
      }
      lines.push(`- **Connection / Sync Status:** \`${connectionStatus}\``);
      if (ds.description) {
        lines.push(`- **Description:** ${String(ds.description).trim()}`);
      }
      if (ds.environmentVariableKeyForConnectionString) {
        lines.push(
          `- **Connection String Env Key:** \`${ds.environmentVariableKeyForConnectionString}\` _(see \`dev.env\` / \`stage.env\` / \`prod.env\`)_`
        );
      }
      if (ds.hasEverBeenIngested) {
        lines.push(`- **AI Vector / RAG Ingested:** \`true\``);
      }
      lines.push(``);

      if (enabledTools.length > 0) {
        lines.push(`#### Enabled Tools (${enabledTools.length})`);
        for (const tool of enabledTools) {
          lines.push(
            `- **\`${tool.name}\`**${tool.description ? `: ${String(tool.description).replace(/\s+/g, ' ').trim()}` : ''}`
          );
          if (tool.propertyDescriptions && tool.propertyDescriptions.length > 0) {
            for (const propLine of tool.propertyDescriptions) {
              lines.push(`  - ${propLine}`);
            }
          }
          lines.push(
            `  - **Invoke:** \`node ../tools/rapider-task-cli.js run-datasource-tool --datasource="${dsId}" --tool="${tool.name}" --input='${tool.propertiesSummary}'\``
          );
        }
        lines.push(``);
      } else {
        lines.push(
          `_No pre-cached MCP/integration tool schemas listed on this DataSource. Run \`node ../tools/rapider-task-cli.js list-datasource-tools --datasource="${dsId}"\` to query live tools if applicable._`
        );
        lines.push(``);
      }
    }
  }

  // Section 3: Active Nango OAuth Connections
  const connList = Array.isArray(nangoConnections)
    ? nangoConnections
    : Array.isArray(nangoConnections?.connections)
      ? nangoConnections.connections
      : [];
  lines.push(`---`);
  lines.push(``);
  lines.push(`## 3. Active Workspace OAuth Connections (Nango)`);
  lines.push(``);
  if (connList.length === 0) {
    lines.push(`_No standalone Nango OAuth connections reported outside DataSources._`);
  } else {
    const sortedConns = [...connList].sort((a, b) =>
      String(a?.provider_config_key || a?.provider || '').localeCompare(
        String(b?.provider_config_key || b?.provider || '')
      )
    );
    for (const c of sortedConns) {
      const pKey = c.provider_config_key || c.provider || 'integration';
      const cId = c.connection_id || c.connectionId || 'connected';
      lines.push(`- **Provider:** \`${pKey}\` | **Connection ID:** \`${cId}\``);
    }
  }
  lines.push(``);

  // Section 4: Dynamic Workspace Capabilities
  const activeCaps = (Array.isArray(capabilityDefinitions) ? capabilityDefinitions : [])
    .filter((c) => c && !c.isDeleted && (!c.status || c.status === 'active'))
    .sort((a, b) => String(a.key || '').localeCompare(String(b.key || '')));

  lines.push(`---`);
  lines.push(``);
  lines.push(`## 4. Registered Workspace Capabilities (\`CapabilityDefinition\`)`);
  lines.push(``);
  if (activeCaps.length === 0) {
    lines.push(`_No custom \`CapabilityDefinition\` overrides registered in this Workspace._`);
  } else {
    for (const cap of activeCaps) {
      lines.push(
        `- **\`${cap.key}\`** (${cap.displayName || cap.name || cap.key}, source: \`${cap.sourceType || 'custom'}\`, effect: \`${cap.effectLevel || 'unknown'}\`) — ${cap.description || 'No description'}`
      );
    }
  }

  return normalizeLf(lines.join('\n'));
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 5: Workspace Notebooks Hierarchy (`<repo root>/_notebooks/`)
// ─────────────────────────────────────────────────────────────────────────────

function serializeYamlScalar(val) {
  if (val === null || val === undefined) return 'null';
  if (typeof val === 'boolean' || typeof val === 'number') return String(val);
  if (Array.isArray(val) || typeof val === 'object') return JSON.stringify(val);
  return JSON.stringify(String(val));
}

function formatNotebookPageMarkdownPure(frontmatter = {}, body = '') {
  const orderedKeys = [
    'id',
    'key',
    'title',
    'space',
    'notebook',
    'parentKey',
    'order',
    'kind',
    'noteType',
    'status',
    'origin',
    'scope',
    'links',
    'topicKeys',
  ];
  const fmLines = ['---'];
  for (const k of orderedKeys) {
    if (frontmatter[k] !== undefined) {
      fmLines.push(`${k}: ${serializeYamlScalar(frontmatter[k])}`);
    }
  }
  fmLines.push('---', '');
  const cleanBody = String(body || '').replace(/\r\n/g, '\n');
  return normalizeLf(fmLines.join('\n') + cleanBody);
}

/**
 * Recursively walks a Knowledge Space notebook's nested `pages` tree (`parentKey` / `children`)
 * and builds deterministic relative file paths preserving the full page hierarchy:
 *   - Leaf page at root: `<spaceKey>/<notebookKey>/<pageKey>.md`
 *   - Parent page with children: `<spaceKey>/<notebookKey>/<pageKey>/<pageKey>.md`
 *     and its children under `<spaceKey>/<notebookKey>/<pageKey>/<childKey>.md` (recursively).
 */
function computeNotebookTreeEntriesPure(spaceKey, notebookKey, pageNodes = []) {
  const safeSpace = sanitizePathSegment(spaceKey, 'space');
  const safeNotebook = sanitizePathSegment(notebookKey, 'notebook');
  const results = [];

  const sortedNodes = (nodes) =>
    [...(Array.isArray(nodes) ? nodes : [])].sort((a, b) => {
      const ordDiff = Number(a?.order ?? 0) - Number(b?.order ?? 0);
      if (ordDiff !== 0) return ordDiff;
      return String(a?.key || '').localeCompare(String(b?.key || ''));
    });

  function walk(nodes, ancestorDirs, depth) {
    for (const node of sortedNodes(nodes)) {
      if (!node || !node.key) continue;
      const safePageKey = sanitizePathSegment(node.key, 'page');
      const hasChildren = Array.isArray(node.children) && node.children.length > 0;
      const relFile = hasChildren
        ? [safeSpace, safeNotebook, ...ancestorDirs, safePageKey, `${safePageKey}.md`].join('/')
        : [safeSpace, safeNotebook, ...ancestorDirs, `${safePageKey}.md`].join('/');

      results.push({
        spaceKey,
        notebookKey,
        pageKey: node.key,
        title: node.title || node.key,
        kind: node.kind || 'page',
        status: node.status || 'active',
        parentKey: node.parentKey ?? null,
        order: node.order ?? 0,
        depth,
        relPath: relFile,
      });

      if (hasChildren) {
        walk(node.children, [...ancestorDirs, safePageKey], depth + 1);
      }
    }
  }

  walk(pageNodes, [], 0);
  return results;
}

/**
 * Reconstructs folder path segments for legacy `ProjectFolder` + `ProjectDocument` records.
 */
function buildLegacyFolderMapPure(folders = []) {
  const byId = new Map();
  for (const f of Array.isArray(folders) ? folders : []) {
    if (f && f.id) byId.set(f.id, f);
  }
  const resolveFolderRelDir = (folderId) => {
    const parts = [];
    const visited = new Set();
    let curr = folderId ? byId.get(folderId) : null;
    while (curr && !visited.has(curr.id)) {
      visited.add(curr.id);
      parts.unshift(sanitizePathSegment(curr.name || curr.title || curr.id, 'folder'));
      curr = curr.parentFolderId ? byId.get(curr.parentFolderId) : null;
    }
    return parts.join('/');
  };
  return { resolveFolderRelDir };
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 6: `dev.env`, `stage.env`, `prod.env` (Matching Project Code Generator)
// ─────────────────────────────────────────────────────────────────────────────

function formatDotenvValuePure(val) {
  if (val === undefined || val === null) return '';
  const raw =
    typeof val === 'object' ? JSON.stringify(val) : String(val);
  if (raw === '') return '';
  if (/[\r\n#"'\s]/.test(raw)) {
    const escaped = raw
      .replace(/\\/g, '\\\\')
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r')
      .replace(/"/g, '\\"');
    return `"${escaped}"`;
  }
  return raw;
}

function isValidEnvIdentifier(key) {
  return typeof key === 'string' && /^[a-zA-Z_][a-zA-Z0-9_.-]*$/.test(key.trim());
}

/**
 * Normalizes a dot-separated or mixed-case setting key when needed while keeping
 * valid uppercase/standard env keys verbatim, matching code generator conventions.
 */
function normalizeEnvVarKey(rawKey) {
  const trimmed = String(rawKey || '').trim();
  if (!trimmed) return null;
  if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(trimmed)) {
    return trimmed;
  }
  // Convert dotted/hyphenated project setting keys (e.g. `agentRuntime.mcp.autoApprove`)
  // into valid POSIX env var identifiers (`AGENT_RUNTIME_MCP_AUTO_APPROVE` or sanitized `_`)
  const sanitized = trimmed
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
  if (!sanitized) return null;
  return /^[0-9]/.test(sanitized) ? `SETTING_${sanitized}` : sanitized;
}

/**
 * Pure builder producing `{ 'dev.env': string, 'stage.env': string, 'prod.env': string }`
 * from Workspace `ProjectSetting[]` (shared across all environments) and
 * `EnvironmentVariable[]` (`DEV` -> `dev.env`, `QA`/`STAGE` -> `stage.env`, `PROD` -> `prod.env`).
 */
function buildWorkspaceEnvFilesPure({
  projectSettings = [],
  environmentVariables = [],
}) {
  const sharedMap = new Map();
  const sortedSettings = [...(Array.isArray(projectSettings) ? projectSettings : [])]
    .filter((s) => s && !s.isDeleted && s.key)
    .sort((a, b) => String(a.key).localeCompare(String(b.key)));

  for (const s of sortedSettings) {
    const envKey = normalizeEnvVarKey(s.key);
    if (!envKey || !isValidEnvIdentifier(envKey)) continue;
    sharedMap.set(envKey, s.value);
  }

  const envBuckets = {
    DEV: new Map(),
    STAGE: new Map(),
    PROD: new Map(),
  };

  const sortedEnvVars = [...(Array.isArray(environmentVariables) ? environmentVariables : [])]
    .filter((v) => v && !v.isDeleted && v.key)
    .sort((a, b) => String(a.key).localeCompare(String(b.key)));

  for (const v of sortedEnvVars) {
    const envKey = normalizeEnvVarKey(v.key);
    if (!envKey || !isValidEnvIdentifier(envKey)) continue;
    const targetEnv = String(v.environmentKey || 'DEV').trim().toUpperCase();
    if (targetEnv === 'DEV' || targetEnv === 'DEVELOPMENT') {
      envBuckets.DEV.set(envKey, v.value);
    } else if (targetEnv === 'QA' || targetEnv === 'STAGE' || targetEnv === 'STAGING') {
      envBuckets.STAGE.set(envKey, v.value);
    } else if (targetEnv === 'PROD' || targetEnv === 'PRODUCTION') {
      envBuckets.PROD.set(envKey, v.value);
    }
  }

  const renderSingleEnvFile = (label, specificMap) => {
    const lines = [
      `# Auto-generated by Rapider Workspace Repository Preparation (${label})`,
      `# Shared Project Settings + ${label} Environment Variables`,
      ``,
    ];

    const sharedKeys = Array.from(sharedMap.keys()).filter((k) => !specificMap.has(k)).sort();
    if (sharedKeys.length > 0) {
      lines.push(`# --- Project Settings (Shared Across Environments) ---`);
      for (const k of sharedKeys) {
        lines.push(`${k}=${formatDotenvValuePure(sharedMap.get(k))}`);
      }
      lines.push(``);
    }

    // Merge keys where specificMap overrides sharedMap (or defines env-only keys)
    const envKeys = Array.from(specificMap.keys()).sort();
    if (envKeys.length > 0) {
      lines.push(`# --- Environment Variables (${label}) ---`);
      for (const k of envKeys) {
        const val = specificMap.get(k);
        const effectiveVal =
          (val === undefined || val === null || val === '') && sharedMap.has(k)
            ? sharedMap.get(k)
            : val;
        lines.push(`${k}=${formatDotenvValuePure(effectiveVal)}`);
      }
      lines.push(``);
    }

    return normalizeLf(lines.join('\n'));
  };

  return {
    'dev.env': renderSingleEnvFile('DEV', envBuckets.DEV),
    'stage.env': renderSingleEnvFile('STAGE / QA', envBuckets.STAGE),
    'prod.env': renderSingleEnvFile('PROD', envBuckets.PROD),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 3b: Upsert Managed Block in `<repo root>/AGENTS.md`
// ─────────────────────────────────────────────────────────────────────────────

function buildManagedWorkspaceAgentsSectionPure({ projectId, workspaceName = '' }) {
  return [
    MANAGED_AGENTS_BLOCK_START,
    `## Rapider Workspace Prepared Context (\`${workspaceName || projectId}\`)`,
    ``,
    `Before planning or executing any task in this Workspace repository, read these deterministic Workspace context files (automatically refreshed from Rapider MongoDB & DigitalOcean Spaces S3 before each task run):`,
    ``,
    `1. **Project Data Models, Fields & Relationships:** [\`.agents/project-data-models.md\`](./.agents/project-data-models.md)`,
    `   - Canonical schema of every entity, field type, and \`belongsTo\` / \`hasMany\` / \`referencesMany\` relationship in this Workspace.`,
    `2. **Project Data Manager CRUD API Guide:** [\`.agents/project-data-manager-guide.md\`](./.agents/project-data-manager-guide.md)`,
    `   - Exact \`Entity -> dataTableName\` mapping table and instructions for querying, filtering, counting, creating, bulk-inserting, updating, and soft-deleting Workspace data via \`/project-data-manager/{dataTableName}\`.`,
    `3. **Workspace DataSources, Integrations, MCP & APIs:** [\`.agents/workspace-datasources-and-integrations.md\`](./.agents/workspace-datasources-and-integrations.md)`,
    `   - All configured external integrations (e.g. Jira, Slack, Google Drive, Salesforce), MCP servers, OpenAPI specs, and ingested DataSources along with tool schemas and execution commands.`,
    `4. **Workspace Notebooks & Knowledge Hierarchy:** [\`_notebooks/INDEX.md\`](./_notebooks/INDEX.md)`,
    `   - Synchronized Markdown notebooks, domain rules, and documents organized in their exact Workspace folder/page hierarchy under \`_notebooks/\`.`,
    `5. **Workspace Environment & Project Settings:** \`dev.env\`, \`stage.env\`, \`prod.env\``,
    `   - Generated from Workspace \`ProjectSetting\` (shared across environments) and \`EnvironmentVariable\` (\`DEV\`, \`QA\`/\`STAGE\`, \`PROD\`) records. **Confidentiality Rule:** Never echo secret values from \`*.env\` into user-facing replies or public reports.`,
    MANAGED_AGENTS_BLOCK_END,
  ].join('\n');
}

function upsertWorkspaceAgentsMarkdownPure(existingContent, { projectId, workspaceName = '' }) {
  const managedBlock = buildManagedWorkspaceAgentsSectionPure({ projectId, workspaceName });
  const raw = String(existingContent || '');

  if (!raw.trim()) {
    return normalizeLf(
      [
        `# Workspace Agent Rules — ${workspaceName || projectId}`,
        ``,
        managedBlock,
      ].join('\n')
    );
  }

  const startIdx = raw.indexOf(MANAGED_AGENTS_BLOCK_START);
  const endIdx = raw.indexOf(MANAGED_AGENTS_BLOCK_END);
  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    const before = raw.slice(0, startIdx).trimEnd();
    const after = raw.slice(endIdx + MANAGED_AGENTS_BLOCK_END.length).trimStart();
    const parts = [before, managedBlock, after].filter(Boolean);
    return normalizeLf(parts.join('\n\n'));
  }

  return normalizeLf(`${raw.trimEnd()}\n\n${managedBlock}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Async API Fetchers & Full Orchestration Pipeline
// ─────────────────────────────────────────────────────────────────────────────

function createDefaultApiClient({ backendUrl, projectToken }) {
  const headers = { Authorization: projectToken };

  return {
    async getJson(endpointPath, extraHeaders = {}) {
      const res = await fetchWithRetry(`${backendUrl}${endpointPath}`, {
        headers: { Accept: 'application/json', ...headers, ...extraHeaders },
      });
      if (!res.ok) {
        const err = new Error(`GET ${endpointPath} HTTP ${res.status}`);
        err.status = res.status;
        throw err;
      }
      return res.json();
    },
    async getText(endpointPath, extraHeaders = {}) {
      const res = await fetchWithRetry(`${backendUrl}${endpointPath}`, {
        headers: {
          Accept: 'text/plain, text/markdown, */*',
          'Accept-Language': 'en-US,en;q=0.9,tr;q=0.8',
          ...headers,
          ...extraHeaders,
        },
      });
      if (!res.ok) {
        const err = new Error(`GET ${endpointPath} HTTP ${res.status}`);
        err.status = res.status;
        throw err;
      }
      return res.text();
    },
    async getBuffer(endpointPath, extraHeaders = {}) {
      const res = await fetchWithRetry(`${backendUrl}${endpointPath}`, {
        headers: { ...headers, ...extraHeaders },
      });
      if (!res.ok) {
        const err = new Error(`GET ${endpointPath} HTTP ${res.status}`);
        err.status = res.status;
        throw err;
      }
      return Buffer.from(await res.arrayBuffer());
    },
    async postJson(endpointPath, body = {}, extraHeaders = {}) {
      const res = await fetchWithRetry(`${backendUrl}${endpointPath}`, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          ...headers,
          ...extraHeaders,
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = new Error(`POST ${endpointPath} HTTP ${res.status}`);
        err.status = res.status;
        throw err;
      }
      return res.json();
    },
  };
}

async function safeCall(fn, fallback = null) {
  try {
    return await fn();
  } catch (_) {
    return fallback;
  }
}

async function runWithConcurrency(items, limit, workerFn) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const idx = cursor++;
      results[idx] = await workerFn(items[idx], idx);
    }
  });
  await Promise.all(runners);
  return results;
}

/**
 * Syncs all Workspace Knowledge Spaces + Legacy `ProjectDocument` files into `<repoDir>/_notebooks/`.
 * Overwrites any prior `_notebooks/` directory cleanly so deleted/moved pages never linger.
 */
async function syncWorkspaceNotebooksToRepo(repoDir, projectId, api) {
  const notebooksRoot = path.join(repoDir, '_notebooks');
  fs.rmSync(notebooksRoot, { recursive: true, force: true });
  fs.mkdirSync(notebooksRoot, { recursive: true });

  const spacesRaw = await safeCall(
    () => api.getJson(`/projects/${encodeURIComponent(projectId)}/knowledge-spaces`),
    []
  );
  const spacesList = Array.isArray(spacesRaw)
    ? spacesRaw
    : Array.isArray(spacesRaw?.spaces)
      ? spacesRaw.spaces
      : [];

  const sortedSpaces = [...spacesList].sort((a, b) =>
    String(a?.spaceKey || a?.key || '').localeCompare(String(b?.spaceKey || b?.key || ''))
  );

  const indexLines = [
    `# Workspace Notebooks Index (\`_notebooks/\`)`,
    ``,
    `This folder contains all Workspace Knowledge Spaces, Notebooks (Folders), and Documents synchronized from Rapider MongoDB metadata and DigitalOcean Spaces S3 storage.`,
    ``,
  ];

  let syncedPagesCount = 0;
  let syncedSpacesCount = 0;

  for (const spaceDesc of sortedSpaces) {
    const spaceKey = spaceDesc?.spaceKey || spaceDesc?.key;
    if (!spaceKey) continue;
    const isPrivate = spaceDesc?.scope === 'user' || Boolean(spaceDesc?.private);
    const spaceBaseRoute = isPrivate
      ? `/projects/${encodeURIComponent(projectId)}/knowledge-spaces/private/${encodeURIComponent(spaceKey)}`
      : `/projects/${encodeURIComponent(projectId)}/knowledge-spaces/${encodeURIComponent(spaceKey)}`;

    const manifest = await safeCall(() => api.getJson(spaceBaseRoute), null);
    if (!manifest || !Array.isArray(manifest.notebooks)) continue;

    syncedSpacesCount++;
    const safeSpaceDir = sanitizePathSegment(spaceKey, 'space');
    fs.mkdirSync(path.join(notebooksRoot, safeSpaceDir), { recursive: true });

    indexLines.push(`## Space: ${manifest.name || spaceDesc.name || spaceKey} (\`${spaceKey}\`)`);
    if (manifest.description || spaceDesc.description) {
      indexLines.push(`_${String(manifest.description || spaceDesc.description).trim()}_`);
    }
    indexLines.push(``);

    // 1. Export Space Root Index (`_space` / `index`) as `_notebooks/<spaceKey>/README.md`
    const spaceRootNb = manifest.notebooks.find((n) => n && n.key === '_space');
    if (spaceRootNb && Array.isArray(spaceRootNb.pages)) {
      const idxNode = spaceRootNb.pages.find((p) => p && p.key === 'index');
      if (idxNode) {
        const idxPage = await safeCall(
          () => api.getJson(`${spaceBaseRoute}/pages/${encodeURIComponent(idxNode.key)}`),
          null
        );
        if (idxPage) {
          const md = formatNotebookPageMarkdownPure(
            idxPage.frontmatter || idxNode,
            idxPage.body ?? idxPage.content ?? ''
          );
          fs.writeFileSync(path.join(notebooksRoot, safeSpaceDir, 'README.md'), md, 'utf8');
          syncedPagesCount++;
          indexLines.push(`- [Space Summary (\`README.md\`)](./${safeSpaceDir}/README.md)`);
        }
      }
    }

    // 2. Materialize all notebooks & nested pages
    const userNotebooks = manifest.notebooks
      .filter((n) => n && n.key && n.key !== '_space')
      .sort((a, b) => String(a.key).localeCompare(String(b.key)));

    for (const nb of userNotebooks) {
      const treeEntries = computeNotebookTreeEntriesPure(spaceKey, nb.key, nb.pages || []);
      if (treeEntries.length === 0) continue;

      indexLines.push(`### Notebook: ${nb.name || nb.key} (\`${nb.key}\`)`);

      await runWithConcurrency(treeEntries, 6, async (entry) => {
        const pageData = await safeCall(
          () => api.getJson(`${spaceBaseRoute}/pages/${encodeURIComponent(entry.pageKey)}`),
          null
        );
        const fm = (pageData && pageData.frontmatter) || {
          id: entry.pageKey,
          key: entry.pageKey,
          title: entry.title,
          space: spaceKey,
          notebook: nb.key,
          parentKey: entry.parentKey,
          order: entry.order,
          kind: entry.kind,
          status: entry.status,
        };
        const body =
          pageData && (pageData.body !== undefined || pageData.content !== undefined)
            ? pageData.body ?? pageData.content
            : `# ${entry.title}\n`;

        const fullFilePath = path.join(notebooksRoot, entry.relPath);
        fs.mkdirSync(path.dirname(fullFilePath), { recursive: true });
        fs.writeFileSync(fullFilePath, formatNotebookPageMarkdownPure(fm, body), 'utf8');
      });

      for (const entry of treeEntries) {
        syncedPagesCount++;
        const indent = '  '.repeat(entry.depth);
        indexLines.push(`${indent}- [${entry.title}](./${entry.relPath}) (\`${entry.kind}\`)`);
      }
      indexLines.push(``);
    }
  }

  // 3. Also sync any legacy `ProjectFolder` + `ProjectDocument` files stored in MongoDB + S3
  const [legacyFolders, legacyDocs] = await Promise.all([
    safeCall(() => api.getJson('/project-folders'), []),
    safeCall(() => api.getJson('/project-documents'), []),
  ]);

  const docsList = (Array.isArray(legacyDocs) ? legacyDocs : [])
    .filter((d) => d && !d.isDeleted && d.id)
    .sort((a, b) => String(a.name || a.title || a.id).localeCompare(String(b.name || b.title || b.id)));

  let syncedLegacyDocsCount = 0;
  if (docsList.length > 0) {
    const { resolveFolderRelDir } = buildLegacyFolderMapPure(legacyFolders);
    indexLines.push(`## Workspace Project Documents (\`_documents/\`)`);
    indexLines.push(``);

    await runWithConcurrency(docsList, 6, async (doc) => {
      const buf = await safeCall(
        () => api.getBuffer(`/project-documents/content/${encodeURIComponent(doc.id)}`),
        null
      );
      if (!buf) return;

      const folderRel = resolveFolderRelDir(doc.projectFolderId || doc.folderId);
      const rawFileName = String(doc.fileName || doc.name || doc.title || `${doc.id}.md`).trim();
      const safeFile = rawFileName.replace(/[^a-zA-Z0-9._-]+/g, '_');
      const relDocPath = folderRel
        ? `_documents/${folderRel}/${safeFile}`
        : `_documents/${safeFile}`;
      const absDocPath = path.join(notebooksRoot, relDocPath);
      fs.mkdirSync(path.dirname(absDocPath), { recursive: true });
      fs.writeFileSync(absDocPath, buf);
      doc._syncedRelPath = relDocPath;
    });

    for (const doc of docsList) {
      if (doc._syncedRelPath) {
        syncedLegacyDocsCount++;
        indexLines.push(`- [${doc.title || doc.name || doc.id}](./${doc._syncedRelPath})`);
      }
    }
    indexLines.push(``);
  }

  if (syncedSpacesCount === 0 && syncedLegacyDocsCount === 0) {
    indexLines.push(`_No notebooks or documents have been created in this Workspace yet._`);
    indexLines.push(``);
  }

  fs.writeFileSync(
    path.join(notebooksRoot, 'INDEX.md'),
    normalizeLf(indexLines.join('\n')),
    'utf8'
  );

  return {
    spacesCount: syncedSpacesCount,
    pagesCount: syncedPagesCount,
    legacyDocumentsCount: syncedLegacyDocsCount,
  };
}

/**
 * Commits all prepared/overwritten Workspace context files onto the active branch
 * inside `repoDir`. Uses `git add -A` plus explicit `git add -f` on managed files so
 * pre-existing `.gitignore` rules (e.g. `*.env`) never block committing refreshed
 * Workspace files onto the branch.
 */
function commitPreparedWorkspaceFiles(repoDir, targetBranch, projectId) {
  ensureGitAuthorConfig(repoDir);

  git(repoDir, ['add', '-A']);
  const existingManaged = MANAGED_COMMIT_PATHS.filter((rel) =>
    fs.existsSync(path.join(repoDir, rel))
  );
  if (existingManaged.length > 0) {
    git(repoDir, ['add', '-f', '--', ...existingManaged]);
  }

  const dirty = git(repoDir, ['status', '--porcelain']);
  let committed = false;
  if (dirty) {
    git(repoDir, [
      'commit',
      '--no-gpg-sign',
      '-m',
      `chore(workspace-prep): sync models, datasources, notebooks, and env files for ${projectId}`,
    ]);
    committed = true;
  }

  const headSha = git(repoDir, ['rev-parse', 'HEAD']);
  return {
    committed,
    branch: targetBranch,
    headSha,
  };
}

/**
 * Full deterministic pre-task Workspace repository preparation orchestrator.
 *
 * Supports:
 *   - `step`: `'all'` (default) | `'git'` | `'models'` | `'datasources'` | `'notebooks'` | `'envs'`
 *   - `customApiClient`: injectable mock API client for deterministic unit/integration tests
 *   - `parkAfterCommit`: when `true`, parks `repoDir` back onto orphan `idle` after
 *     committing on `targetBranch` and capturing `headSha` (used by parallel orchestrator).
 */
async function prepareWorkspaceRepository({
  projectId,
  workItem = null,
  workspaceBootstrap = null,
  targetBranch: explicitBranch = null,
  workspacesRoot = DEFAULT_WORKSPACES_ROOT,
  codeGenReposRoot = process.env.RAPIDER_CODEGEN_REPOS_DIR || null,
  offline = false,
  parkAfterCommit = false,
  pushPreparedCommit = false,
  step = 'all',
  customApiClient = null,
  customRemoteRepoCreator = null,
}) {
  if (!projectId) {
    throw new Error('prepareWorkspaceRepository requires projectId.');
  }

  const safeId = sanitizeFolderSegment(projectId);
  const resolvedBranch = sanitizeGitBranchName(
    explicitBranch || extractTaskTargetBranch(workItem)
  );

  let api = customApiClient;
  if (!api && !offline) {
    const { token: baseToken, creds } = await authenticateBase();
    const projectToken = await switchActiveProject(creds, baseToken, safeId);
    api = createDefaultApiClient({ backendUrl: creds.backendUrl, projectToken });
  }

  // Fetch Workspace (`key`, `name`) & `GitInfo` first; if no `GitInfo` / repo exists yet,
  // ensure `GitInfo` + remote repo via `/git-infos/ensure` AND compute expected `${project.key}--${projectId}`!
  let workspaceName =
    (workspaceBootstrap && workspaceBootstrap.workspaceName) || safeId;
  let workspaceKey =
    (workspaceBootstrap && workspaceBootstrap.workspaceKey) || '';
  let repoName =
    (workspaceBootstrap && workspaceBootstrap.remoteRepoName) || null;
  let remoteUrl = null;
  let createdGitInfo = false;

  if (api && !offline) {
    const [projectsRaw, gitInfoRaw] = await Promise.all([
      safeCall(() => api.getJson('/projects'), []),
      safeCall(() => api.getJson('/git-infos'), null),
    ]);
    const matchedProject = Array.isArray(projectsRaw)
      ? projectsRaw.find((p) => p && p.id === safeId)
      : projectsRaw && projectsRaw.id === safeId
        ? projectsRaw
        : null;
    if (matchedProject) {
      if (matchedProject.name) workspaceName = String(matchedProject.name);
      if (matchedProject.key) workspaceKey = String(matchedProject.key);
    }

    let gitInfoObj = Array.isArray(gitInfoRaw) ? gitInfoRaw[0] : gitInfoRaw;

    // If `GitInfo` does not exist yet in Rapider DB, call `POST /git-infos/ensure` to create
    // `GitInfo` (`${project.key}--${projectId}`) and provision the remote GitHub repository!
    if ((!gitInfoObj || !gitInfoObj.repoName) && typeof api.postJson === 'function') {
      const ensured = await safeCall(() => api.postJson('/git-infos/ensure', {}), null);
      if (ensured && ensured.repoName) {
        gitInfoObj = ensured;
        createdGitInfo = Boolean(ensured.createdGitInfo);
      }
    }

    if (gitInfoObj && gitInfoObj.repoName) {
      repoName = String(gitInfoObj.repoName);
      if (gitInfoObj.remoteUrl || gitInfoObj.sshUrl || gitInfoObj.htmlUrl) {
        remoteUrl = gitInfoObj.remoteUrl || gitInfoObj.sshUrl || gitInfoObj.htmlUrl;
      }
    } else {
      // Deterministically compute expected repository name `${project.key}--${projectId}`
      // (or `${slug(project.name)}--${projectId}`) so the repo is ALWAYS created with its expected name!
      repoName = calculateExpectedWorkspaceRepoName(
        matchedProject || { key: workspaceKey, name: workspaceName },
        safeId
      );
    }
  } else if (!repoName) {
    repoName = calculateExpectedWorkspaceRepoName(
      { key: workspaceKey, name: workspaceName },
      safeId
    );
  }

  // Step 1: Resolve physical repo (or create it with `repoName` if missing), switch to task branch (or `main`), and pull latest
  const gitPrep = preparePhysicalGitRepo({
    projectId: safeId,
    workspaceName,
    workspaceKey,
    repoName,
    remoteUrl,
    targetBranch: resolvedBranch,
    workspacesRoot,
    codeGenReposRoot,
    offline,
    customRemoteRepoCreator,
  });

  const repoDir = gitPrep.repoDir;
  const summary = {
    projectId: safeId,
    workspaceName,
    repoName: gitPrep.repoName,
    repoDir,
    branch: gitPrep.branch,
    existedOnDisk: gitPrep.existedOnDisk,
    createdGitInfo,
    createdLocalRepo: gitPrep.createdLocalRepo,
    createdRemoteRepo: gitPrep.createdRemoteRepo,
    pulledFromRemote: gitPrep.pulledFromRemote,
    pushedToRemote: false,
    modelsCount: 0,
    dataSourcesCount: 0,
    notebooksSpacesCount: 0,
    notebooksPagesCount: 0,
    projectSettingsCount: 0,
    environmentVariablesCount: 0,
    committed: false,
    headSha: null,
  };

  if (offline || !api || step === 'git') {
    summary.headSha = git(repoDir, ['rev-parse', 'HEAD']);
    if (parkAfterCommit) {
      git(repoDir, ['checkout', '-f', 'idle']);
      git(repoDir, ['clean', '-fd']);
    }
    return summary;
  }

  const agentsDir = path.join(repoDir, '.agents');
  fs.mkdirSync(agentsDir, { recursive: true });

  const runAll = step === 'all';

  // Step 2 & 3: Project Models Markdown + Project Data Manager Guide + Legacy JSON metadata
  if (runAll || step === 'models') {
    const modelsFilter = JSON.stringify({
      include: [
        { relation: 'projectModelFields' },
        { relation: 'projectModelRelations' },
      ],
    });

    const [aiModelsContextMd, modelsRaw, dataSchemasRaw, msgTemplatesRaw, tplDefsRaw] =
      await Promise.all([
        safeCall(() => api.getText('/project-models/model-descriptions-for-ai-context'), null),
        safeCall(
          () => api.getJson(`/project-models?filter=${encodeURIComponent(modelsFilter)}`),
          []
        ),
        runAll ? safeCall(() => api.getJson('/data-schemas'), []) : Promise.resolve([]),
        runAll ? safeCall(() => api.getJson('/message-templates'), []) : Promise.resolve([]),
        runAll ? safeCall(() => api.getJson('/template-definitions'), []) : Promise.resolve([]),
      ]);

    const modelsList = Array.isArray(modelsRaw)
      ? redactSensitiveFields(modelsRaw)
      : [];
    summary.modelsCount = modelsList.length;

    const finalModelsMd =
      typeof aiModelsContextMd === 'string' && aiModelsContextMd.trim().length > 0
        ? normalizeLf(aiModelsContextMd)
        : buildProjectModelsContextMarkdownPure(modelsList);

    fs.writeFileSync(path.join(agentsDir, 'project-data-models.md'), finalModelsMd, 'utf8');

    const dataManagerGuideMd = buildProjectDataManagerGuideMarkdownPure({
      projectId: safeId,
      workspaceName,
      models: modelsList,
    });
    fs.writeFileSync(
      path.join(agentsDir, 'project-data-manager-guide.md'),
      dataManagerGuideMd,
      'utf8'
    );

    // Maintain `models/project-models.json` for ScopedTaskProxy table allowlist + backwards compat
    const modelsJsonDir = path.join(repoDir, 'models');
    fs.mkdirSync(modelsJsonDir, { recursive: true });
    fs.writeFileSync(
      path.join(modelsJsonDir, 'project-models.json'),
      normalizeLf(JSON.stringify(modelsList, null, 2)),
      'utf8'
    );

    if (runAll) {
      fs.mkdirSync(path.join(repoDir, 'schemas'), { recursive: true });
      fs.mkdirSync(path.join(repoDir, 'templates'), { recursive: true });
      fs.writeFileSync(
        path.join(repoDir, 'schemas/data-schemas.json'),
        normalizeLf(JSON.stringify(redactSensitiveFields(dataSchemasRaw || []), null, 2)),
        'utf8'
      );
      fs.writeFileSync(
        path.join(repoDir, 'templates/message-templates.json'),
        normalizeLf(JSON.stringify(redactSensitiveFields(msgTemplatesRaw || []), null, 2)),
        'utf8'
      );
      fs.writeFileSync(
        path.join(repoDir, 'templates/template-definitions.json'),
        normalizeLf(JSON.stringify(redactSensitiveFields(tplDefsRaw || []), null, 2)),
        'utf8'
      );
    }
  }

  // Step 4: Workspace DataSources, Connected Integrations (e.g. Jira), MCP & API Guide
  if (runAll || step === 'datasources') {
    const [dataSourcesRaw, nangoConnsRaw, providersRaw, capDefsRaw] = await Promise.all([
      safeCall(() => api.getJson('/data-sources'), []),
      safeCall(() => api.getJson('/nango/connections'), []),
      safeCall(() => api.getJson('/integration-providers'), []),
      safeCall(() => api.getJson('/capability-definitions'), []),
    ]);

    const dataSourcesList = Array.isArray(dataSourcesRaw)
      ? redactSensitiveFields(dataSourcesRaw)
      : [];
    summary.dataSourcesCount = dataSourcesList.length;

    const toolsByDataSourceId = {};
    await runWithConcurrency(dataSourcesList, 5, async (ds) => {
      if (!ds || !ds.id) return;
      const toolInfo = await safeCall(
        () => api.getJson(`/data-sources/${encodeURIComponent(ds.id)}/tools`),
        null
      );
      if (toolInfo) {
        toolsByDataSourceId[ds.id] = redactSensitiveFields(toolInfo);
      }
    });

    const dsGuideMd = buildWorkspaceDatasourcesGuideMarkdownPure({
      projectId: safeId,
      workspaceName,
      dataSources: dataSourcesList,
      toolsByDataSourceId,
      nangoConnections: redactSensitiveFields(nangoConnsRaw || []),
      integrationProviders: redactSensitiveFields(providersRaw || []),
      capabilityDefinitions: redactSensitiveFields(capDefsRaw || []),
    });

    fs.writeFileSync(
      path.join(agentsDir, 'workspace-datasources-and-integrations.md'),
      dsGuideMd,
      'utf8'
    );

    fs.mkdirSync(path.join(repoDir, 'mcp'), { recursive: true });
    fs.writeFileSync(
      path.join(repoDir, 'mcp/datasources-and-tools.json'),
      normalizeLf(JSON.stringify({ dataSources: dataSourcesList, toolsByDataSourceId }, null, 2)),
      'utf8'
    );
  }

  // Step 5: Workspace Notebooks Hierarchy (`_notebooks/`)
  if (runAll || step === 'notebooks') {
    const nbStats = await syncWorkspaceNotebooksToRepo(repoDir, safeId, api);
    summary.notebooksSpacesCount = nbStats.spacesCount;
    summary.notebooksPagesCount = nbStats.pagesCount + nbStats.legacyDocumentsCount;
  }

  // Step 6: `dev.env`, `stage.env`, `prod.env` from `ProjectSetting` + `EnvironmentVariable`
  if (runAll || step === 'envs') {
    const [settingsRaw, envVarsRaw] = await Promise.all([
      safeCall(() => api.getJson('/project-settings'), []),
      safeCall(() => api.getJson('/environment-variables'), []),
    ]);

    const projectSettings = Array.isArray(settingsRaw) ? settingsRaw : [];
    const environmentVariables = Array.isArray(envVarsRaw) ? envVarsRaw : [];
    summary.projectSettingsCount = projectSettings.length;
    summary.environmentVariablesCount = environmentVariables.length;

    const envFiles = buildWorkspaceEnvFilesPure({
      projectSettings,
      environmentVariables,
    });

    for (const [fileName, content] of Object.entries(envFiles)) {
      fs.writeFileSync(path.join(repoDir, fileName), content, 'utf8');
    }
  }

  // Update `<repo root>/AGENTS.md` (and `WORKSPACE_CONTEXT.md` pointer) deterministically
  const repoAgentsPath = path.join(repoDir, 'AGENTS.md');
  const existingAgentsMd = fs.existsSync(repoAgentsPath)
    ? fs.readFileSync(repoAgentsPath, 'utf8')
    : '';
  fs.writeFileSync(
    repoAgentsPath,
    upsertWorkspaceAgentsMarkdownPure(existingAgentsMd, {
      projectId: safeId,
      workspaceName,
    }),
    'utf8'
  );

  fs.writeFileSync(
    path.join(repoDir, 'WORKSPACE_CONTEXT.md'),
    normalizeLf(
      [
        `# Workspace Context Snapshot — ${workspaceName}`,
        ``,
        `- **Workspace Name:** ${workspaceName}`,
        `- **Project ID:** \`${safeId}\``,
        `- **Repository:** \`${gitPrep.repoName}\` (branch: \`${gitPrep.branch}\`)`,
        ``,
        `## Canonical Prepared Context Files`,
        `- [\`.agents/project-data-models.md\`](./.agents/project-data-models.md) — All Workspace entities, fields, and relations (${summary.modelsCount} model(s)).`,
        `- [\`.agents/project-data-manager-guide.md\`](./.agents/project-data-manager-guide.md) — Complete \`/project-data-manager/{dataTableName}\` CRUD & query guide.`,
        `- [\`.agents/workspace-datasources-and-integrations.md\`](./.agents/workspace-datasources-and-integrations.md) — Configured DataSources, connected OAuth apps (Jira/Slack/etc.), MCP servers & OpenAPI tools (${summary.dataSourcesCount} connector(s)).`,
        `- [\`_notebooks/INDEX.md\`](./_notebooks/INDEX.md) — Hierarchical Workspace Notebooks & Documents (${summary.notebooksPagesCount} page(s)).`,
        `- \`dev.env\`, \`stage.env\`, \`prod.env\` — Workspace Project Settings (${summary.projectSettingsCount}) + per-environment Variables (${summary.environmentVariablesCount}).`,
      ].join('\n')
    ),
    'utf8'
  );

  // Step 7: Overwrite & Commit onto `targetBranch` before starting the task
  const commitRes = commitPreparedWorkspaceFiles(repoDir, gitPrep.branch, safeId);
  summary.committed = commitRes.committed;
  summary.headSha = commitRes.headSha;

  // If the repository was newly created (or `--push` requested) and `origin` is configured,
  // push `main` and `targetBranch` so the remote repository immediately has the initialized branch!
  if (
    !offline &&
    gitPrep.hasOrigin &&
    (gitPrep.createdRemoteRepo || gitPrep.createdLocalRepo || pushPreparedCommit)
  ) {
    if (gitPrep.createdLocalRepo && gitPrep.branch !== 'main' && refExists(repoDir, 'refs/heads/main')) {
      spawnSync('git', ['push', '-u', 'origin', 'main'], {
        cwd: repoDir,
        encoding: 'utf8',
        timeout: 60000,
        env: NON_INTERACTIVE_GIT_ENV,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    }
    const pushRes = spawnSync('git', ['push', '-u', 'origin', gitPrep.branch], {
      cwd: repoDir,
      encoding: 'utf8',
      timeout: 60000,
      env: NON_INTERACTIVE_GIT_ENV,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    summary.pushedToRemote = pushRes.status === 0;
  }

  if (parkAfterCommit) {
    git(repoDir, ['checkout', '-f', 'idle']);
    git(repoDir, ['clean', '-fd']);
  }

  return summary;
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI Entrypoint
// ─────────────────────────────────────────────────────────────────────────────

if (require.main === module) {
  const args = process.argv.slice(2);
  const getArg = (name, fallback = null) => {
    const prefix = `--${name}=`;
    const hit = args.find((a) => a.startsWith(prefix));
    return hit ? hit.slice(prefix.length) : fallback;
  };
  const hasFlag = (name) => args.includes(`--${name}`);

  (async () => {
    const projectId = getArg('project') || getArg('workspace');
    if (!projectId) {
      console.error(
        'Usage: node scripts/prepare-workspace-repo.js --project=<projectId> [--branch=main] [--step=all|git|models|datasources|notebooks|envs] [--park]'
      );
      process.exit(1);
    }

    const branch = getArg('branch', 'main');
    const step = getArg('step', 'all');
    const offline = hasFlag('offline');
    const parkAfterCommit = hasFlag('park');

    const res = await prepareWorkspaceRepository({
      projectId,
      targetBranch: branch,
      step,
      offline,
      parkAfterCommit,
    });

    console.log(JSON.stringify({ ok: true, ...res }, null, 2));
  })().catch((err) => {
    console.error(`[PrepareWorkspaceRepo] Fatal error: ${err.message}`);
    process.exit(1);
  });
}

module.exports = {
  MANAGED_AGENTS_BLOCK_START,
  MANAGED_AGENTS_BLOCK_END,
  MANAGED_COMMIT_PATHS,
  extractTaskTargetBranch,
  sanitizeGitBranchName,
  calculateExpectedWorkspaceRepoName,
  calculateFallbackRepoName,
  preparePhysicalGitRepo,
  buildProjectModelsContextMarkdownPure,
  buildProjectDataManagerGuideMarkdownPure,
  buildWorkspaceDatasourcesGuideMarkdownPure,
  computeNotebookTreeEntriesPure,
  formatNotebookPageMarkdownPure,
  buildWorkspaceEnvFilesPure,
  upsertWorkspaceAgentsMarkdownPure,
  commitPreparedWorkspaceFiles,
  prepareWorkspaceRepository,
};
