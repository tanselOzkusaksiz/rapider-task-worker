#!/usr/bin/env node

/**
 * task-worker-daemon.js
 *
 * Autonomous FIFO Batch-of-5 Drain Daemon for ISOLATED-TASK-WORKER:
 *   - Polls Rapider API every `interval` (default 5m) or runs a single drain (`--once`).
 *   - Fetches the OLDEST 5 open WorkItems (`kind: "task"`, `status: "open"`).
 *   - Automatically rejects tasks flagged unsafe by Step 2 security/scope guardrail.
 *   - In `--headless` mode, spawns isolated per-task `agy -p` execution inside
 *     `rapider-task-worker` with `WORKSPACES/<projectId>/` activated on `main`,
 *     then always parks back to `idle`.
 *   - Immediately loops to fetch the NEXT oldest 5 open tasks until 0 open tasks
 *     remain (up to `TASK_WORKER_MAX_BATCHES_PER_RUN` batches per wake cycle).
 *
 * Usage:
 *   npm run worker                 # Poll every 5m (drains oldest-5 batches)
 *   npm run worker:1m              # Poll every 1m
 *   npm run worker:once            # Drain all open batches of 5 once and exit
 *   npm run worker:headless        # Poll + invoke `agy -p` headless per task
 */

const path = require('path');
const { execFileSync } = require('child_process');
const { fetchAndValidateTasks, claimWorkItemTask } = require('./fetch-and-validate-tasks');
const {
  activateWorkspaceRepo,
  parkWorkspaceRepo,
  parkAllWorkspaceRepos,
  getWorkspaceReposStatus,
} = require('./manage-workspace-repos');
const { patchWorkItemTask } = require('./patch-workitem-task');
const { generateIterationLog } = require('./generate-iteration-logs');
const { DEFAULT_SCOPE_REJECTION_REPLY } = require('./security-and-scope-guardrail');

const WORKER_ROOT = path.resolve(__dirname, '..');

function parseIntervalMs(raw = '5m') {
  const m = String(raw).trim().match(/^(\d+)(s|m|h)?$/i);
  if (!m) return 5 * 60 * 1000;
  const val = parseInt(m[1], 10);
  const unit = (m[2] || 'm').toLowerCase();
  if (unit === 's') return val * 1000;
  if (unit === 'h') return val * 3600 * 1000;
  return val * 60 * 1000;
}

function buildHeadlessAgentPrompt(task, activation = {}) {
  const relRepo = activation.repoDir
    ? path.relative(WORKER_ROOT, activation.repoDir)
    : `WORKSPACES/${task.projectId}`;
  const activeBranch = activation.branch || 'main';
  return [
    `You are ISOLATED-TASK-WORKER inside ${WORKER_ROOT}. Follow AGENTS.md strictly.`,
    `Active WorkItem ID: ${task.id}`,
    `Active Workspace Project ID: ${task.projectId} (prepared & committed on branch '${activeBranch}' at ${relRepo}/; do NOT touch any other repo).`,
    `Title: ${task.title}`,
    `Exact User Request: ${task.exactUserRequest}`,
    task.requiresAttachmentInspection
      ? `MANDATORY GATE: Inspect all downloaded attachments in _process-logs/task-attachments/${task.id}/ via read_file BEFORE executing, and pass --attachment-analysis="..." to scripts/patch-workitem-task.js.`
      : `Attachments: None.`,
    `Execute Steps 2-5 from AGENTS.md:`,
    `1. Read ${relRepo}/AGENTS.md, ${relRepo}/.agents/project-data-models.md, ${relRepo}/.agents/project-data-manager-guide.md, ${relRepo}/.agents/workspace-datasources-and-integrations.md, and ${relRepo}/_notebooks/INDEX.md (plus ${relRepo}/dev.env, stage.env, prod.env when environment settings are needed). If this request is NOT related to this Workspace's data, models, datasources, notebooks, templates, files, or applications, immediately reject it via: node scripts/patch-workitem-task.js --id=${task.id} --project=${task.projectId} --status=rejected --reply="${DEFAULT_SCOPE_REJECTION_REPLY}"`,
    `2. Otherwise complete the data report / Handlebars template / file preparation (.md, .pdf, .csv) / allowed API or DataSource action in _artifacts/${task.id}/ using node scripts/workspace-tools-cli.js.`,
    `3. Finalize via node scripts/patch-workitem-task.js --id=${task.id} --project=${task.projectId} (--status=resolved with --attach=..., or --status=pending if a user clarifying question is needed, or --status=failed with sanitized blocker reasons).`,
  ].join('\n');
}

/**
 * Drains open WorkItem tasks in sequential FIFO batches of 5 (`Finish 5 -> Fetch Next 5`).
 */
