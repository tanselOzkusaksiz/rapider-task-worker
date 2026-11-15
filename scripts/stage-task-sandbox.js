#!/usr/bin/env node

/**
 * stage-task-sandbox.js
 *
 * Non-Destructive Multi-Repo Sandbox Stager for the Isolated Task Orchestrator.
 *
 * Guarantees:
 *   1. Master repositories (`WORKSPACES/*`, `rapider-apps/APPS/*`, `_repo-cache/*.git`)
 *      are NEVER deleted and remain parked on their orphan `idle` branch.
 *   2. Only the target Workspace's context (`workspace-context/`) and its installed
 *      microapplications (`apps/<appKey>/`) are extracted via `git archive <baseSha> | tar -x`.
 *   3. Each staged directory is initialized as a fresh 1-commit local git repo on `main`
 *      tagged `ORCH_BASELINE` with ZERO remotes, ZERO other branches, and ZERO prior history.
 *   4. Installs the 4-Layer Agent Rules (`AGENTS.md`), Modular Skills (`.agents/skills/`),
 *      Lifecycle Hooks (`.agents/hooks.json`), pre-downloaded `.task-attachments/`, and
 *      `TASK_BRIEF.md` containing an auto-discovered Mounted Repo & Docs Index.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const {
  prepareWorkspaceSnapshotCommit,
  resolveInstalledAppRepoSources,
} = require('./manage-workspace-repos');
const {
  extractExactUserRequest,
  extractWorkItemImageUrls,
  extractAttachedProjectFileIds,
} = require('./fetch-and-validate-tasks');
const {
  authenticateBase,
  switchActiveProject,
  fetchWithRetry,
} = require('./rapider-api-auth');

const WORKER_ROOT = path.resolve(__dirname, '..');
const DEFAULT_SANDBOXES_ROOT = path.resolve(WORKER_ROOT, '_sandboxes');
const SANDBOX_TOOLS_SRC = path.resolve(__dirname, 'sandbox-tools');

function safeSlug(raw) {
  return String(raw || 'item')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'item';
}

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/**
 * Extracts `baseSha` from `hostRepoDir` into `targetDir` via `git archive` + `tar -x`,
 * then initializes a single-commit `ORCH_BASELINE` local git repo with zero remotes.
 */
function materializeCleanBaselineRepo(hostRepoDir, baseSha, targetDir, label) {
  fs.mkdirSync(targetDir, { recursive: true });

  const archiveRes = spawnSync('git', ['archive', '--format=tar', baseSha], {
    cwd: hostRepoDir,
    maxBuffer: 256 * 1024 * 1024,
  });
  if (archiveRes.status !== 0) {
    throw new Error(
      `git archive failed for ${hostRepoDir}@${baseSha}: ${(archiveRes.stderr || '').toString()}`
    );
  }

  const tarRes = spawnSync('tar', ['-xf', '-', '-C', targetDir], {
    input: archiveRes.stdout,
    maxBuffer: 256 * 1024 * 1024,
  });
  if (tarRes.status !== 0) {
    throw new Error(
      `tar extract failed into ${targetDir}: ${(tarRes.stderr || '').toString()}`
    );
  }

  // Initialize fresh single-commit baseline git repo (zero remotes, zero prior commits)
  git(targetDir, ['init', '-b', 'main']);
  git(targetDir, ['config', 'user.name', 'Rapider Sandbox Agent']);
  git(targetDir, ['config', 'user.email', 'sandbox-agent@rapider.local']);
  git(targetDir, ['add', '-A']);
  git(targetDir, [
    'commit',
    '--allow-empty',
    '--no-gpg-sign',
    '-m',
    `chore: stage clean baseline (${label})`,
  ]);
  git(targetDir, ['tag', 'ORCH_BASELINE']);

  const baselineHead = git(targetDir, ['rev-parse', 'HEAD']);
  return { baselineHead };
}

