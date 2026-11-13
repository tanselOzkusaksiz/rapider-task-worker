#!/usr/bin/env node

/**
 * fetch-and-validate-tasks.js
 *
 * Fetches the global OLDEST 5 open WorkItems (kind='task', status='open') across
 * accessible Workspaces, enriches each with chronological WorkItemEvent replies,
 * downloads attached ProjectFiles & S3/Spaces images for mandatory inspection,
 * runs deterministic Step 2 security/scope pre-screening, and writes tasks-queue.json.
 *
 * Usage:
 *   node scripts/fetch-and-validate-tasks.js                     # Oldest 5 open tasks (kind='task')
 *   node scripts/fetch-and-validate-tasks.js --limit=5           # Explicit batch size (default 5)
 *   node scripts/fetch-and-validate-tasks.js --project=<id|name> # Scope to a single Workspace
 *   node scripts/fetch-and-validate-tasks.js --status=open,queued# Override eligible statuses
 *   node scripts/fetch-and-validate-tasks.js --recover-stale     # Also reclaim stale 'running' leases
 *   node scripts/fetch-and-validate-tasks.js --all               # Diagnostic view across statuses
 *   node scripts/fetch-and-validate-tasks.js --claim=<workItemId># Claim task -> status='running'
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const {
  loadCredentials,
  loadSpacesCredentialsFromEnv,
  fetchWithRetry,
  authenticateBase,
  switchActiveProject,
} = require('./rapider-api-auth');
const {
  validateTaskSecurity,
  evaluateWorkspaceRelevanceHeuristic,
} = require('./security-and-scope-guardrail');

const WORKER_ROOT = path.resolve(__dirname, '..');
const TASKS_QUEUE_FILE = path.resolve(WORKER_ROOT, 'tasks-queue.json');
const TASK_ATTACHMENTS_DIR = path.resolve(WORKER_ROOT, '_process-logs/task-attachments');

const DEFAULT_BATCH_LIMIT = parseInt(process.env.TASK_WORKER_BATCH_SIZE || '5', 10) || 5;
const DEFAULT_ELIGIBLE_STATUSES = (process.env.TASK_WORKER_ELIGIBLE_STATUSES || 'open,Open')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const STALE_RUNNING_LEASE_MS = parseInt(process.env.STALE_RUNNING_LEASE_MS || '900000', 10) || 900000;

/**
 * Pure deterministic filter + FIFO oldest-first sorter (`occurredAt` -> `createdDate` ASC),
 * returning strictly the oldest `limit` tasks (`kind === 'task'`, `status` in `eligibleStatuses`).
 *
 * @param {Array<Record<string, any>>} rawItems Candidate WorkItems across workspaces
 * @param {{
 *   limit?: number,
 *   eligibleStatuses?: string[],
 *   recoverStaleRunning?: boolean,
 *   staleLeaseMs?: number,
 *   nowMs?: number
 * }} [options]
 * @returns {{ selected: Array<Record<string, any>>, totalEligible: number }}
 */
function selectOldestOpenTaskWorkItemsPure(rawItems = [], options = {}) {
  const limit = typeof options.limit === 'number' && options.limit > 0 ? options.limit : DEFAULT_BATCH_LIMIT;
  const eligibleLower = new Set(
    (options.eligibleStatuses && options.eligibleStatuses.length
      ? options.eligibleStatuses
      : DEFAULT_ELIGIBLE_STATUSES
    ).map((s) => String(s).toLowerCase())
  );
  const recoverStale = Boolean(options.recoverStaleRunning);
  const staleLeaseMs = options.staleLeaseMs ?? STALE_RUNNING_LEASE_MS;
  const nowMs = options.nowMs ?? Date.now();

  const seenIds = new Set();
  const filtered = [];

  for (const item of rawItems) {
    if (!item || !item.id || item.isDeleted === true) continue;
    if (seenIds.has(item.id)) continue;

    const kind = String(item.kind || 'task').trim().toLowerCase();
    if (kind !== 'task') continue;

    const rawStatus = String(item.status || 'open').trim().toLowerCase();
    let isEligible = eligibleLower.has(rawStatus);

    if (!isEligible && recoverStale && rawStatus === 'running') {
      const updatedMs = Date.parse(item.updatedDate || item.occurredAt || item.createdDate || '');
      if (!Number.isNaN(updatedMs) && nowMs - updatedMs >= staleLeaseMs) {
        isEligible = true;
      }
    }

    if (!isEligible) continue;

    seenIds.add(item.id);
    filtered.push(item);
  }

  filtered.sort((a, b) => {
    const tsA = Date.parse(a.occurredAt || a.createdDate || '1970-01-01T00:00:00.000Z') || 0;
    const tsB = Date.parse(b.occurredAt || b.createdDate || '1970-01-01T00:00:00.000Z') || 0;
    if (tsA !== tsB) return tsA - tsB;
    return String(a.id).localeCompare(String(b.id));
  });

  return {
    selected: filtered.slice(0, limit),
    totalEligible: filtered.length,
  };
}

