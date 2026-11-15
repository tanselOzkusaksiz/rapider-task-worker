#!/usr/bin/env node

/**
 * rapider-task-ctl.js
 *
 * Operator Control CLI for the Rapider Isolated Task Orchestrator.
 * Communicates with the Admin Control Plane (`/admin/task-orchestrator/*`) using
 * the admin credentials in `.env`.
 *
 * Usage:
 *   node scripts/rapider-task-ctl.js status
 *   node scripts/rapider-task-ctl.js set-concurrency 10
 *   node scripts/rapider-task-ctl.js pause
 *   node scripts/rapider-task-ctl.js hard-pause
 *   node scripts/rapider-task-ctl.js resume
 *   node scripts/rapider-task-ctl.js pin-top <workItemId>
 *   node scripts/rapider-task-ctl.js kill-task <workItemId>
 *   node scripts/rapider-task-ctl.js requeue-top <workItemId>
 *   node scripts/rapider-task-ctl.js logs <workItemId> [--type=log|jsonl|patch|tail]
 *   node scripts/rapider-task-ctl.js cache-status
 */

const { authenticateBase, fetchWithRetry } = require('./rapider-api-auth');
const { getWorkspaceReposStatus } = require('./manage-workspace-repos');

async function callAdmin(method, endpointPath, body = undefined) {
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
      data?.error?.message || data?.message || `HTTP ${res.status}`
    );
  }
  return data;
}

