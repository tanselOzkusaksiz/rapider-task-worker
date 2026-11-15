#!/usr/bin/env node

/**
 * patch-workitem-task.js
 *
 * Finalizes or updates a WorkItem (kind='task') on the Rapider API (Step 5):
 *   1. Enforces Mandatory Attachment / S3 Image Reading Gate (`--attachment-analysis`)
 *   2. Enforces Outbound Public Reply Confidentiality Gate (AGENTS.md Section 7)
 *   3. Uploads generated deliverables (`--attach=file1,file2`) to Workspace ProjectFiles
 *   4. Appends chronological `WorkItemEvent` reply (`POST /work-item-events`)
 *   5. Patches `WorkItem` (`PATCH /work-items/{id}`):
 *      - `resolved`:  needsAttention = false (Task completed with artifacts & summary)
 *      - `pending`:   needsAttention = true  (Clarifying question posted for user)
 *      - `failed`:    needsAttention = true  (Cannot complete; sanitized blocker reasons posted)
 *      - `rejected`:  needsAttention = false (Rejected by Step 2 Workspace/Security Guardrail)
 *   6. Clears `readAt: null` on `WorkItemRecipient` so the Inbox marks the update unread
 *   7. Records full audit metadata in `_process-logs/execution/daily-task-executions/`
 *
 * Usage:
 *   node scripts/patch-workitem-task.js --id=<workItemId> --status=resolved --attach=_artifacts/<id>/report.pdf,_artifacts/<id>/data.csv --reply="<summary>"
 *   node scripts/patch-workitem-task.js --id=<workItemId> --status=pending --reply="<clarifying question>"
 *   node scripts/patch-workitem-task.js --id=<workItemId> --status=failed --reply="<sanitized blocker reason>"
 *   node scripts/patch-workitem-task.js --id=<workItemId> --status=rejected --reply="<polite scope refusal>"
 */

const fs = require('fs');
const path = require('path');
const {
  authenticateBase,
  switchActiveProject,
  fetchWithRetry,
} = require('./rapider-api-auth');
const {
  validatePublicReplyConfidentiality,
  DEFAULT_SCOPE_REJECTION_REPLY,
} = require('./security-and-scope-guardrail');
const { uploadTaskArtifacts } = require('./upload-task-artifacts');
const { recordTaskExecution } = require('./task-execution-logger');
const { TASKS_QUEUE_FILE } = require('./fetch-and-validate-tasks');

const ALLOWED_TARGET_STATUSES = {
  resolved: { status: 'resolved', needsAttention: false, eventType: 'task_resolved' },
  completed: { status: 'completed', needsAttention: false, eventType: 'task_resolved' },
  pending: { status: 'pending', needsAttention: true, eventType: 'clarification_requested' },
  failed: { status: 'failed', needsAttention: true, eventType: 'task_failed' },
  rejected: { status: 'rejected', needsAttention: false, eventType: 'task_rejected' },
};

/**
 * Pure mapper from requested status keyword to WorkItem patch fields & eventType.
 */
function resolveTargetStatusMappingPure(rawStatus) {
  const key = String(rawStatus || 'resolved').trim().toLowerCase();
  const mapping = ALLOWED_TARGET_STATUSES[key];
  if (!mapping) {
    throw new Error(
      `Unsupported target status "${rawStatus}". Allowed statuses: resolved, pending, failed, rejected.`
    );
  }
  return mapping;
}