async function runBatchDrainCycle({
  batchSize = 5,
  maxBatches = 10,
  headless = false,
  projectFilter = null,
} = {}) {
  let batchNumber = 0;
  let totalHandledInCycle = 0;

  try {
    while (batchNumber < maxBatches) {
      batchNumber++;
      const queue = await fetchAndValidateTasks({
        limit: batchSize,
        projectFilter,
      });

      if (!queue.tasks || queue.tasks.length === 0) {
        if (batchNumber === 1) {
          console.log('[Worker] 0 open tasks found. Parking all Workspace repos to idle.');
        } else {
          console.log(`[Worker] Queue drained after ${batchNumber - 1} batch(es) (${totalHandledInCycle} task(s) handled).`);
        }
        break;
      }

      console.log(`\n[Worker] === Executing FIFO Batch #${batchNumber} (${queue.tasks.length} task(s)) ===`);

      let progressedInBatch = 0;

      for (const task of queue.tasks) {
        console.log(`\n[Worker] -> Processing Task ${task.id} ("${task.title}") in Workspace ${task.projectId}`);

        // Deterministic Step 2 Guardrail fast-reject before touching any Workspace repo or data!
        if (!task.securityValidation.safe || !task.scopeCandidate.relatedCandidate) {
          console.warn(
            `[Guardrail] Auto-rejecting WorkItem ${task.id}: ${task.securityValidation.reason || task.scopeCandidate.reason}`
          );
          await patchWorkItemTask({
            id: task.id,
            projectId: task.projectId,
            status: 'rejected',
            reply: DEFAULT_SCOPE_REJECTION_REPLY,
            outcome: 'Rejected by Workspace Scope & Security Guardrail.',
            category: 'guardrail_rejected',
          });
          progressedInBatch++;
          totalHandledInCycle++;
          continue;
        }

        if (!headless) {
          console.log(
            `[Worker] Task ${task.id} passed pre-screen and is staged in tasks-queue.json (run with --headless or process via IDE /schedule cron).`
          );
          continue;
        }

        // Headless autonomous execution per isolated Workspace repo
        try {
          await claimWorkItemTask(task.id, task.projectId);
          const activation = await activateWorkspaceRepo(task.projectId, { workItem: task });

          const prompt = buildHeadlessAgentPrompt(task, activation);
          const cliBin = process.env.AGY_BIN || 'agy';
          execFileSync(cliBin, ['-p', prompt], {
            cwd: WORKER_ROOT,
            stdio: 'inherit',
          });

          progressedInBatch++;
          totalHandledInCycle++;
        } catch (err) {
          console.error(`[Worker] Headless execution error on ${task.id}: ${err.message}`);
          await patchWorkItemTask({
            id: task.id,
            projectId: task.projectId,
            status: 'failed',
            reply:
              'We encountered an unexpected execution issue while preparing your Workspace task and could not complete it automatically. Please review the task details or re-open it to retry.',
            outcome: 'Execution interrupted before task completion.',
          }).catch(() => {});
          progressedInBatch++;
          totalHandledInCycle++;
        } finally {
          parkWorkspaceRepo(task.projectId);
        }
      }

      if (totalHandledInCycle > 0) {
        generateIterationLog();
      }

      // In non-headless queue staging mode, do not infinite-loop over unstaged open items
      if (!headless && progressedInBatch === 0) {
        break;
      }
    }
  } finally {
    parkAllWorkspaceRepos();
  }

  return { totalHandledInCycle };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const getArg = (name) => {
    const prefix = `--${name}=`;
    const hit = args.find((a) => a.startsWith(prefix));
    return hit ? hit.slice(prefix.length) : null;
  };
  const hasFlag = (flag) => args.includes(`--${flag}`);

  const once = hasFlag('once');
  const headless = hasFlag('headless');
  const batchSize = parseInt(getArg('limit') || process.env.TASK_WORKER_BATCH_SIZE || '5', 10) || 5;
  const maxBatches =
    parseInt(getArg('max-batches') || process.env.TASK_WORKER_MAX_BATCHES_PER_RUN || '10', 10) || 10;
  const intervalStr = getArg('interval') || process.env.TASK_WORKER_POLL_INTERVAL || '5m';
  const intervalMs = parseIntervalMs(intervalStr);
  const projectFilter = getArg('project');

  if (once) {
    runBatchDrainCycle({ batchSize, maxBatches, headless, projectFilter })
      .then(() => process.exit(0))
      .catch((err) => {
        console.error(`[Worker] Fatal error: ${err.message}`);
        process.exit(1);
      });
  } else {
    let busy = false;
    let timer = null;

    const triggerPoll = async () => {
      if (busy) return;
      busy = true;
      if (timer) clearTimeout(timer);
      try {
        await runBatchDrainCycle({ batchSize, maxBatches, headless, projectFilter });
      } catch (err) {
        console.error(`[Worker] Cycle error: ${err.message}`);
      } finally {
        busy = false;
        const nextAt = new Date(Date.now() + intervalMs).toLocaleTimeString();
        console.log(
          `\n[Worker] Waiting ${intervalStr} for next check (scheduled at ${nextAt}) — Press [r] poll now, [s] repo status, [q] exit`
        );
        timer = setTimeout(triggerPoll, intervalMs);
      }
    };

    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (key) => {
        if (key === '\u0003' || key.toLowerCase() === 'q') {
          console.log('\n[Worker] Parking all Workspace repos and shutting down...');
          parkAllWorkspaceRepos();
          process.exit(0);
        } else if (key.toLowerCase() === 'r' || key === '\r' || key === '\n') {
          triggerPoll();
        } else if (key.toLowerCase() === 's') {
          const statuses = getWorkspaceReposStatus();
          console.log(`\n[Worker] Workspace Repos (${statuses.length}):`, statuses);
        }
      });
    }

    triggerPoll();
  }
}

module.exports = {
  parseIntervalMs,
  runBatchDrainCycle,
};

