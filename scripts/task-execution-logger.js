#!/usr/bin/env node

/**
 * task-execution-logger.js
 *
 * Records completed, pending-clarification, failed, and guardrail-rejected
 * WorkItem (kind='task') executions into daily structured JSON ledgers:
 *   _process-logs/execution/daily-task-executions/task-executions-YYYY-MM-DD.json
 * and maintains rolling aggregate totals in:
 *   _process-logs/execution/task-executions-summary.json
 */

const fs = require('fs');
const path = require('path');

const EXECUTION_LOGS_DIR = path.resolve(__dirname, '../_process-logs/execution/daily-task-executions');
const SUMMARY_FILE = path.resolve(__dirname, '../_process-logs/execution/task-executions-summary.json');

function ensureDirectories() {
  fs.mkdirSync(EXECUTION_LOGS_DIR, { recursive: true });
}

function getTodayDateString(isoTimestamp) {
  const d = isoTimestamp ? new Date(isoTimestamp) : new Date();
  return d.toISOString().slice(0, 10);
}

function getDailyLogPath(dateStr) {
  ensureDirectories();
  return path.join(EXECUTION_LOGS_DIR, `task-executions-${dateStr}.json`);
}

function loadDailyLog(dateStr) {
  const filePath = getDailyLogPath(dateStr);
  if (fs.existsSync(filePath)) {
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (_) {}
  }
  return {
    date: dateStr,
    updatedAt: new Date().toISOString(),
    totals: {
      totalProcessed: 0,
      resolved: 0,
      pendingClarification: 0,
      failed: 0,
      rejected: 0,
    },
    executions: [],
  };
}

function recomputeTotals(executions = []) {
  const totals = {
    totalProcessed: executions.length,
    resolved: 0,
    pendingClarification: 0,
    failed: 0,
    rejected: 0,
  };
  for (const ex of executions) {
    const st = String(ex.status || '').toLowerCase();
    if (st === 'resolved' || st === 'completed') totals.resolved++;
    else if (st === 'pending') totals.pendingClarification++;
    else if (st === 'failed') totals.failed++;
    else if (st === 'rejected') totals.rejected++;
  }
  return totals;
}

/**
 * Appends or updates a task execution record in the daily ledger and summary file.
 *
 * @param {{
 *   workItemId: string,
 *   projectId: string,
 *   workspaceName?: string,
 *   title?: string,
 *   taskCategory?: string,
 *   status: string,
 *   needsAttention?: boolean,
 *   outcome?: string,
 *   attachedFiles?: Array<{ id?: string, name: string, mimeType?: string }>,
 *   eventId?: string | null,
 *   commitSha?: string | null,
 *   attachmentAnalysis?: string | null,
 *   completedAt?: string
 * }} entry
 */
function recordTaskExecution(entry) {
  const completedAt = entry.completedAt || new Date().toISOString();
  const dateStr = getTodayDateString(completedAt);
  const daily = loadDailyLog(dateStr);

  const normalized = {
    workItemId: entry.workItemId,
    projectId: entry.projectId,
    workspaceName: entry.workspaceName || null,
    title: entry.title || 'Workspace Task',
    taskCategory: entry.taskCategory || 'workspace_task',
    status: entry.status,
    needsAttention: Boolean(entry.needsAttention),
    outcome: entry.outcome || '',
    attachedFiles: Array.isArray(entry.attachedFiles) ? entry.attachedFiles : [],
    eventId: entry.eventId || null,
    commitSha: entry.commitSha || null,
    attachmentAnalysis: entry.attachmentAnalysis || null,
    completedAt,
    hourUtc: completedAt.slice(11, 13),
  };

  const existingIdx = daily.executions.findIndex(
    (item) => item.workItemId === normalized.workItemId && item.status === normalized.status
  );
  if (existingIdx >= 0) {
    daily.executions[existingIdx] = normalized;
  } else {
    daily.executions.push(normalized);
  }

  daily.updatedAt = new Date().toISOString();
  daily.totals = recomputeTotals(daily.executions);

  fs.writeFileSync(getDailyLogPath(dateStr), JSON.stringify(daily, null, 2), 'utf8');
  updateRollingSummary();

  return normalized;
}

function updateRollingSummary() {
  ensureDirectories();
  const files = fs
    .readdirSync(EXECUTION_LOGS_DIR)
    .filter((f) => /^task-executions-\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort();

  const byDate = {};
  const grandTotals = {
    totalProcessed: 0,
    resolved: 0,
    pendingClarification: 0,
    failed: 0,
    rejected: 0,
  };

  for (const file of files) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(EXECUTION_LOGS_DIR, file), 'utf8'));
      byDate[parsed.date] = parsed.totals;
      grandTotals.totalProcessed += parsed.totals.totalProcessed || 0;
      grandTotals.resolved += parsed.totals.resolved || 0;
      grandTotals.pendingClarification += parsed.totals.pendingClarification || 0;
      grandTotals.failed += parsed.totals.failed || 0;
      grandTotals.rejected += parsed.totals.rejected || 0;
    } catch (_) {}
  }

  const summary = {
    updatedAt: new Date().toISOString(),
    grandTotals,
    byDate,
  };
  fs.writeFileSync(SUMMARY_FILE, JSON.stringify(summary, null, 2), 'utf8');
}

module.exports = {
  recordTaskExecution,
  loadDailyLog,
  getDailyLogPath,
  updateRollingSummary,
};
