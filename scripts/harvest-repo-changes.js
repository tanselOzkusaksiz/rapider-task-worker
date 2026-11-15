#!/usr/bin/env node

/**
 * harvest-repo-changes.js
 *
 * Inspects staged repositories inside `<sandbox>/workspace/` after `agy` exits:
 *   1. Auto-commits any uncommitted work inside mutable staged `apps/<appKey>/` repos
 *      so partial work is never silently lost.
 *   2. Computes `git diff --binary ORCH_BASELINE..HEAD` for every modified repo,
 *      producing deterministic `.patch` artifacts for private S3 archival and Admin UI inspection.
 *   3. Optionally applies the harvested patch onto a temporary host `git worktree`
 *      branched off the master repo's `main` (`ai/task-<workItemShort>-<ts>`) — while
 *      leaving the master repo checkout parked on `idle`!
 *   4. Collects user deliverable files from `<sandbox>/output/deliverables/` and reads
 *      `<sandbox>/output/task-outcome.json`.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function collectDeliverableFiles(deliverablesDir) {
  if (!fs.existsSync(deliverablesDir)) return [];
  const entries = fs.readdirSync(deliverablesDir, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && !e.name.startsWith('.') && !e.name.endsWith('.print.html'))
    .map((e) => {
      const fullPath = path.join(deliverablesDir, e.name);
      const stat = fs.statSync(fullPath);
      return {
        fileName: e.name,
        fullPath,
        sizeBytes: stat.size,
      };
    });
}

function readTaskOutcome(outputDir) {
  const outcomePath = path.join(outputDir, 'task-outcome.json');
  if (!fs.existsSync(outcomePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(outcomePath, 'utf8'));
  } catch (_) {
    return null;
  }
}

/**
 * Applies a `.patch` file onto a fresh local branch `ai/task-<id>` inside the master
 * host repo via a temporary `git worktree` so the master repo's `idle` checkout is
 * NEVER disturbed!
 */
function applyPatchToHostBranchViaWorktree({
  hostRepoDir,
  baseSha,
  patchFilePath,
  branchName,
  commitMessage,
  pushRemote = false,
}) {
  const worktreesTmpRoot = path.join(path.dirname(patchFilePath), 'tmp-worktrees');
  fs.mkdirSync(worktreesTmpRoot, { recursive: true });
  const wtDir = path.join(
    worktreesTmpRoot,
    `wt-${branchName.replace(/[^a-zA-Z0-9._-]/g, '-')}`
  );

  try {
    git(hostRepoDir, ['worktree', 'add', '-f', '-B', branchName, wtDir, baseSha]);
    git(wtDir, ['config', 'user.name', 'Rapider Task Orchestrator']);
    git(wtDir, ['config', 'user.email', 'task-orchestrator@rapider.local']);

    const applyRes = spawnSync('git', ['apply', '--index', '--binary', patchFilePath], {
      cwd: wtDir,
      encoding: 'utf8',
    });
    if (applyRes.status !== 0) {
      throw new Error(`git apply failed: ${applyRes.stderr || applyRes.stdout}`);
    }

    git(wtDir, ['commit', '--no-gpg-sign', '-m', commitMessage]);
    const headSha = git(wtDir, ['rev-parse', 'HEAD']);

    let pushedRemote = false;
    if (pushRemote) {
      try {
        const remotes = git(wtDir, ['remote']);
        if (remotes.split('\n').includes('origin')) {
          git(wtDir, ['push', '-u', 'origin', branchName]);
          pushedRemote = true;
        }
      } catch (_) {}
    }

    return { applied: true, branchName, headSha, pushedRemote };
  } finally {
    try {
      git(hostRepoDir, ['worktree', 'remove', '--force', wtDir]);
    } catch (_) {
      fs.rmSync(wtDir, { recursive: true, force: true });
      try {
        git(hostRepoDir, ['worktree', 'prune']);
      } catch (_) {}
    }
  }
}

/**
 * Harvests patches, optional host branches, deliverables, and `task-outcome.json`
 * from a completed sandbox.
 */
function harvestSandboxResults(manifest, options = {}) {
  const { workspaceDir, outputDir, deliverablesDir, logsDir, stagedRepos = [] } = manifest;
  const patchesDir = path.join(logsDir, 'patches');
  fs.mkdirSync(patchesDir, { recursive: true });

  const harvestedPatches = [];
  const pushedBranches = [];

  for (const repo of stagedRepos) {
    if (repo.readOnlySnapshot) continue;
    const repoMountDir = path.join(workspaceDir, repo.mountRelPath);
    if (!fs.existsSync(path.join(repoMountDir, '.git'))) continue;

    // Auto-stage any uncommitted edits inside the sandbox repo
    const dirty = git(repoMountDir, ['status', '--porcelain']);
    if (dirty) {
      git(repoMountDir, ['add', '-A']);
      try {
        git(repoMountDir, [
          'commit',
          '--no-gpg-sign',
          '-m',
          `feat(task): changes for task ${manifest.workItemId}`,
        ]);
      } catch (_) {}
    }

    const diffRes = spawnSync('git', ['diff', '--binary', 'ORCH_BASELINE..HEAD'], {
      cwd: repoMountDir,
      maxBuffer: 64 * 1024 * 1024,
    });

    if (diffRes.status === 0 && diffRes.stdout && diffRes.stdout.length > 0) {
      const safeKey = String(repo.repoKey || 'repo').replace(/[^a-zA-Z0-9._-]/g, '_');
      const patchPath = path.join(patchesDir, `${safeKey}.patch`);
      fs.writeFileSync(patchPath, diffRes.stdout);

      const commitCountRaw = git(repoMountDir, ['rev-list', '--count', 'ORCH_BASELINE..HEAD']);
      const commitCount = parseInt(commitCountRaw, 10) || 1;

      const patchEntry = {
        repoKey: repo.repoKey,
        appKey: repo.appKey,
        patchPath,
        bytes: diffRes.stdout.length,
        commitCount,
      };
      harvestedPatches.push(patchEntry);

      if (options.createHostBranches !== false && repo.hostRepoDir && fs.existsSync(repo.hostRepoDir)) {
        const shortTask = String(manifest.workItemId || 'task').slice(0, 8);
        const branchName = `ai/task-${shortTask}-${Date.now().toString(36)}`;
        try {
          const branchInfo = applyPatchToHostBranchViaWorktree({
            hostRepoDir: repo.hostRepoDir,
            baseSha: repo.baseSha,
            patchFilePath: patchPath,
            branchName,
            commitMessage: `feat(task-${shortTask}): automated task changes for ${manifest.workItemId}`,
            pushRemote: Boolean(options.pushRemoteBranches),
          });
          pushedBranches.push({
            repoKey: repo.repoKey,
            branch: branchInfo.branchName,
            headSha: branchInfo.headSha,
            pushedRemote: branchInfo.pushedRemote,
            commitCount,
          });
        } catch (err) {
          pushedBranches.push({
            repoKey: repo.repoKey,
            branch: null,
            commitCount,
            warning: err.message,
          });
        }
      }
    }
  }

  const deliverables = collectDeliverableFiles(deliverablesDir);
  const outcome = readTaskOutcome(outputDir);

  return {
    outcome,
    deliverables,
    harvestedPatches,
    pushedBranches,
  };
}

module.exports = {
  harvestSandboxResults,
  collectDeliverableFiles,
  readTaskOutcome,
  applyPatchToHostBranchViaWorktree,
};

