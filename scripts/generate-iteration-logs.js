#!/usr/bin/env node

/**
 * generate-iteration-logs.js
 *
 * Generates structured markdown audit logs for ISOLATED-TASK-WORKER runs under:
 *   logs/task-worker-agent-log-YYYYMMDD-{Iteration}.md
 *
 * Synthesizes today's daily execution ledger entries and active session status
 * without ever writing secrets or credentials.
 */

const fs = require('fs');
const path = require('path');
const { loadDailyLog } = require('./task-execution-logger');

const WORKER_ROOT = path.resolve(__dirname, '..');
const LOGS_DIR = path.resolve(WORKER_ROOT, 'logs');

function getNextIterationNumber(dateCompact) {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
  const prefix = `task-worker-agent-log-${dateCompact}-`;
  const existing = fs
    .readdirSync(LOGS_DIR)
    .filter((name) => name.startsWith(prefix) && name.endsWith('.md'));

  let maxIter = 0;
  for (const name of existing) {
    const m = name.match(/-(\d+)\.md$/);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n > maxIter) maxIter = n;
    }
  }
  return maxIter + 1;
}

function generateIterationLog(options = {}) {
  const now = new Date();
  const isoDate = options.date || now.toISOString().slice(0, 10);
  const dateCompact = isoDate.replace(/-/g, '');
  const iter = options.iter || getNextIterationNumber(dateCompact);
  const daily = loadDailyLog(isoDate);

  const recentExecutions = daily.executions.slice(-10);
  const rowsMd =
    recentExecutions.length === 0
      ? '_No task executions recorded yet for this date._'
      : [
          '| WorkItem ID | Workspace (`projectId`) | Category | Final Status | Needs Attention | Attached Files | Completed At (UTC) |',
          '| :--- | :--- | :--- | :--- | :--- | :--- | :--- |',
          ...recentExecutions.map((ex) => {
            const filesList = (ex.attachedFiles || []).map((f) => `\`${f.name}\``).join(', ') || '—';
            return `| \`${ex.workItemId}\` | \`${ex.projectId}\` | \`${ex.taskCategory}\` | **\`${ex.status}\`** | \`${ex.needsAttention}\` | ${filesList} | ${ex.completedAt} |`;
          }),
        ].join('\n');

  const detailsMd = recentExecutions
    .map(
      (ex, i) =>
        `### ${i + 1}. \`${ex.workItemId}\` — ${ex.title}\n` +
        `- **Status:** \`${ex.status}\` (\`needsAttention: ${ex.needsAttention}\`)\n` +
        `- **Workspace ID:** \`${ex.projectId}\`\n` +
        `- **Outcome:** ${ex.outcome || '—'}\n`
    )
    .join('\n');

  const content = [
    `# ISOLATED-TASK-WORKER Iteration Log — ${isoDate} (#${iter})`,
    ``,
    `- **Generated At:** \`${now.toISOString()}\``,
    `- **Date:** \`${isoDate}\``,
    `- **Iteration:** \`#${iter}\``,
    `- **Daily Totals:** Processed \`${daily.totals.totalProcessed}\` | Resolved \`${daily.totals.resolved}\` | Pending Question \`${daily.totals.pendingClarification}\` | Failed \`${daily.totals.failed}\` | Rejected \`${daily.totals.rejected}\``,
    ``,
    `---`,
    ``,
    `## Recent Batch Executions`,
    ``,
    rowsMd,
    ``,
    `---`,
    ``,
    `## Task Resolution Summaries`,
    ``,
    detailsMd || '_None_',
    ``,
  ].join('\n');

  fs.mkdirSync(LOGS_DIR, { recursive: true });
  const filePath = path.join(LOGS_DIR, `task-worker-agent-log-${dateCompact}-${iter}.md`);
  fs.writeFileSync(filePath, content, 'utf8');
  return filePath;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const iterArg = args.find((a) => a.startsWith('--iter='));
  const dateArg = args.find((a) => a.startsWith('--date='));
  const outPath = generateIterationLog({
    iter: iterArg ? parseInt(iterArg.split('=')[1], 10) : undefined,
    date: dateArg ? dateArg.split('=')[1] : undefined,
  });
  console.log(`[Logs] Wrote iteration audit log: ${outPath}`);
}

module.exports = {
  generateIterationLog,
};