/**
 * Recursively discovers `.md` documentation files and `app.manifest.json` inside a
 * staged directory (up to depth 4) to build the Mounted Repo & Docs Index in TASK_BRIEF.md.
 */
function discoverRepoDocs(rootDir, mountRelPrefix, maxDepth = 4) {
  const found = [];
  function walk(currDir, relDir, depth) {
    if (depth > maxDepth || !fs.existsSync(currDir)) return;
    const entries = fs.readdirSync(currDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === '.agents') {
        continue;
      }
      const nextCurr = path.join(currDir, entry.name);
      const nextRel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(nextCurr, nextRel, depth + 1);
      } else if (
        /\.(md|markdown)$/i.test(entry.name) ||
        entry.name === 'app.manifest.json'
      ) {
        found.push(`${mountRelPrefix}/${nextRel}`);
      }
    }
  }
  walk(rootDir, '', 1);
  return found.sort();
}

/**
 * Downloads WorkItem attachments directly into `<sandbox>/workspace/.task-attachments/`
 * when online.
 */
async function stageAttachmentsIntoSandbox(workItem, events, attachDestDir, offline = false) {
  fs.mkdirSync(attachDestDir, { recursive: true });
  if (offline || !workItem) return [];

  const fileIds = extractAttachedProjectFileIds(workItem);
  const imageUrls = extractWorkItemImageUrls(workItem, events);
  if (fileIds.length === 0 && imageUrls.length === 0) return [];

  const stagedFiles = [];
  try {
    const { token: baseToken, creds } = await authenticateBase();
    const projectToken = await switchActiveProject(creds, baseToken, workItem.projectId);

    for (const fileId of fileIds) {
      try {
        let name = `attachment-${fileId}`;
        const metaRes = await fetchWithRetry(
          `${creds.backendUrl}/project-files/${encodeURIComponent(fileId)}`,
          { headers: { Authorization: projectToken } }
        );
        if (metaRes.ok) {
          const meta = await metaRes.json().catch(() => ({}));
          if (meta && meta.name) {
            name = path.basename(String(meta.name)).replace(/[^a-zA-Z0-9._-]/g, '_');
          }
        }
        const contentRes = await fetchWithRetry(
          `${creds.backendUrl}/project-files/get-file-content/${encodeURIComponent(fileId)}`,
          { headers: { Authorization: projectToken } }
        );
        if (contentRes.ok) {
          const buf = Buffer.from(await contentRes.arrayBuffer());
          if (buf.length > 0) {
            const outPath = path.join(attachDestDir, name);
            fs.writeFileSync(outPath, buf);
            stagedFiles.push(`.task-attachments/${name}`);
          }
        }
      } catch (_) {}
    }

    for (let i = 0; i < imageUrls.length; i++) {
      const rawUrl = imageUrls[i];
      if (!/^https?:\/\//i.test(rawUrl)) continue;
      try {
        const res = await fetchWithRetry(rawUrl);
        if (res.ok) {
          const buf = Buffer.from(await res.arrayBuffer());
          if (buf.length > 0) {
            const name = `image-${i + 1}.png`;
            fs.writeFileSync(path.join(attachDestDir, name), buf);
            stagedFiles.push(`.task-attachments/${name}`);
          }
        }
      } catch (_) {}
    }
  } catch (_) {}

  return stagedFiles;
}

/**
 * Builds `.agents/hooks.json`, `.agents/skills/*`, and root `AGENTS.md` inside
 * `<sandbox>/workspace/`.
 */
function installAgentRulesSkillsAndHooks(workspaceDir, toolsDir) {
  // 1. Copy root AGENTS.md (< 12 KB)
  fs.copyFileSync(
    path.join(SANDBOX_TOOLS_SRC, 'SANDBOX_AGENTS.md'),
    path.join(workspaceDir, 'AGENTS.md')
  );

  // 2. Copy modular skills into .agents/skills/
  const skillsDest = path.join(workspaceDir, '.agents/skills');
  fs.mkdirSync(skillsDest, { recursive: true });
  fs.cpSync(path.join(SANDBOX_TOOLS_SRC, 'skills'), skillsDest, { recursive: true });

  // 3. Copy hook scripts into tools/hooks/ (read-only outside mutable repo edits)
  const hooksDest = path.join(toolsDir, 'hooks');
  fs.mkdirSync(hooksDest, { recursive: true });
  fs.cpSync(path.join(SANDBOX_TOOLS_SRC, 'hooks'), hooksDest, { recursive: true });

  // 4. Write workspace/.agents/hooks.json using relative ../tools/hooks/* paths
  const hooksConfig = {
    hooks: {
      SessionStart: [
        {
          matcher: '*',
          hooks: [
            {
              type: 'command',
              command: 'node ../tools/hooks/on-session-start.js',
              timeout: 10,
            },
          ],
        },
      ],
      Stop: [
        {
          matcher: '*',
          hooks: [
            {
              type: 'command',
              command: 'node ../tools/hooks/on-stop-verify.js',
              timeout: 15,
            },
          ],
        },
      ],
    },
  };
  fs.mkdirSync(path.join(workspaceDir, '.agents'), { recursive: true });
  fs.writeFileSync(
    path.join(workspaceDir, '.agents/hooks.json'),
    JSON.stringify(hooksConfig, null, 2),
    'utf8'
  );

  // 5. Copy rapider-task-cli.js + standalone handlebars bundle into tools/
  fs.copyFileSync(
    path.join(SANDBOX_TOOLS_SRC, 'rapider-task-cli.js'),
    path.join(toolsDir, 'rapider-task-cli.js')
  );
  const hbBundleSrc = path.resolve(
    WORKER_ROOT,
    'node_modules/handlebars/dist/handlebars.js'
  );
  if (fs.existsSync(hbBundleSrc)) {
    const nmDir = path.join(toolsDir, 'node_modules');
    fs.mkdirSync(nmDir, { recursive: true });
    fs.copyFileSync(hbBundleSrc, path.join(nmDir, 'handlebars.js'));
  }
}

/**
 * Generates `/workspace/TASK_BRIEF.md` containing the task prompt, chronological
 * replies, attachment inspection list, and auto-generated Mounted Repo & Docs Index.
 */
function buildTaskBriefMarkdown({
  workItem,
  workspaceName,
  events = [],
  stagedAttachments = [],
  stagedRepos = [],
}) {
  const exactRequest = extractExactUserRequest(workItem);
  const replyLines =
    events.length === 0
      ? '_No follow-up replies recorded yet._'
      : events
          .map((ev, idx) => {
            const msg =
              typeof ev.data === 'string'
                ? ev.data
                : ev.data?.bodyMarkdown || ev.data?.message || JSON.stringify(ev.data || {});
            return `${idx + 1}. **[${ev.eventType || 'event'}]** (${ev.createdDate || ''}): ${msg}`;
          })
          .join('\n');

  const attachSection =
    stagedAttachments.length === 0
      ? '_No external attachments on this task._'
      : stagedAttachments.map((rel) => `- \`${rel}\` _(MUST read before planning)_`).join('\n');

  const repoIndexLines = stagedRepos
    .map((repo) => {
      const docsList =
        repo.discoveredDocs && repo.discoveredDocs.length > 0
          ? repo.discoveredDocs.map((d) => `  - \`${d}\``).join('\n')
          : '  - _(No markdown docs in repo)_';
      return `- **\`${repo.mountRelPath}/\`** (Repo: \`${repo.repoKey}\`, Baseline Tag: \`ORCH_BASELINE\`)\n${docsList}`;
    })
    .join('\n');

  return [
    `# Isolated Task Brief — ${workItem.title || workItem.id}`,
    ``,
    `- **Task ID:** \`${workItem.id}\``,
    `- **Workspace:** ${workspaceName} (\`${workItem.projectId}\`)`,
    `- **Priority:** ${workItem.priority ?? 'Standard'}`,
    workItem.expectedOutcome ? `- **Expected Outcome:** ${workItem.expectedOutcome}` : null,
    ``,
    `---`,
    ``,
    `## 1. Exact User Request`,
    ``,
    exactRequest || workItem.bodyMarkdown || workItem.summary || workItem.title,
    ``,
    `---`,
    ``,
    `## 2. Chronological Thread & Replies`,
    ``,
    replyLines,
    ``,
    `---`,
    ``,
    `## 3. Staged Task Attachments (\`.task-attachments/\`)`,
    ``,
    attachSection,
    ``,
    `---`,
    ``,
    `## 4. Mounted Repositories & Documentation Index`,
    ``,
    `Only repositories authorized for **${workspaceName}** are mounted below. Read relevant \`.md\` guides before making changes:`,
    ``,
    repoIndexLines || '_No repositories staged._',
    ``,
    `---`,
    ``,
    `## 5. Required Deliverable Output`,
    ``,
    `1. Save any generated user files (\`.md\`, \`.csv\`, \`.pdf\`, \`.hbs\`) inside \`../output/deliverables/\`.`,
    `2. Write final structured outcome JSON to \`../output/task-outcome.json\` (see \`AGENTS.md\` §5).`,
    ``,
  ]
    .filter((line) => line !== null)
    .join('\n');
}

/**
 * Main entry: stages a complete isolated sandbox for `workItem`.
 */
async function stageTaskSandbox({
  workItem,
  runId = 'local',
  workspaceBootstrap = {},
  events = [],
  sandboxesRoot = DEFAULT_SANDBOXES_ROOT,
  workspacesRoot,
  appsCloneRoot,
  bareCacheRoot,
  offline = false,
}) {
  if (!workItem || !workItem.id || !workItem.projectId) {
    throw new Error('stageTaskSandbox requires workItem with id and projectId.');
  }

  const sandboxId = `task-${safeSlug(workItem.id)}-${safeSlug(String(runId).slice(0, 8))}`;
  const sandboxRoot = path.join(sandboxesRoot, sandboxId);
  const workspaceDir = path.join(sandboxRoot, 'workspace');
  const toolsDir = path.join(sandboxRoot, 'tools');
  const outputDir = path.join(sandboxRoot, 'output');
  const deliverablesDir = path.join(outputDir, 'deliverables');
  const homeDir = path.join(sandboxRoot, 'home');
  const tmpDir = path.join(sandboxRoot, 'tmp');
  const logsDir = path.join(sandboxRoot, 'logs');

  // Ensure fresh sandbox directory
  if (fs.existsSync(sandboxRoot)) {
    fs.rmSync(sandboxRoot, { recursive: true, force: true });
  }
  for (const dir of [workspaceDir, toolsDir, deliverablesDir, homeDir, tmpDir, logsDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // 1. Prepare Workspace snapshot commit on host (immediately re-parks host repo to `idle`!)
  const wsPrep = await prepareWorkspaceSnapshotCommit(workItem.projectId, {
    workspacesRoot,
    offline,
  });

  const stagedRepos = [];

  // 2. Materialize `workspace-context/` via `git archive` -> 1-commit ORCH_BASELINE
  const wsContextMount = path.join(workspaceDir, 'workspace-context');
  const wsBaseline = materializeCleanBaselineRepo(
    wsPrep.repoDir,
    wsPrep.mainSha,
    wsContextMount,
    `workspace:${workItem.projectId}`
  );
  stagedRepos.push({
    mountRelPath: 'workspace-context',
    repoKey: `workspace-${workItem.projectId}`,
    hostRepoDir: wsPrep.repoDir,
    baseSha: wsPrep.mainSha,
    baselineHead: wsBaseline.baselineHead,
    readOnlySnapshot: true,
    discoveredDocs: discoverRepoDocs(wsContextMount, 'workspace-context'),
  });

  // 3. Resolve & materialize ONLY installed microapp repos for this Workspace
  const installedAppKeys = Array.isArray(workspaceBootstrap.installedAppKeys)
    ? [...workspaceBootstrap.installedAppKeys]
    : [];
  if (
    workItem.source &&
    workItem.source.type === 'application' &&
    workItem.source.typeId
  ) {
    installedAppKeys.push(String(workItem.source.typeId));
  }

  const appSources = resolveInstalledAppRepoSources(installedAppKeys, {
    appsCloneRoot,
    bareCacheRoot,
  });

  if (appSources.length > 0) {
    fs.mkdirSync(path.join(workspaceDir, 'apps'), { recursive: true });
  }

  for (const src of appSources) {
    const appDirName = safeSlug(src.appKey || src.repoKey);
    const mountRelPath = `apps/${appDirName}`;
    const targetAppDir = path.join(workspaceDir, mountRelPath);
    const appBaseline = materializeCleanBaselineRepo(
      src.hostRepoDir,
      src.baseSha,
      targetAppDir,
      `app:${src.repoKey}`
    );
    stagedRepos.push({
      mountRelPath,
      repoKey: src.repoKey,
      appKey: src.appKey,
      hostRepoDir: src.hostRepoDir,
      baseSha: src.baseSha,
      baselineHead: appBaseline.baselineHead,
      readOnlySnapshot: false,
      discoveredDocs: discoverRepoDocs(targetAppDir, mountRelPath),
    });
  }

  // 4. Download task attachments into workspace/.task-attachments/
  const stagedAttachments = await stageAttachmentsIntoSandbox(
    workItem,
    events,
    path.join(workspaceDir, '.task-attachments'),
    offline
  );

  // 5. Install 4-layer AGENTS.md, modular skills, hooks, and rapider-task-cli.js
  installAgentRulesSkillsAndHooks(workspaceDir, toolsDir);

  // 6. Write TASK_BRIEF.md with auto-discovered Mounted Repo & Docs Index
  const workspaceName =
    workspaceBootstrap.workspaceName ||
    wsPrep.syncSummary?.workspaceName ||
    workItem.projectId;

  const briefMd = buildTaskBriefMarkdown({
    workItem,
    workspaceName,
    events,
    stagedAttachments,
    stagedRepos,
  });
  fs.writeFileSync(path.join(workspaceDir, 'TASK_BRIEF.md'), briefMd, 'utf8');

  // Extract allowed table names from staged project-models.json so ScopedTaskProxy can enforce table allowlist
  let allowedTables = null;
  const modelsJsonPath = path.join(wsContextMount, 'models/project-models.json');
  if (fs.existsSync(modelsJsonPath)) {
    try {
      const parsedModels = JSON.parse(fs.readFileSync(modelsJsonPath, 'utf8'));
      if (Array.isArray(parsedModels) && parsedModels.length > 0) {
        allowedTables = parsedModels
          .map((m) => m && (m.dataTableName || m.name))
          .filter(Boolean);
      }
    } catch (_) {}
  }

  const manifest = {
    sandboxId,
    sandboxRoot,
    workspaceDir,
    toolsDir,
    outputDir,
    deliverablesDir,
    homeDir,
    tmpDir,
    logsDir,
    workItemId: workItem.id,
    projectId: workItem.projectId,
    workspaceName,
    allowedTables,
    stagedAttachments,
    stagedRepos,
    createdAt: new Date().toISOString(),
  };

  fs.writeFileSync(
    path.join(sandboxRoot, 'staging-manifest.json'),
    JSON.stringify(manifest, null, 2),
    'utf8'
  );

  return manifest;
}

module.exports = {
  stageTaskSandbox,
  materializeCleanBaselineRepo,
  discoverRepoDocs,
  buildTaskBriefMarkdown,
};

