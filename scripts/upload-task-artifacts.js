#!/usr/bin/env node

/**
 * upload-task-artifacts.js
 *
 * Uploads one or more generated task deliverables (.md, .pdf, .csv, .hbs, .json, .html)
 * to the target Workspace's ProjectFile storage (`POST /project-files/upload-files/{folderId}`)
 * under the Workspace's "Task Outputs" folder, returning normalized `WorkItem.contextRefs`
 * entries ready to attach to the WorkItem and WorkItemEvent.
 *
 * Usage:
 *   node scripts/upload-task-artifacts.js --project=<projectId> --id=<workItemId> --file=_artifacts/<id>/report.pdf
 */

const fs = require('fs');
const path = require('path');
const {
  authenticateBase,
  switchActiveProject,
  fetchWithRetry,
} = require('./rapider-api-auth');

const MIME_BY_EXT = {
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.pdf': 'application/pdf',
  '.hbs': 'text/x-handlebars-template',
  '.handlebars': 'text/x-handlebars-template',
  '.html': 'text/html',
  '.json': 'application/json',
  '.txt': 'text/plain',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
};

function guessMimeType(filePath) {
  const ext = path.extname(String(filePath || '')).toLowerCase();
  return MIME_BY_EXT[ext] || 'application/octet-stream';
}

/**
 * Resolves or creates a `"Task Outputs"` ProjectFolder in the target Workspace.
 */
async function ensureWorkspaceTaskOutputsFolder(backendUrl, projectToken, folderName = 'Task Outputs') {
  const listRes = await fetchWithRetry(`${backendUrl}/project-folders`, {
    headers: { Authorization: projectToken },
  });
  if (!listRes.ok) {
    throw new Error(`Unable to list Workspace ProjectFolders (HTTP ${listRes.status}).`);
  }
  const folders = await listRes.json().catch(() => []);
  const folderList = Array.isArray(folders) ? folders : [];

  const existingTarget = folderList.find(
    (f) => f && !f.isDeleted && String(f.name || '').toLowerCase() === folderName.toLowerCase()
  );
  if (existingTarget && existingTarget.id) {
    return existingTarget;
  }

  // Locate root folder (no parentFolderId, or '/' / first available folder)
  const rootFolder =
    folderList.find((f) => f && !f.parentFolderId) ||
    folderList.find((f) => f && (f.name === '/' || f.name === 'root')) ||
    folderList[0];

  if (!rootFolder || !rootFolder.id) {
    throw new Error('Workspace has no root ProjectFolder available for uploading artifacts.');
  }

  // Attempt to create "Task Outputs" child folder; fall back to rootFolder if restricted
  try {
    const createRes = await fetchWithRetry(`${backendUrl}/project-folders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: projectToken,
      },
      body: JSON.stringify({
        name: folderName,
        parentFolderId: rootFolder.id,
        isPublic: false,
      }),
    });
    if (createRes.ok) {
      const created = await createRes.json().catch(() => null);
      if (created && created.id) return created;
    }
  } catch (_) {}

  return rootFolder;
}

/**
 * Uploads local artifact files to Workspace ProjectFile storage and returns
 * normalized contextRef descriptors.
 *
 * @param {{
 *   projectId: string,
 *   workItemId?: string,
 *   filePaths: string[],
 *   folderName?: string
 * }} params
 * @returns {Promise<Array<{ type: 'projectFile', id: string, name: string, mimeType: string, path: string, size?: number }>>}
 */
async function uploadTaskArtifacts({ projectId, workItemId = '', filePaths = [], folderName = 'Task Outputs' }) {
  if (!projectId) throw new Error('uploadTaskArtifacts requires projectId.');
  const validFiles = (filePaths || []).map((p) => path.resolve(p));
  for (const fp of validFiles) {
    if (!fs.existsSync(fp) || !fs.statSync(fp).isFile()) {
      throw new Error(`Artifact file does not exist: ${fp}`);
    }
  }
  if (validFiles.length === 0) return [];

  const { token: baseToken, creds } = await authenticateBase();
  const projectToken = await switchActiveProject(creds, baseToken, projectId);
  const targetFolder = await ensureWorkspaceTaskOutputsFolder(creds.backendUrl, projectToken, folderName);

  const form = new FormData();
  const titles = [];
  const metadata = [];

  for (const fp of validFiles) {
    const fileName = path.basename(fp);
    const mimeType = guessMimeType(fp);
    const buf = fs.readFileSync(fp);
    form.append('files', new Blob([buf], { type: mimeType }), fileName);
    titles.push(fileName);
    metadata.push(
      workItemId
        ? [
            { key: 'workItemId', value: String(workItemId) },
            { key: 'generatedBy', value: 'task-worker' },
          ]
        : [{ key: 'generatedBy', value: 'task-worker' }]
    );
  }

  form.append('content', JSON.stringify({ titles, metadata }));

  const uploadRes = await fetchWithRetry(
    `${creds.backendUrl}/project-files/upload-files/${encodeURIComponent(targetFolder.id)}`,
    {
      method: 'POST',
      headers: {
        Authorization: projectToken,
      },
      body: form,
    }
  );

  if (!uploadRes.ok) {
    const errText = await uploadRes.text().catch(() => '');
    throw new Error(`Failed to upload task artifacts (HTTP ${uploadRes.status}): ${errText}`);
  }

  const uploaded = await uploadRes.json().catch(() => []);
  const uploadedArr = Array.isArray(uploaded) ? uploaded : [uploaded].filter(Boolean);

  return uploadedArr.map((pf, idx) => {
    const fallbackName = path.basename(validFiles[idx] || 'artifact');
    return {
      type: 'projectFile',
      id: pf.id,
      name: pf.name || pf.title || fallbackName,
      mimeType: pf.type || guessMimeType(validFiles[idx] || ''),
      path: `/${targetFolder.name || 'Task Outputs'}/${pf.name || fallbackName}`,
      ...(typeof pf.size === 'number' ? { size: pf.size } : {}),
    };
  });
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const getArg = (name) => {
    const prefix = `--${name}=`;
    const hit = args.find((a) => a.startsWith(prefix));
    return hit ? hit.slice(prefix.length) : null;
  };

  const projectId = getArg('project');
  const workItemId = getArg('id') || getArg('workItemId') || '';
  const filesRaw = getArg('files') || getArg('file') || '';
  const filePaths = filesRaw.split(',').map((s) => s.trim()).filter(Boolean);

  if (!projectId || filePaths.length === 0) {
    console.error('Usage: node scripts/upload-task-artifacts.js --project=<projectId> [--id=<workItemId>] --file=<path1[,path2]>');
    process.exit(1);
  }

  uploadTaskArtifacts({ projectId, workItemId, filePaths })
    .then((refs) => {
      console.log(`[Artifacts] Uploaded ${refs.length} artifact(s) to Workspace ${projectId}:`);
      console.log(JSON.stringify(refs, null, 2));
    })
    .catch((err) => {
      console.error(`[Artifacts] Error: ${err.message}`);
      process.exit(1);
    });
}

module.exports = {
  guessMimeType,
  ensureWorkspaceTaskOutputsFolder,
  uploadTaskArtifacts,
};