/**
 * Extracts the user's exact request from WorkItem.source, WorkItem.facts, or WorkItem.bodyMarkdown.
 *
 * @param {Record<string, any>} workItem
 * @returns {string}
 */
function extractExactUserRequest(workItem) {
  if (!workItem) return '';
  if (workItem.source && typeof workItem.source.exactUserRequest === 'string' && workItem.source.exactUserRequest.trim()) {
    return workItem.source.exactUserRequest.trim();
  }
  if (Array.isArray(workItem.facts)) {
    const match = workItem.facts.find((f) => f && f.key === 'exactUserRequest' && typeof f.value === 'string');
    if (match && match.value.trim()) return match.value.trim();
  }
  const body = String(workItem.bodyMarkdown || '').trim();
  if (body) return body;
  return String(workItem.summary || workItem.title || '').trim();
}

/**
 * Extracts all S3 / DigitalOcean Spaces / image URLs from WorkItem markdown and WorkItemEvent replies.
 *
 * @param {Record<string, any>} workItem
 * @param {Array<Record<string, any>>} events
 * @returns {string[]}
 */
function extractWorkItemImageUrls(workItem, events = []) {
  const urls = new Set();

  const scanText = (text) => {
    if (!text || typeof text !== 'string') return;
    const mdImgRegex = /!\[[^\]]*\]\((https?:\/\/[^\s)"'<>]+|s3:\/\/[^\s)"'<>]+)\)/gi;
    let m;
    while ((m = mdImgRegex.exec(text)) !== null) {
      if (m[1]) urls.add(m[1].trim());
    }
    const rawImgRegex = /(?:https?:\/\/|s3:\/\/)[^\s)"'<>]+?(?:\.(?:png|jpe?g|webp|gif|svg)(?:\?[^\s)"'<>]*)?|(?:digitaloceanspaces\.com|amazonaws\.com)\/task\/[^\s)"'<>]+)/gi;
    while ((m = rawImgRegex.exec(text)) !== null) {
      urls.add(m[0].trim().replace(/[.,;:]+$/, ''));
    }
  };

  scanText(workItem?.bodyMarkdown);
  scanText(workItem?.summary);
  scanText(workItem?.source?.exactUserRequest);

  for (const ev of events) {
    if (!ev) continue;
    if (typeof ev.data === 'string') scanText(ev.data);
    else if (ev.data && typeof ev.data === 'object') {
      scanText(ev.data.messageMarkdown);
      scanText(ev.data.content);
      scanText(ev.data.comment);
    }
  }

  return Array.from(urls);
}

/**
 * Collects unique ProjectFile IDs referenced on WorkItem.source.attachmentFileIds or WorkItem.contextRefs.
 *
 * @param {Record<string, any>} workItem
 * @returns {string[]}
 */
function extractAttachedProjectFileIds(workItem) {
  const ids = new Set();
  const srcIds = workItem?.source?.attachmentFileIds;
  if (Array.isArray(srcIds)) {
    for (const id of srcIds) {
      if (typeof id === 'string' && id.trim()) ids.add(id.trim());
    }
  }
  if (Array.isArray(workItem?.contextRefs)) {
    for (const ref of workItem.contextRefs) {
      if (ref && ref.type === 'projectFile' && typeof ref.id === 'string' && ref.id.trim()) {
        ids.add(ref.id.trim());
      }
    }
  }
  return Array.from(ids);
}