async function main() {
  const [cmd, arg1, ...rest] = process.argv.slice(2);

  if (!cmd || cmd === 'help' || cmd === '--help') {
    console.log([
      'Rapider Isolated Task Orchestrator Control CLI',
      'Commands:',
      '  status                        Show live concurrency, workers, active tasks & next 20 queue',
      '  history                       Show last 20 completed/failed/pending tasks',
      '  set-concurrency <1..100>      Change MAX_CONCURRENT live without restarting workers',
      '  pause                         Soft-pause new task claims (active tasks finish cleanly)',
      '  hard-pause                    Hard-pause & kill all active sandboxed PGIDs immediately',
      '  resume                        Resume task claiming',
      '  pin-top <workItemId>          Move a queued task to Rank #1 (Top of Queue)',
      '  kill-task <workItemId>        Kill an active task immediately',
      '  requeue-top <workItemId>      Re-queue a finished/failed task at Rank #1',
      '  logs <workItemId> [--type=..] Stream private S3 .log, .jsonl, .patch, or live tail',
      '  cache-status                  Verify local master repos are parked on orphan idle branch',
    ].join('\n'));
    return;
  }

  if (cmd === 'cache-status') {
    const repos = getWorkspaceReposStatus();
    console.log(JSON.stringify({ workspaceMasterRepos: repos }, null, 2));
    return;
  }

  if (cmd === 'status') {
    const overview = await callAdmin('GET', '/admin/task-orchestrator/overview');
    console.log('=== RAPIDER ISOLATED TASK ORCHESTRATOR STATUS ===');
    console.log(
      `State: ${overview.state.hardPaused ? 'HARD PAUSED' : overview.state.paused ? 'PAUSED' : 'RUNNING'} | ` +
        `Active: ${overview.metrics.activeCount}/${overview.metrics.maxConcurrent} | ` +
        `Queued: ${overview.metrics.totalQueuedCount} | ` +
        `Online Workers: ${overview.metrics.onlineWorkersCount}`
    );
    console.log('\n--- Active In-Progress Tasks ---');
    if (overview.activeTasks.length === 0) {
      console.log('  (none)');
    } else {
      for (const t of overview.activeTasks) {
        console.log(`  * [${t.id}] ${t.title} (${t.workspaceName}) — worker=${t.execution?.workerId || 'n/a'}`);
      }
    }
    console.log('\n--- Next 20 Queued Tasks ---');
    if (overview.nextQueue.length === 0) {
      console.log('  (empty queue)');
    } else {
      for (const q of overview.nextQueue) {
        console.log(`  #${String(q.rank).padEnd(2)} [${q.id}] ${q.title} (${q.workspaceName})`);
      }
    }
    return;
  }

  if (cmd === 'history') {
    const res = await callAdmin('GET', '/admin/task-orchestrator/history?limit=20');
    console.log(`=== LAST ${res.count} FINISHED TASKS ===`);
    for (const h of res.history) {
      console.log(
        `  [${String(h.status).toUpperCase().padEnd(8)}] ${h.id} | ${h.title} (${h.workspaceName})`
      );
    }
    return;
  }

  if (cmd === 'set-concurrency') {
    const n = parseInt(arg1, 10);
    if (!Number.isFinite(n) || n < 1 || n > 100) {
      throw new Error('Provide an integer between 1 and 100.');
    }
    const res = await callAdmin('PATCH', '/admin/task-orchestrator/config', {
      maxConcurrent: n,
    });
    console.log(`[OK] Live maxConcurrent updated to ${res.state.maxConcurrent}.`);
    return;
  }

  if (cmd === 'pause') {
    await callAdmin('PATCH', '/admin/task-orchestrator/config', { paused: true, hardPaused: false });
    console.log('[OK] Orchestrator soft-paused (active tasks will finish; no new tasks claimed).');
    return;
  }

  if (cmd === 'hard-pause') {
    await callAdmin('PATCH', '/admin/task-orchestrator/config', { paused: true, hardPaused: true });
    console.log('[OK] Orchestrator HARD-PAUSED (kill signal dispatched to all active worker PGIDs).');
    return;
  }

  if (cmd === 'resume') {
    await callAdmin('PATCH', '/admin/task-orchestrator/config', { paused: false, hardPaused: false });
    console.log('[OK] Orchestrator resumed.');
    return;
  }

  if (cmd === 'pin-top') {
    if (!arg1) throw new Error('Usage: rapider-task-ctl.js pin-top <workItemId>');
    const res = await callAdmin('PATCH', '/admin/task-orchestrator/queue/reorder', {
      workItemId: arg1,
      operation: 'pin_top',
    });
    console.log(`[OK] Pinned ${arg1} to Rank #1 (updated ${res.updatedCount} items).`);
    return;
  }

  if (cmd === 'kill-task') {
    if (!arg1) throw new Error('Usage: rapider-task-ctl.js kill-task <workItemId>');
    const res = await callAdmin(
      'POST',
      `/admin/task-orchestrator/tasks/${encodeURIComponent(arg1)}/control`,
      { action: 'kill' }
    );
    console.log(`[OK] Kill signal dispatched for ${res.workItemId}.`);
    return;
  }

  if (cmd === 'requeue-top') {
    if (!arg1) throw new Error('Usage: rapider-task-ctl.js requeue-top <workItemId>');
    const res = await callAdmin(
      'POST',
      `/admin/task-orchestrator/tasks/${encodeURIComponent(arg1)}/control`,
      { action: 'requeue_top' }
    );
    console.log(`[OK] Re-queued ${res.workItemId} at Rank #1.`);
    return;
  }

  if (cmd === 'logs') {
    if (!arg1) throw new Error('Usage: rapider-task-ctl.js logs <workItemId> [--type=log|jsonl|patch|tail]');
    const typeFlag = [arg1, ...rest].find((a) => a.startsWith('--type='));
    const logType = typeFlag ? typeFlag.slice('--type='.length) : 'log';
    const res = await callAdmin(
      'GET',
      `/admin/task-orchestrator/tasks/${encodeURIComponent(arg1)}/logs?type=${encodeURIComponent(logType)}`
    );
    process.stdout.write(res.content || '');
    if (!String(res.content || '').endsWith('\n')) process.stdout.write('\n');
    return;
  }

  throw new Error(`Unknown command "${cmd}". Run with --help for usage.`);
}

main().catch((err) => {
  console.error(`[TaskCtl] Error: ${err.message}`);
  process.exit(1);
});

