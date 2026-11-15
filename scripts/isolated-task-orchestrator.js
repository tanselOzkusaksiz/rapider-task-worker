#!/usr/bin/env node

/**
 * isolated-task-orchestrator.js
 *
 * Cross-platform (macOS local + Ubuntu Linux server) Isolated Multi-Repo Task
 * Orchestrator Daemon for Rapider.
 *
 * Architecture:
 *   1. Dynamic `1..maxConcurrent` Async Worker Pool synchronized live via Rapider
 *      MongoDB (`POST /admin/task-orchestrator/worker/heartbeat` & `/worker/claim`).
 *      Admins can adjust `MAX_CONCURRENT` (`1`, `5`, `12`, `30`, ...) or toggle
 *      `Pause` / `Hard Pause` / `Kill Task` live from the Management UI or CLI
 *      with zero daemon restarts.
 *   2. Non-Destructive Repo Staging: Master repos (`WORKSPACES/*`, `APPS/*`,
 *      `_repo-cache/*`) remain permanently on disk parked on their orphan `idle`
 *      branch. Each task receives a dedicated `_sandboxes/task-<id>/` with
 *      single-commit `ORCH_BASELINE` repos and 4-layer `AGENTS.md` + Skills + Hooks.
 *   3. OS-Level Blindness + Scoped Loopback Proxy: Runs `agy` inside `/usr/bin/sandbox-exec`
 *      (macOS) or `bwrap` (Ubuntu) with zero `.env` or tokens, communicating only
 *      via an ephemeral `X-Task-Nonce` on `127.0.0.1`.
 *   4. Private S3 Log & Patch Archival: Uploads `.log`, `.jsonl` (`stream-json`),
 *      and git `.patch` bundles privately (`isPublic = false`) via Rapider's
 *      `s3-file.service.ts` endpoint (`/admin/task-orchestrator/worker/runs/{runId}/logs`).
 *
 * Usage:
 *   node scripts/isolated-task-orchestrator.js                   # Continuous daemon
 *   node scripts/isolated-task-orchestrator.js --once            # Drain one claim batch & exit
 *   node scripts/isolated-task-orchestrator.js --max-concurrent=5
 *   node scripts/isolated-task-orchestrator.js --project=<id>    # Scope worker to 1 Workspace
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  authenticateBase,
  switchActiveProject,
  fetchWithRetry,
} = require('./rapider-api-auth');
const {
  validateTaskSecurity,
  evaluateWorkspaceRelevanceHeuristic,
  validatePublicReplyConfidentiality,
  DEFAULT_SCOPE_REJECTION_REPLY,
} = require('./security-and-scope-guardrail');
const { parkAllWorkspaceRepos } = require('./manage-workspace-repos');
const { ScopedTaskProxyServer } = require('./scoped-task-proxy');
const { stageTaskSandbox } = require('./stage-task-sandbox');
const { runInOsSandbox } = require('./sandbox-runner');
const { harvestSandboxResults } = require('./harvest-repo-changes');
const { uploadTaskArtifacts } = require('./upload-task-artifacts');

const WORKER_ROOT = path.resolve(__dirname, '..');
const DEFAULT_SANDBOXES_ROOT = path.resolve(WORKER_ROOT, '_sandboxes');

function getArg(args, name, fallback = null) {
  const prefix = `--${name}=`;
  const hit = args.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
}

function hasFlag(args, name) {
  return args.includes(`--${name}`);
}

class IsolatedTaskOrchestrator {
  constructor(options = {}) {
    this.workerId =
      options.workerId ||
      process.env.ORCHESTRATOR_WORKER_ID ||
      `${os.hostname()}-${process.platform}-${process.pid}`;
    this.sandboxesRoot = options.sandboxesRoot || DEFAULT_SANDBOXES_ROOT;
    this.workspacesRoot = options.workspacesRoot;
    this.appsCloneRoot = options.appsCloneRoot;
    this.bareCacheRoot = options.bareCacheRoot;
    this.projectFilter = options.projectFilter || null;
    this.once = Boolean(options.once);
    this.offline = Boolean(options.offline);
    this.taskTimeoutMs =
      Number(options.taskTimeoutMs || process.env.TASK_TIMEOUT_MS) ||
      15 * 60 * 1000;
    this.pushRemoteBranches = Boolean(
      options.pushRemoteBranches ?? process.env.PUSH_TASK_BRANCHES === 'true'
    );
    this.customCommandSpec = options.customCommandSpec || null;

    this.maxConcurrent =
      Number(options.initialMaxConcurrent || process.env.MAX_CONCURRENT) || 5;
    this.pollIntervalSeconds =
      Number(options.pollIntervalSeconds || process.env.POLL_INTERVAL_SECONDS) || 10;
    this.sandboxRetentionCount =
      Number(options.sandboxRetentionCount || process.env.SANDBOX_RETENTION_COUNT) || 20;

    this.paused = false;
    this.hardPaused = false;
    this.stopping = false;
    this.startedAt = new Date().toISOString();

    // Active executions keyed by workItemId -> { runId, workItem, killFn, promise }
    this.activeRuns = new Map();
    this.pendingAckSignalIds = new Set();
    this.proxyServer = new ScopedTaskProxyServer({
      customUpstreamFetch: options.customProxyUpstreamFetch || null,
    });
    this.customApiHandler = options.customAdminApiHandler || null;
  }

  async adminApi(method, endpointPath, body = undefined) {
    if (this.customApiHandler) {
      return this.customApiHandler(method, endpointPath, body);
    }
    const { token, creds } = await authenticateBase();
    const res = await fetchWithRetry(`${creds.backendUrl}${endpointPath}`, {
      method,
      headers: {
        Accept: 'application/json',
        Authorization: token,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(
        data?.error?.message || data?.message || `Admin API ${method} ${endpointPath} failed (HTTP ${res.status})`
      );
    }
    return data;
  }

  async fetchWorkItemEvents(projectId, workItemId) {
    if (this.customApiHandler || this.offline) return [];
    try {
      const { token: baseToken, creds } = await authenticateBase();
      const projectToken = await switchActiveProject(creds, baseToken, projectId);
      const filter = JSON.stringify({
        where: { workItemId },
        order: ['sequence ASC', 'createdDate ASC'],
      });
      const res = await fetchWithRetry(
        `${creds.backendUrl}/work-item-events?filter=${encodeURIComponent(filter)}`,
        { headers: { Authorization: projectToken } }
      );
      if (!res.ok) return [];
      const data = await res.json().catch(() => []);
      return Array.isArray(data) ? data : [];
    } catch (_) {
      return [];
    }
  }

  async attachDeliverablesToWorkItem(projectId, workItemId, uploadedRefs = []) {
    if (!uploadedRefs.length || this.customApiHandler || this.offline) return;
    try {
      const { token: baseToken, creds } = await authenticateBase();
      const projectToken = await switchActiveProject(creds, baseToken, projectId);
      const getRes = await fetchWithRetry(
        `${creds.backendUrl}/work-items/${encodeURIComponent(workItemId)}`,
        { headers: { Authorization: projectToken } }
      );
      if (!getRes.ok) return;
      const existing = await getRes.json().catch(() => ({}));
      const prevRefs = Array.isArray(existing.contextRefs) ? existing.contextRefs : [];
      const mergedRefs = [...prevRefs, ...uploadedRefs];
      await fetchWithRetry(
        `${creds.backendUrl}/work-items/${encodeURIComponent(workItemId)}`,
        {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            Authorization: projectToken,
          },
          body: JSON.stringify({ contextRefs: mergedRefs }),
        }
      );
    } catch (_) {}
  }

  pruneCompletedSandboxes() {
    try {
      if (!fs.existsSync(this.sandboxesRoot)) return;
      const activeIds = new Set(
        Array.from(this.activeRuns.values())
          .map((r) => r.sandboxId)
          .filter(Boolean)
      );

      const dirs = fs
        .readdirSync(this.sandboxesRoot, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !activeIds.has(d.name))
        .map((d) => {
          const full = path.join(this.sandboxesRoot, d.name);
          const mtimeMs = fs.statSync(full).mtimeMs;
          return { name: d.name, full, mtimeMs };
        })
        .sort((a, b) => b.mtimeMs - a.mtimeMs);

      const keep = Math.max(1, this.sandboxRetentionCount);
      for (let i = keep; i < dirs.length; i++) {
        fs.rmSync(dirs[i].full, { recursive: true, force: true });
      }
    } catch (_) {}
  }

  async sendHeartbeat(statusOverride = null) {
    const ackIds = Array.from(this.pendingAckSignalIds);
    this.pendingAckSignalIds.clear();

    const resp = await this.adminApi('POST', '/admin/task-orchestrator/worker/heartbeat', {
      workerId: this.workerId,
      hostname: os.hostname(),
      platform: process.platform,
      pid: process.pid,
      activeCount: this.activeRuns.size,
      activeWorkItemIds: Array.from(this.activeRuns.keys()),
      startedAt: this.startedAt,
      status: statusOverride || (this.stopping ? 'draining' : 'online'),
      ackSignalIds: ackIds,
    });

    if (resp && resp.state) {
      if (typeof resp.state.maxConcurrent === 'number') {
        this.maxConcurrent = resp.state.maxConcurrent;
      }
      this.paused = Boolean(resp.state.paused);
      this.hardPaused = Boolean(resp.state.hardPaused);
      if (typeof resp.state.pollIntervalSeconds === 'number') {
        this.pollIntervalSeconds = resp.state.pollIntervalSeconds;
      }
      if (typeof resp.state.sandboxRetentionCount === 'number') {
        this.sandboxRetentionCount = resp.state.sandboxRetentionCount;
      }
    }

    const signals = Array.isArray(resp?.signals) ? resp.signals : [];
    for (const sig of signals) {
      if (!sig || !sig.id) continue;
      if (sig.signalType === 'hard_pause_all') {
        for (const active of this.activeRuns.values()) {
          if (active.killFn) await active.killFn();
        }
        this.pendingAckSignalIds.add(sig.id);
      } else if (sig.signalType === 'kill_task' && sig.workItemId) {
        const hit = this.activeRuns.get(sig.workItemId);
        if (hit && hit.killFn) {
          await hit.killFn();
          this.pendingAckSignalIds.add(sig.id);
        }
      }
    }

    return resp;
  }

  async executeSingleClaimedTask(claimedEntry) {
    const { workItem, execution, workspaceBootstrap = {} } = claimedEntry;
    const runId = execution.id;
    let leaseNonce = null;

    const runTracker = {
      runId,
      workItem,
      sandboxId: null,
      killFn: null,
    };
    this.activeRuns.set(workItem.id, runTracker);

    try {
      // 1. Pre-execution Step 2 Security & Relevance Gate (fast-reject hostile/off-topic tasks)
      const combinedPrompt = [
        workItem.title || '',
        workItem.summary || '',
        workItem.bodyMarkdown || '',
        workItem.source?.exactUserRequest || '',
      ].join('\n');

      const secCheck = validateTaskSecurity(combinedPrompt);
      if (!secCheck.safe) {
        await this.adminApi('PATCH', `/admin/task-orchestrator/worker/runs/${encodeURIComponent(runId)}`, {
          status: 'rejected',
          taskCategory: 'security-rejected',
          errorReason: secCheck.reason,
          resultSummary: DEFAULT_SCOPE_REJECTION_REPLY,
          workItemStatus: 'rejected',
          workItemOutcome: DEFAULT_SCOPE_REJECTION_REPLY,
          needsAttention: false,
          publicCommentMarkdown: DEFAULT_SCOPE_REJECTION_REPLY,
        });
        return;
      }

      const relCheck = evaluateWorkspaceRelevanceHeuristic(combinedPrompt, {
        appNames: workspaceBootstrap.installedAppKeys || [],
      });
      if (!relCheck.relatedCandidate) {
        await this.adminApi('PATCH', `/admin/task-orchestrator/worker/runs/${encodeURIComponent(runId)}`, {
          status: 'rejected',
          taskCategory: 'off-workspace-rejected',
          errorReason: relCheck.reason,
          resultSummary: DEFAULT_SCOPE_REJECTION_REPLY,
          workItemStatus: 'rejected',
          workItemOutcome: DEFAULT_SCOPE_REJECTION_REPLY,
          needsAttention: false,
          publicCommentMarkdown: DEFAULT_SCOPE_REJECTION_REPLY,
        });
        return;
      }

      // 2. Stage isolated multi-repo sandbox (master repos stay parked on `idle`!)
      await this.adminApi('PATCH', `/admin/task-orchestrator/worker/runs/${encodeURIComponent(runId)}`, {
        status: 'staging',
        logTail: `[${new Date().toISOString()}] Staging isolated multi-repo sandbox for Workspace ${workspaceBootstrap.workspaceName || workItem.projectId}...\n`,
      });

      const events = await this.fetchWorkItemEvents(workItem.projectId, workItem.id);
      const manifest = await stageTaskSandbox({
        workItem,
        runId,
        workspaceBootstrap,
        events,
        sandboxesRoot: this.sandboxesRoot,
        workspacesRoot: this.workspacesRoot,
        appsCloneRoot: this.appsCloneRoot,
        bareCacheRoot: this.bareCacheRoot,
        offline: this.offline,
      });
      runTracker.sandboxId = manifest.sandboxId;

      // 3. Issue ephemeral single-Workspace proxy capability lease
      const lease = this.proxyServer.registerTaskLease({
        workItemId: workItem.id,
        projectId: workItem.projectId,
        workspaceName: manifest.workspaceName,
        allowedTables: manifest.allowedTables,
      });
      leaseNonce = lease.nonce;

      await this.adminApi('PATCH', `/admin/task-orchestrator/worker/runs/${encodeURIComponent(runId)}`, {
        status: 'running',
        stagedRepos: manifest.stagedRepos.map((r) => ({
          mountRelPath: r.mountRelPath,
          repoKey: r.repoKey,
          baseSha: r.baseSha,
        })),
      });

      // 4. Execute inside OS Jail (`sandbox-exec` on macOS / `bwrap` on Linux)
      const execResult = await runInOsSandbox({
        manifest,
        proxyUrl: lease.proxyUrl,
        taskNonce: lease.nonce,
        commandSpec: this.customCommandSpec,
        sandboxesRoot: this.sandboxesRoot,
        workspacesRoot: this.workspacesRoot,
        appsCloneRoot: this.appsCloneRoot,
        bareCacheRoot: this.bareCacheRoot,
        timeoutMs: this.taskTimeoutMs,
        onPid: async (pid, handle) => {
          runTracker.killFn = handle.kill;
          await this.adminApi('PATCH', `/admin/task-orchestrator/worker/runs/${encodeURIComponent(runId)}`, {
            workerPid: pid,
          }).catch(() => {});
        },
        onLogTail: async (tail) => {
          await this.adminApi('PATCH', `/admin/task-orchestrator/worker/runs/${encodeURIComponent(runId)}`, {
            logTail: tail,
          }).catch(() => {});
        },
      });

      // 5. Harvest git patches, deliverables, and task-outcome.json
      await this.adminApi('PATCH', `/admin/task-orchestrator/worker/runs/${encodeURIComponent(runId)}`, {
        status: 'harvesting',
        exitCode: execResult.exitCode,
        conversationId: execResult.conversationId || undefined,
      });

      const harvested = harvestSandboxResults(manifest, {
        createHostBranches: true,
        pushRemoteBranches: this.pushRemoteBranches,
      });

      // 6. Upload private S3 logs (.log, .jsonl, .patch) via s3-file.service.ts endpoint
      if (fs.existsSync(execResult.textLogPath)) {
        const logText = fs.readFileSync(execResult.textLogPath, 'utf8');
        if (logText) {
          await this.adminApi('POST', `/admin/task-orchestrator/worker/runs/${encodeURIComponent(runId)}/logs`, {
            kind: 'log',
            content: logText,
          }).catch(() => {});
        }
      }

      if (fs.existsSync(execResult.jsonlLogPath)) {
        const jsonlText = fs.readFileSync(execResult.jsonlLogPath, 'utf8');
        if (jsonlText.trim()) {
          await this.adminApi('POST', `/admin/task-orchestrator/worker/runs/${encodeURIComponent(runId)}/logs`, {
            kind: 'jsonl',
            content: jsonlText,
          }).catch(() => {});
        }
      }

      for (const patchItem of harvested.harvestedPatches) {
        const patchContent = fs.readFileSync(patchItem.patchPath, 'utf8');
        await this.adminApi('POST', `/admin/task-orchestrator/worker/runs/${encodeURIComponent(runId)}/logs`, {
          kind: 'patch',
          repoKey: patchItem.repoKey,
          filename: `${patchItem.repoKey}.patch`,
          content: patchContent,
        }).catch(() => {});
      }

      if (execResult.externallyKilled) {
        await this.adminApi('PATCH', `/admin/task-orchestrator/worker/runs/${encodeURIComponent(runId)}`, {
          status: 'killed',
          exitCode: execResult.exitCode,
          logTail: execResult.logTail,
          errorReason: 'Terminated by Admin kill/hard-pause signal.',
        });
        return;
      }

      if (execResult.timedOut) {
        const timeoutMsg = 'The background task exceeded its maximum execution time limit and was safely stopped.';
        await this.adminApi('PATCH', `/admin/task-orchestrator/worker/runs/${encodeURIComponent(runId)}`, {
          status: 'failed',
          exitCode: execResult.exitCode,
          logTail: execResult.logTail,
          errorReason: `Timed out after ${this.taskTimeoutMs}ms`,
          resultSummary: timeoutMsg,
          workItemStatus: 'failed',
          workItemOutcome: timeoutMsg,
          needsAttention: true,
          publicCommentMarkdown: timeoutMsg,
        });
        return;
      }

      // 7. Upload generated deliverables to Workspace ProjectFiles ("Task Outputs")
      let uploadedRefs = [];
      if (harvested.deliverables.length > 0 && !this.offline && !this.customApiHandler) {
        try {
          uploadedRefs = await uploadTaskArtifacts({
            projectId: workItem.projectId,
            workItemId: workItem.id,
            filePaths: harvested.deliverables.map((d) => d.fullPath),
          });
          await this.attachDeliverablesToWorkItem(workItem.projectId, workItem.id, uploadedRefs);
        } catch (_) {}
      } else if (harvested.deliverables.length > 0) {
        uploadedRefs = harvested.deliverables.map((d) => ({
          type: 'projectFile',
          name: d.fileName,
          size: d.sizeBytes,
        }));
      }

      // 8. Validate outcome & enforce Public Reply Confidentiality Gate
      const outcome = harvested.outcome || {};
      const rawStatus = String(outcome.status || (execResult.exitCode === 0 ? 'resolved' : 'failed')).toLowerCase();
      const finalStatus = ['resolved', 'pending', 'rejected', 'failed'].includes(rawStatus)
        ? rawStatus
        : 'failed';

      let publicSummary =
        outcome.outcomeSummary ||
        (finalStatus === 'resolved'
          ? `Completed task "${workItem.title}".`
          : `Task "${workItem.title}" ended with status ${finalStatus}.`);
      let publicReply =
        outcome.publicReplyMarkdown ||
        publicSummary;

      const confSummary = validatePublicReplyConfidentiality(publicSummary);
      const confReply = validatePublicReplyConfidentiality(publicReply);
      if (!confSummary.valid || !confReply.valid) {
        publicSummary = `Completed task "${workItem.title}".`;
        publicReply =
          uploadedRefs.length > 0
            ? `Your task **${workItem.title}** has been completed and ${uploadedRefs.length} deliverable file(s) have been attached to this item.`
            : `Your task **${workItem.title}** has been processed. Please review the updated Workspace records.`;
      }

      await this.adminApi('PATCH', `/admin/task-orchestrator/worker/runs/${encodeURIComponent(runId)}`, {
        status: finalStatus,
        taskCategory: outcome.taskCategory || 'general',
        exitCode: execResult.exitCode,
        conversationId: execResult.conversationId || undefined,
        pushedBranches: harvested.pushedBranches,
        attachedFiles: uploadedRefs,
        logTail: execResult.logTail,
        resultSummary: publicSummary,
        workItemStatus: finalStatus,
        workItemOutcome: publicSummary,
        needsAttention: finalStatus === 'pending' || finalStatus === 'failed',
        publicCommentMarkdown: publicReply,
      });
    } catch (err) {
      const safeUserError =
        'An unexpected error occurred while processing this background task. An administrator can inspect the execution logs and re-queue the task.';
      await this.adminApi('PATCH', `/admin/task-orchestrator/worker/runs/${encodeURIComponent(runId)}`, {
        status: 'failed',
        errorReason: err.message,
        resultSummary: safeUserError,
        workItemStatus: 'failed',
        workItemOutcome: safeUserError,
        needsAttention: true,
        publicCommentMarkdown: safeUserError,
      }).catch(() => {});
    } finally {
      if (leaseNonce) {
        this.proxyServer.revokeTaskLease(leaseNonce);
      }
      this.activeRuns.delete(workItem.id);
      this.pruneCompletedSandboxes();
    }
  }

  async pollAndDispatchOnce() {
    await this.sendHeartbeat();

    if (this.stopping || this.paused || this.hardPaused) {
      return 0;
    }

    const localAvailableSlots = Math.max(0, this.maxConcurrent - this.activeRuns.size);
    if (localAvailableSlots <= 0) {
      return 0;
    }

    const claimRes = await this.adminApi('POST', '/admin/task-orchestrator/worker/claim', {
      workerId: this.workerId,
      hostname: os.hostname(),
      platform: process.platform,
      requestedSlots: localAvailableSlots,
      ...(this.projectFilter ? { projectId: this.projectFilter } : {}),
    });

    if (typeof claimRes?.maxConcurrent === 'number') {
      this.maxConcurrent = claimRes.maxConcurrent;
    }

    const claimed = Array.isArray(claimRes?.claimed) ? claimRes.claimed : [];
    for (const entry of claimed) {
      const p = this.executeSingleClaimedTask(entry);
      const tracker = this.activeRuns.get(entry.workItem.id);
      if (tracker) tracker.promise = p;
    }

    return claimed.length;
  }

  async start() {
    // Park all persistent Workspace checkouts onto `idle` at startup
    parkAllWorkspaceRepos({ workspacesRoot: this.workspacesRoot });
    await this.proxyServer.start();

    if (this.once) {
      await this.pollAndDispatchOnce();
      const pending = Array.from(this.activeRuns.values())
        .map((r) => r.promise)
        .filter(Boolean);
      await Promise.allSettled(pending);
      await this.sendHeartbeat('offline').catch(() => {});
      await this.proxyServer.stop();
      return;
    }

    const handleShutdown = async (sig) => {
      if (this.stopping) return;
      this.stopping = true;
      console.log(`\n[TaskOrchestrator] Received ${sig}; draining ${this.activeRuns.size} active task(s)...`);
      await this.sendHeartbeat('draining').catch(() => {});
      const pending = Array.from(this.activeRuns.values())
        .map((r) => r.promise)
        .filter(Boolean);
      await Promise.allSettled(pending);
      await this.sendHeartbeat('offline').catch(() => {});
      await this.proxyServer.stop();
      process.exit(0);
    };

    process.once('SIGINT', () => handleShutdown('SIGINT'));
    process.once('SIGTERM', () => handleShutdown('SIGTERM'));

    console.log(
      `[TaskOrchestrator] Online | workerId=${this.workerId} | platform=${process.platform} | proxy=${this.proxyServer.getBaseUrl()}`
    );

    while (!this.stopping) {
      try {
        await this.pollAndDispatchOnce();
      } catch (err) {
        console.error(`[TaskOrchestrator] Poll error: ${err.message}`);
      }
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(2, this.pollIntervalSeconds) * 1000)
      );
    }
  }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const initialMax = getArg(args, 'max-concurrent');
  const orchestrator = new IsolatedTaskOrchestrator({
    once: hasFlag(args, 'once'),
    offline: hasFlag(args, 'offline'),
    projectFilter: getArg(args, 'project'),
    ...(initialMax ? { initialMaxConcurrent: Number(initialMax) } : {}),
  });

  orchestrator.start().catch((err) => {
    console.error(`[TaskOrchestrator] Fatal error: ${err.message}`);
    process.exit(1);
  });
}

module.exports = {
  IsolatedTaskOrchestrator,
};