/**
 * Downloads attached ProjectFiles and embedded S3/Spaces images into
 * _process-logs/task-attachments/<workItemId>/ so ISOLATED-TASK-WORKER can inspect them via read_file.
 */
async function downloadWorkItemAttachments({
  workItemId,
  projectFileIds,
  imageUrls,
  backendUrl,
  projectToken,
}) {
  const downloadedPaths = [];
  if ((!projectFileIds || !projectFileIds.length) && (!imageUrls || !imageUrls.length)) {
    return downloadedPaths;
  }

  const taskDir = path.join(TASK_ATTACHMENTS_DIR, String(workItemId));
  fs.mkdirSync(taskDir, { recursive: true });

  // 1. Download ProjectFiles via /project-files/:id + /project-files/get-file-content/:id
  for (const fileId of projectFileIds || []) {
    try {
      let fileName = `project-file-${fileId}`;
      const metaRes = await fetchWithRetry(`${backendUrl}/project-files/${encodeURIComponent(fileId)}`, {
        headers: { Authorization: projectToken },
      });
      if (metaRes.ok) {
        const meta = await metaRes.json().catch(() => ({}));
        if (meta && meta.name) {
          fileName = path.basename(String(meta.name)).replace(/[^a-zA-Z0-9._-]/g, '_');
        }
      }

      const contentRes = await fetchWithRetry(
        `${backendUrl}/project-files/get-file-content/${encodeURIComponent(fileId)}`,
        { headers: { Authorization: projectToken } }
      );
      if (contentRes.ok) {
        const buf = Buffer.from(await contentRes.arrayBuffer());
        if (buf.length > 0) {
          const dest = path.join(taskDir, fileName);
          fs.writeFileSync(dest, buf);
          downloadedPaths.push(dest);
        }
      }
    } catch (err) {
      console.warn(`[FetchTasks] Warning: could not download ProjectFile ${fileId}: ${err.message}`);
    }
  }

  // 2. Download S3 / DigitalOcean Spaces picture URLs
  for (let i = 0; i < (imageUrls || []).length; i++) {
    const rawUrl = imageUrls[i];
    let ext = '.png';
    try {
      const parsed = new URL(rawUrl.replace(/^s3:\/\//, 'https://'));
      const m = path.basename(parsed.pathname).match(/\.(png|jpe?g|webp|gif|svg|pdf|csv|md)$/i);
      if (m) ext = '.' + m[1].toLowerCase();
    } catch (_) {}

    const dest = path.join(taskDir, `task-image-${i + 1}${ext}`);
    let ok = false;

    if (/^https?:\/\//i.test(rawUrl)) {
      try {
        const res = await fetchWithRetry(rawUrl);
        if (res.ok) {
          const buf = Buffer.from(await res.arrayBuffer());
          if (buf.length > 0) {
            fs.writeFileSync(dest, buf);
            ok = true;
          }
        }
      } catch (_) {}
    }

    if (!ok) {
      try {
        let s3Uri = rawUrl.startsWith('s3://') ? rawUrl : null;
        if (!s3Uri) {
          const parsed = new URL(rawUrl);
          const cleanKey = parsed.pathname.replace(/^\/+/, '');
          if (parsed.hostname.startsWith('rapider.')) {
            s3Uri = `s3://rapider/${cleanKey}`;
          }
        }
        if (s3Uri) {
          const spaces = loadSpacesCredentialsFromEnv();
          const env = { ...process.env };
          if (spaces.accessKeyId && spaces.secretAccessKey) {
            env.AWS_ACCESS_KEY_ID = spaces.accessKeyId;
            env.AWS_SECRET_ACCESS_KEY = spaces.secretAccessKey;
          }
          execFileSync('aws', ['s3', 'cp', s3Uri, dest, `--endpoint-url=${spaces.endpointUrl}`], {
            env,
            stdio: 'ignore',
          });
          if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
            ok = true;
          }
        }
      } catch (_) {}
    }

    if (ok) downloadedPaths.push(dest);
  }

  return downloadedPaths;
}

/**
 * Claims a WorkItem (`status: 'running'`, `needsAttention: false`, `revision + 1`) and appends
 * a `task_started` WorkItemEvent.
 */
async function claimWorkItemTask(workItemId, projectIdHint = null) {
  const { token: baseToken, creds } = await authenticateBase();
  let targetProjectId = projectIdHint;

  if (!targetProjectId && fs.existsSync(TASKS_QUEUE_FILE)) {
    try {
      const q = JSON.parse(fs.readFileSync(TASKS_QUEUE_FILE, 'utf8'));
      const hit = (q.tasks || []).find((t) => t.id === workItemId);
      if (hit && hit.projectId) targetProjectId = hit.projectId;
    } catch (_) {}
  }

  let projectToken = null;
  let existing = null;

  if (targetProjectId) {
    projectToken = await switchActiveProject(creds, baseToken, targetProjectId);
    const getRes = await fetchWithRetry(`${creds.backendUrl}/work-items/${encodeURIComponent(workItemId)}`, {
      headers: { Authorization: projectToken },
    });
    if (getRes.ok) existing = await getRes.json();
  } else {
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
        existing = await getRes.json();
        targetProjectId = p.id;
        projectToken = pTok;
        break;
      }
    }
  }

  if (!existing || !projectToken) {
    throw new Error(`Could not locate WorkItem ${workItemId} across accessible Workspaces.`);
  }

  const nextRevision = (typeof existing.revision === 'number' ? existing.revision : 1) + 1;
  const patchRes = await fetchWithRetry(`${creds.backendUrl}/work-items/${encodeURIComponent(workItemId)}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Authorization: projectToken,
    },
    body: JSON.stringify({
      status: 'running',
      needsAttention: false,
      revision: nextRevision,
    }),
  });

  if (!patchRes.ok) {
    const errText = await patchRes.text().catch(() => '');
    throw new Error(`Failed to claim WorkItem ${workItemId} (HTTP ${patchRes.status}): ${errText}`);
  }

  // Append task_started event
  const evFilter = encodeURIComponent(
    JSON.stringify({ where: { workItemId }, order: ['sequence DESC'], limit: 1 })
  );
  const lastEvRes = await fetchWithRetry(`${creds.backendUrl}/work-item-events?filter=${evFilter}`, {
    headers: { Authorization: projectToken },
  });
  const lastEvList = await lastEvRes.json().catch(() => []);
  const nextSeq =
    Array.isArray(lastEvList) && lastEvList[0] && typeof lastEvList[0].sequence === 'number'
      ? lastEvList[0].sequence + 1
      : 1;

  await fetchWithRetry(`${creds.backendUrl}/work-item-events`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: projectToken,
    },
    body: JSON.stringify({
      workItemId,
      sequence: nextSeq,
      eventType: 'task_started',
      actor: 'task-worker',
      data: {
        status: 'running',
        startedAt: new Date().toISOString(),
      },
    }),
  }).catch(() => {});

  console.log(`[Claim] WorkItem ${workItemId} (Workspace ${targetProjectId}) -> status='running' (revision ${nextRevision})`);
  return { id: workItemId, projectId: targetProjectId, revision: nextRevision };
}

/**
 * Main batch-of-5 ingestion entrypoint.
 */
async function fetchAndValidateTasks(options = {}) {
  const limit = options.limit || DEFAULT_BATCH_LIMIT;
  const eligibleStatuses = options.eligibleStatuses || DEFAULT_ELIGIBLE_STATUSES;
  const recoverStale = Boolean(options.recoverStale);
  const projectFilter = options.projectFilter || null;
  const showAll = Boolean(options.showAll);

  console.log('===============================================================');
  console.log('   RAPIDER ISOLATED TASK WORKER — FIFO BATCH-OF-5 INGESTION    ');
  console.log('===============================================================');
  console.log(
    `Filter: kind="task", status in [${eligibleStatuses.join(', ')}]${recoverStale ? ' (+ stale running)' : ''}, order=oldest-first, limit=${limit}`
  );

  const { token: baseToken, creds } = await authenticateBase();

  const projRes = await fetchWithRetry(`${creds.backendUrl}/projects`, {
    headers: { Authorization: baseToken },
  });
  const rawProjects = await projRes.json().catch(() => []);
  let projects = Array.isArray(rawProjects) ? rawProjects : [];

  if (projectFilter) {
    projects = projects.filter(
      (p) =>
        p.id === projectFilter ||
        (p.name && p.name.toLowerCase().includes(String(projectFilter).toLowerCase()))
    );
  }

  console.log(`[Workspaces] Scanning ${projects.length} accessible Workspace(s)...`);

  const projectTokens = new Map();
  const projectNames = new Map();
  const candidateItems = [];

  const queryStatuses = showAll
    ? undefined
    : recoverStale
      ? Array.from(new Set([...eligibleStatuses, 'running']))
      : eligibleStatuses;

  for (const proj of projects) {
    if (!proj || !proj.id) continue;
    projectNames.set(proj.id, proj.name || proj.id);

    let pToken;
    try {
      pToken = await switchActiveProject(creds, baseToken, proj.id);
      projectTokens.set(proj.id, pToken);
    } catch (_) {
      continue;
    }

    const where = {
      kind: 'task',
      isDeleted: { neq: true },
      ...(queryStatuses ? { status: { inq: queryStatuses } } : {}),
    };
    const filterObj = {
      where,
      order: ['occurredAt ASC', 'createdDate ASC'],
      limit: showAll ? 50 : Math.max(limit * 2, 10),
    };

    const wiRes = await fetchWithRetry(
      `${creds.backendUrl}/work-items?filter=${encodeURIComponent(JSON.stringify(filterObj))}`,
      { headers: { Authorization: pToken } }
    );
    if (!wiRes.ok) continue;

    const items = await wiRes.json().catch(() => []);
    if (Array.isArray(items)) {
      for (const item of items) {
        candidateItems.push({
          ...item,
          projectId: item.projectId || proj.id,
        });
      }
    }
  }

  if (showAll) {
    console.log(`\n[Diagnostics] Found ${candidateItems.length} WorkItem(s) of kind="task" across scanned Workspaces:`);
    for (const it of candidateItems) {
      console.log(
        `  - [${it.status || 'open'}] ${it.id} | Workspace: ${projectNames.get(it.projectId)} (${it.projectId}) | "${it.title}" (${it.occurredAt || it.createdDate})`
      );
    }
  }

  const { selected, totalEligible } = selectOldestOpenTaskWorkItemsPure(candidateItems, {
    limit,
    eligibleStatuses,
    recoverStaleRunning: recoverStale,
  });

  const enrichedTasks = [];
  for (const wi of selected) {
    const pToken = projectTokens.get(wi.projectId);
    let eventsThread = [];
    if (pToken) {
      const evFilter = encodeURIComponent(
        JSON.stringify({
          where: { workItemId: wi.id },
          order: ['sequence ASC', 'createdDate ASC'],
        })
      );
      const evRes = await fetchWithRetry(`${creds.backendUrl}/work-item-events?filter=${evFilter}`, {
        headers: { Authorization: pToken },
      });
      if (evRes.ok) {
        const rawEvents = await evRes.json().catch(() => []);
        if (Array.isArray(rawEvents)) {
          eventsThread = rawEvents.map((ev) => ({
            id: ev.id,
            sequence: ev.sequence,
            eventType: ev.eventType,
            actor: ev.actor || null,
            createdDate: ev.createdDate || null,
            data: ev.data || {},
          }));
        }
      }
    }

    const exactUserRequest = extractExactUserRequest(wi);
    const attachmentFileIds = extractAttachedProjectFileIds(wi);
    const imageUrls = extractWorkItemImageUrls(wi, eventsThread);

    const localAttachmentPaths = pToken
      ? await downloadWorkItemAttachments({
          workItemId: wi.id,
          projectFileIds: attachmentFileIds,
          imageUrls,
          backendUrl: creds.backendUrl,
          projectToken: pToken,
        })
      : [];

    const combinedText = [
      wi.title,
      wi.summary,
      wi.bodyMarkdown,
      exactUserRequest,
      ...eventsThread.map((e) =>
        typeof e.data === 'string'
          ? e.data
          : e.data?.messageMarkdown || e.data?.content || e.data?.comment || ''
      ),
    ]
      .filter(Boolean)
      .join('\n\n');

    const securityValidation = validateTaskSecurity(combinedText);
    const scopeCandidate = evaluateWorkspaceRelevanceHeuristic(combinedText);

    enrichedTasks.push({
      id: wi.id,
      projectId: wi.projectId,
      workspaceName: projectNames.get(wi.projectId) || wi.projectId,
      ownerPersonId: wi.ownerPersonId || null,
      kind: 'task',
      status: wi.status || 'open',
      needsAttention: Boolean(wi.needsAttention),
      revision: typeof wi.revision === 'number' ? wi.revision : 1,
      priority: wi.priority ?? 2,
      occurredAt: wi.occurredAt || wi.createdDate || new Date().toISOString(),
      createdDate: wi.createdDate || null,
      title: wi.title || 'Workspace Task',
      summary: wi.summary || '',
      bodyMarkdown: wi.bodyMarkdown || '',
      exactUserRequest,
      source: wi.source || {},
      facts: Array.isArray(wi.facts) ? wi.facts : [],
      contextRefs: Array.isArray(wi.contextRefs) ? wi.contextRefs : [],
      attachmentFileIds,
      imageUrls,
      localAttachmentPaths,
      requiresAttachmentInspection: attachmentFileIds.length > 0 || imageUrls.length > 0,
      eventsThread,
      securityValidation,
      scopeCandidate,
    });
  }

  const remainingAfterThisBatch = Math.max(0, totalEligible - enrichedTasks.length);
  const queuePayload = {
    fetchedAt: new Date().toISOString(),
    filter: {
      kind: 'task',
      eligibleStatuses,
      order: ['occurredAt ASC', 'createdDate ASC'],
      limit,
    },
    batchSize: enrichedTasks.length,
    totalEligibleAcrossWorkspaces: totalEligible,
    remainingAfterThisBatch,
    tasks: enrichedTasks,
  };

  fs.writeFileSync(TASKS_QUEUE_FILE, JSON.stringify(queuePayload, null, 2), 'utf8');

  console.log(
    `\n[Queue] Wrote ${enrichedTasks.length} oldest open task(s) to tasks-queue.json (${remainingAfterThisBatch} additional open task(s) waiting for next batch of ${limit}).`
  );
  for (let i = 0; i < enrichedTasks.length; i++) {
    const t = enrichedTasks[i];
    const secTag = t.securityValidation.safe ? 'SAFE' : `GUARDRAIL_FLAG(${t.securityValidation.reason})`;
    const attTag = t.requiresAttachmentInspection
      ? ` | ATTACHMENTS(${t.localAttachmentPaths.length} downloaded)`
      : '';
    console.log(
      `  ${i + 1}. [${t.status}] ${t.id} | Workspace: ${t.workspaceName} (${t.projectId}) | ${t.occurredAt} | ${secTag}${attTag}\n     Title: "${t.title}"`
    );
  }

  return queuePayload;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const getArg = (name) => {
    const prefix = `--${name}=`;
    const hit = args.find((a) => a.startsWith(prefix));
    return hit ? hit.slice(prefix.length) : null;
  };
  const hasFlag = (flag) => args.includes(`--${flag}`);

  const claimId = getArg('claim');
  const projectHint = getArg('project');

  if (claimId) {
    claimWorkItemTask(claimId, projectHint).catch((err) => {
      console.error(`[Claim] Error: ${err.message}`);
      process.exit(1);
    });
  } else {
    const limitVal = parseInt(getArg('limit') || String(DEFAULT_BATCH_LIMIT), 10) || DEFAULT_BATCH_LIMIT;
    const statusArg = getArg('status');
    const eligibleStatuses = statusArg
      ? statusArg.split(',').map((s) => s.trim()).filter(Boolean)
      : DEFAULT_ELIGIBLE_STATUSES;

    fetchAndValidateTasks({
      limit: limitVal,
      eligibleStatuses,
      recoverStale: hasFlag('recover-stale'),
      projectFilter: projectHint,
      showAll: hasFlag('all'),
    }).catch((err) => {
      console.error(`[FetchTasks] Fatal error: ${err.message}`);
      process.exit(1);
    });
  }
}

module.exports = {
  selectOldestOpenTaskWorkItemsPure,
  extractExactUserRequest,
  extractWorkItemImageUrls,
  extractAttachedProjectFileIds,
  downloadWorkItemAttachments,
  claimWorkItemTask,
  fetchAndValidateTasks,
  TASKS_QUEUE_FILE,
};