async function patchWorkItemTask(options = {}) {
  const workItemId = String(options.id || options.workItemId || '').trim();
  if (!workItemId) {
    throw new Error('WorkItem ID is required (--id=<workItemId>).');
  }

  const mapping = resolveTargetStatusMappingPure(options.status || 'resolved');
  const replyMarkdown =
    mapping.status === 'rejected' && !options.reply
      ? DEFAULT_SCOPE_REJECTION_REPLY
      : String(options.reply || '').trim();

  if (!replyMarkdown) {
    throw new Error('A public reply/comment message is required (--reply="<markdown>").');
  }

  const outcomeText = String(options.outcome || replyMarkdown.split('\n')[0]).trim().slice(0, 500);
  const attachmentAnalysis = options.attachmentAnalysis ? String(options.attachmentAnalysis).trim() : null;

  // 1. Outbound Public Reply Confidentiality Check (STRICT - ZERO TOLERANCE)
  const replyCheck = validatePublicReplyConfidentiality(replyMarkdown);
  if (!replyCheck.valid) {
    throw new Error(
      `PUBLIC CONFIDENTIALITY VIOLATION in --reply: ${replyCheck.violations.join('; ')}. Sanitize reply before posting.`
    );
  }
  const outcomeCheck = validatePublicReplyConfidentiality(outcomeText);
  if (!outcomeCheck.valid) {
    throw new Error(
      `PUBLIC CONFIDENTIALITY VIOLATION in --outcome: ${outcomeCheck.violations.join('; ')}.`
    );
  }

  // 2. Check tasks-queue.json for cached projectId & Mandatory Attachment Inspection Gate
  let queueEntry = null;
  let queueData = null;
  if (fs.existsSync(TASKS_QUEUE_FILE)) {
    try {
      queueData = JSON.parse(fs.readFileSync(TASKS_QUEUE_FILE, 'utf8'));
      if (Array.isArray(queueData.tasks)) {
        queueEntry = queueData.tasks.find((t) => t.id === workItemId) || null;
      }
    } catch (_) {}
  }

  if (
    mapping.status !== 'rejected' &&
    queueEntry &&
    queueEntry.requiresAttachmentInspection &&
    !attachmentAnalysis
  ) {
    throw new Error(
      `MANDATORY ATTACHMENT INSPECTION GATE: WorkItem ${workItemId} contains attached files/images (_process-logs/task-attachments/${workItemId}/). Inspect them via read_file first and pass --attachment-analysis="<findings>".`
    );
  }

  // 3. Authenticate & locate WorkItem in its isolated Workspace
  const { token: baseToken, creds } = await authenticateBase();
  let projectId = options.projectId || queueEntry?.projectId || null;
  let projectToken = null;
  let existingWorkItem = null;

  if (projectId) {
    projectToken = await switchActiveProject(creds, baseToken, projectId);
    const getRes = await fetchWithRetry(`${creds.backendUrl}/work-items/${encodeURIComponent(workItemId)}`, {
      headers: { Authorization: projectToken },
    });
    if (getRes.ok) existingWorkItem = await getRes.json();
  }

  if (!existingWorkItem) {
    const projRes = await fetchWithRetry(`${creds.backendUrl}/projects`, {
      headers: { Authorization: baseToken },
    });
    const projects = await projRes.json().catch(() => []);
    for (const p of Array.isArray(projects) ? projects : []) {
      const pTok = await switchActiveProject(creds, baseToken, p.id).catch(() => null);
      if (!pTok) continue;
      const getRes = await fetchWithRetry(`${creds.backendUrl}/work-items/${encodeURIComponent(workItemId)}`, {
        headers: { Authorization: pTok },
      });
      if (getRes.ok) {
        existingWorkItem = await getRes.json();
        projectId = p.id;
        projectToken = pTok;
        break;
      }
    }
  }

  if (!existingWorkItem || !projectId || !projectToken) {
    throw new Error(`Could not locate WorkItem ${workItemId} across accessible Workspaces.`);
  }

  // 4. Upload deliverables (if --attach provided) & merge into contextRefs
  const attachPaths = Array.isArray(options.attachFiles)
    ? options.attachFiles
    : String(options.attachFiles || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);

  let uploadedRefs = [];
  if (attachPaths.length > 0) {
    uploadedRefs = await uploadTaskArtifacts({
      projectId,
      workItemId,
      filePaths: attachPaths,
    });
  }

  const existingRefs = Array.isArray(existingWorkItem.contextRefs) ? existingWorkItem.contextRefs : [];
  const mergedContextRefs = [...existingRefs];
  for (const ref of uploadedRefs) {
    if (!mergedContextRefs.some((r) => r && r.id === ref.id)) {
      mergedContextRefs.push(ref);
    }
  }

  // 5. Append chronological WorkItemEvent reply
  const evFilter = encodeURIComponent(
    JSON.stringify({ where: { workItemId }, order: ['sequence DESC'], limit: 1 })
  );
  const lastEvRes = await fetchWithRetry(`${creds.backendUrl}/work-item-events?filter=${evFilter}`, {
    headers: { Authorization: projectToken },
  });
  const lastEvList = await lastEvRes.json().catch(() => []);
  const nextSequence =
    Array.isArray(lastEvList) && lastEvList[0] && typeof lastEvList[0].sequence === 'number'
      ? lastEvList[0].sequence + 1
      : 1;

  const eventRes = await fetchWithRetry(`${creds.backendUrl}/work-item-events`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: projectToken,
    },
    body: JSON.stringify({
      workItemId,
      sequence: nextSequence,
      eventType: mapping.eventType,
      actor: 'task-worker',
      data: {
        status: mapping.status,
        messageMarkdown: replyMarkdown,
        ...(uploadedRefs.length > 0 ? { attachments: uploadedRefs } : {}),
      },
    }),
  });

  let createdEventId = null;
  if (eventRes.ok) {
    const createdEv = await eventRes.json().catch(() => ({}));
    createdEventId = createdEv.id || null;
  }

  // 6. Patch WorkItem status, needsAttention, outcome, recommendation & contextRefs
  const nextRevision = (typeof existingWorkItem.revision === 'number' ? existingWorkItem.revision : 1) + 1;
  const recommendationText =
    mapping.status === 'pending'
      ? replyMarkdown
      : mapping.status === 'failed'
        ? `Unable to complete automatically: ${outcomeText}`
        : mapping.status === 'rejected'
          ? outcomeText
          : outcomeText;

  // Append clean resolution block to bodyMarkdown so Inbox reader shows both original spec & latest reply/files
  const attachmentLinksMd =
    uploadedRefs.length > 0
      ? '\n\n**Attached Deliverables:**\n' +
        uploadedRefs.map((r) => `- \`${r.name}\` (\`${r.mimeType}\`)`).join('\n')
      : '';
  const baseBody = String(existingWorkItem.bodyMarkdown || '').replace(
    /\n\n---\n## Task Worker Update[\s\S]*$/,
    ''
  );
  const updatedBodyMarkdown = `${baseBody}\n\n---\n## Task Worker Update (${mapping.status.toUpperCase()})\n${replyMarkdown}${attachmentLinksMd}`;

  const patchPayload = {
    status: mapping.status,
    needsAttention: mapping.needsAttention,
    revision: nextRevision,
    outcome: outcomeText,
    recommendation: {
      text: recommendationText,
    },
    bodyMarkdown: updatedBodyMarkdown,
    ...(mergedContextRefs.length > 0 ? { contextRefs: mergedContextRefs } : {}),
  };

  const patchRes = await fetchWithRetry(`${creds.backendUrl}/work-items/${encodeURIComponent(workItemId)}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Authorization: projectToken,
    },
    body: JSON.stringify(patchPayload),
  });

  if (!patchRes.ok) {
    const errText = await patchRes.text().catch(() => '');
    throw new Error(`Failed to patch WorkItem ${workItemId} (HTTP ${patchRes.status}): ${errText}`);
  }

  // 7. Mark WorkItemRecipient unread (`readAt: null`) so Inbox highlights the update
  try {
    const recFilter = encodeURIComponent(JSON.stringify({ where: { workItemId } }));
    const recRes = await fetchWithRetry(`${creds.backendUrl}/work-item-recipients?filter=${recFilter}`, {
      headers: { Authorization: projectToken },
    });
    const recipients = await recRes.json().catch(() => []);
    for (const rec of Array.isArray(recipients) ? recipients : []) {
      if (rec && rec.id && rec.readAt) {
        await fetchWithRetry(`${creds.backendUrl}/work-item-recipients/${encodeURIComponent(rec.id)}`, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            Authorization: projectToken,
          },
          body: JSON.stringify({ readAt: null }),
        });
      }
    }
  } catch (_) {}

  // 8. Record execution in Daily Execution JSON Ledger & update local tasks-queue.json
  recordTaskExecution({
    workItemId,
    projectId,
    workspaceName: queueEntry?.workspaceName || null,
    title: existingWorkItem.title || queueEntry?.title || 'Workspace Task',
    taskCategory: options.category || (mapping.status === 'rejected' ? 'guardrail_rejected' : 'workspace_task'),
    status: mapping.status,
    needsAttention: mapping.needsAttention,
    outcome: outcomeText,
    attachedFiles: uploadedRefs.map((r) => ({ id: r.id, name: r.name, mimeType: r.mimeType })),
    eventId: createdEventId,
    attachmentAnalysis,
  });

  if (queueData && Array.isArray(queueData.tasks)) {
    const idx = queueData.tasks.findIndex((t) => t.id === workItemId);
    if (idx >= 0) {
      queueData.tasks[idx].status = mapping.status;
      queueData.tasks[idx].needsAttention = mapping.needsAttention;
      queueData.tasks[idx].completedAt = new Date().toISOString();
      fs.writeFileSync(TASKS_QUEUE_FILE, JSON.stringify(queueData, null, 2), 'utf8');
    }
  }

  console.log(
    `[PatchTask] WorkItem ${workItemId} -> status='${mapping.status}', needsAttention=${mapping.needsAttention}, attachments=${uploadedRefs.length}`
  );

  return {
    workItemId,
    projectId,
    status: mapping.status,
    needsAttention: mapping.needsAttention,
    uploadedRefs,
    eventId: createdEventId,
  };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const getArg = (name) => {
    const prefix = `--${name}=`;
    const hit = args.find((a) => a.startsWith(prefix));
    return hit ? hit.slice(prefix.length) : null;
  };

  const replyFile = getArg('reply-file');
  const replyText = replyFile
    ? fs.readFileSync(path.resolve(replyFile), 'utf8')
    : getArg('reply') || getArg('solution');

  patchWorkItemTask({
    id: getArg('id') || getArg('workItemId'),
    projectId: getArg('project'),
    status: getArg('status') || 'resolved',
    reply: replyText,
    outcome: getArg('outcome'),
    attachFiles: getArg('attach') || getArg('files'),
    category: getArg('category'),
    attachmentAnalysis: getArg('attachment-analysis') || getArg('image-analysis'),
  }).catch((err) => {
    console.error(`[PatchTask] Fatal error: ${err.message}`);
    process.exit(1);
  });
}

module.exports = {
  resolveTargetStatusMappingPure,
  patchWorkItemTask,
};

