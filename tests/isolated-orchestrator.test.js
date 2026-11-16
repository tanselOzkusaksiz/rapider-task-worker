const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const {
  ensureGitRepoAndIdleBranch,
  parkWorkspaceRepo,
} = require('../scripts/manage-workspace-repos');
const { ScopedTaskProxyServer } = require('../scripts/scoped-task-proxy');
const { stageTaskSandbox } = require('../scripts/stage-task-sandbox');
const { runInOsSandbox } = require('../scripts/sandbox-runner');
const { harvestSandboxResults } = require('../scripts/harvest-repo-changes');
const { IsolatedTaskOrchestrator } = require('../scripts/isolated-task-orchestrator');
const { createManagementUiServer } = require('../management-ui/server');

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function createMockParkedAppRepo(appsRoot, folderName, appKey, filesMap, secretHistoryNote) {
  const repoDir = path.join(appsRoot, folderName);
  fs.mkdirSync(repoDir, { recursive: true });
  git(repoDir, ['init', '-b', 'main']);
  git(repoDir, ['config', 'user.name', 'Test Builder']);
  git(repoDir, ['config', 'user.email', 'builder@rapider.local']);

  // Commit 1 (historical commit that must NOT leak into sandbox git log!)
  fs.writeFileSync(path.join(repoDir, 'HISTORICAL_NOTE.txt'), secretHistoryNote, 'utf8');
  git(repoDir, ['add', '-A']);
  git(repoDir, ['commit', '--no-gpg-sign', '-m', 'chore: early secret prototype']);

  // Commit 2 (current main state; remove historical note, write app files)
  fs.unlinkSync(path.join(repoDir, 'HISTORICAL_NOTE.txt'));
  fs.writeFileSync(
    path.join(repoDir, 'app.manifest.json'),
    JSON.stringify({ appKey, appName: folderName }, null, 2),
    'utf8'
  );
  for (const [rel, content] of Object.entries(filesMap)) {
    const dest = path.join(repoDir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, content, 'utf8');
  }
  git(repoDir, ['add', '-A']);
  git(repoDir, ['commit', '--no-gpg-sign', '-m', 'feat: release main']);

  // Add a fake remote and park onto orphan `idle` branch
  git(repoDir, ['remote', 'add', 'origin', `https://example.invalid/${folderName}.git`]);
  ensureGitRepoAndIdleBranch(repoDir, folderName, folderName);
  git(repoDir, ['checkout', '-f', 'idle']);
  git(repoDir, ['clean', '-fd']);
  return repoDir;
}

test('Isolated Multi-Repo Stager, OS Jail Blindness, Scoped Proxy & Diff Harvester', async (t) => {
  const tmpBase = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'rapider-orch-e2e-'))
  );
  t.after(() => {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  });

  const workspacesRoot = path.join(tmpBase, 'WORKSPACES');
  const appsCloneRoot = path.join(tmpBase, 'APPS');
  const bareCacheRoot = path.join(tmpBase, '_repo-cache');
  const sandboxesRoot = path.join(tmpBase, '_sandboxes');
  const fakeEnvPath = path.join(tmpBase, '.server.env');
  fs.writeFileSync(fakeEnvPath, 'SUPER_SECRET_DB_URI=mongodb://secret\n', 'utf8');

  // 1. Create two Workspace master repos & park both on `idle`
  const ws1Dir = path.join(workspacesRoot, 'proj-alpha');
  ensureGitRepoAndIdleBranch(ws1Dir, 'proj-alpha', 'Alpha Workspace');
  git(ws1Dir, ['checkout', '-f', 'main']);
  fs.mkdirSync(path.join(ws1Dir, 'models'), { recursive: true });
  fs.writeFileSync(
    path.join(ws1Dir, 'WORKSPACE_CONTEXT.md'),
    '# Alpha Workspace Context\n- Table: `opportunities`\n',
    'utf8'
  );
  fs.writeFileSync(
    path.join(ws1Dir, 'models/project-models.json'),
    JSON.stringify([{ name: 'Opportunity', dataTableName: 'opportunities' }], null, 2),
    'utf8'
  );
  git(ws1Dir, ['add', '-A']);
  git(ws1Dir, ['commit', '--no-gpg-sign', '-m', 'chore: alpha snapshot']);
  parkWorkspaceRepo('proj-alpha', { workspacesRoot });

  const ws2Dir = path.join(workspacesRoot, 'proj-other-secret');
  ensureGitRepoAndIdleBranch(ws2Dir, 'proj-other-secret', 'Other Secret Workspace');
  git(ws2Dir, ['checkout', '-f', 'main']);
  fs.writeFileSync(path.join(ws2Dir, 'TOP_SECRET.md'), 'CROSS TENANT DATA\n', 'utf8');
  git(ws2Dir, ['add', '-A']);
  git(ws2Dir, ['commit', '--no-gpg-sign', '-m', 'chore: other snapshot']);
  parkWorkspaceRepo('proj-other-secret', { workspacesRoot });

  // 2. Create two App master repos parked on `idle` (only `crm` belongs to proj-alpha!)
  const crmRepoDir = createMockParkedAppRepo(
    appsCloneRoot,
    'rapider-app-crm',
    'crm',
    {
      'AGENTS.md': '# CRM App Rules\nAlways preserve pipeline stage keys.\n',
      'README.md': '# Rapider CRM\n',
      'docs/guide.md': '# CRM Guide\n',
    },
    'OLD_COMMIT_SECRET_999'
  );
  const secretHrRepoDir = createMockParkedAppRepo(
    appsCloneRoot,
    'rapider-app-secret-payroll',
    'secret-payroll',
    { 'README.md': '# Confidential Payroll App\n' },
    'PAYROLL_SECRET'
  );

  // 3. Stage task sandbox for `proj-alpha` (offline=true uses local snapshot)
  const manifest = await stageTaskSandbox({
    workItem: {
      id: 'wi-alpha-101',
      projectId: 'proj-alpha',
      title: 'Generate 12-Month CRM Opportunity Forecast & Update CRM Docs',
      bodyMarkdown: 'List won and pipeline opportunities and update CRM README.',
    },
    runId: 'run-0001',
    workspaceBootstrap: {
      workspaceName: 'Alpha Workspace',
      installedAppKeys: ['crm'],
    },
    sandboxesRoot,
    workspacesRoot,
    appsCloneRoot,
    bareCacheRoot,
    offline: true,
  });

  // Verify ALL master repos remain untouched on disk and parked on `idle`!
  assert.equal(git(ws1Dir, ['rev-parse', '--abbrev-ref', 'HEAD']), 'idle');
  assert.equal(git(ws2Dir, ['rev-parse', '--abbrev-ref', 'HEAD']), 'idle');
  assert.equal(git(crmRepoDir, ['rev-parse', '--abbrev-ref', 'HEAD']), 'idle');
  assert.equal(git(secretHrRepoDir, ['rev-parse', '--abbrev-ref', 'HEAD']), 'idle');

  // Verify ONLY `crm` was mounted in `apps/`, and `secret-payroll` does NOT exist
  assert.equal(fs.existsSync(path.join(manifest.workspaceDir, 'apps/crm/README.md')), true);
  assert.equal(fs.existsSync(path.join(manifest.workspaceDir, 'apps/secret-payroll')), false);

  // Verify staged `apps/crm` has 1 commit (`ORCH_BASELINE`), 0 remotes, no `idle` branch, no old commit history
  const stagedCrmDir = path.join(manifest.workspaceDir, 'apps/crm');
  assert.equal(git(stagedCrmDir, ['remote']), '');
  assert.equal(git(stagedCrmDir, ['rev-list', '--count', 'HEAD']), '1');
  assert.equal(git(stagedCrmDir, ['branch', '-a']).trim(), '* main');

  // Verify 4-layer rules, skills, hooks, and Mounted Repo Docs Index in TASK_BRIEF.md
  const agentsMd = fs.readFileSync(path.join(manifest.workspaceDir, 'AGENTS.md'), 'utf8');
  assert.ok(Buffer.byteLength(agentsMd, 'utf8') < 24000, 'AGENTS.md must stay under 24KB cap');
  const briefMd = fs.readFileSync(path.join(manifest.workspaceDir, 'TASK_BRIEF.md'), 'utf8');
  assert.match(briefMd, /apps\/crm\/AGENTS\.md/);
  assert.match(briefMd, /apps\/crm\/docs\/guide\.md/);
  assert.equal(
    fs.existsSync(path.join(manifest.workspaceDir, '.agents/skills/complex-data-reporting/SKILL.md')),
    true
  );
  assert.equal(fs.existsSync(path.join(manifest.workspaceDir, '.agents/hooks.json')), true);

  // 4. Start ScopedTaskProxyServer and verify OS Jail (`sandbox-exec` on macOS)
  const proxy = new ScopedTaskProxyServer({
    customUpstreamFetch: async (projectId, endpointPath) => {
      assert.equal(projectId, 'proj-alpha');
      if (endpointPath.startsWith('/project-data-manager/opportunities')) {
        return {
          ok: true,
          status: 200,
          data: [
            { id: 'opp-1', name: 'Enterprise Renewal', stage: 'WON', amount: 120000 },
            { id: 'opp-2', name: 'Q4 Expansion', stage: 'PROPOSAL', amount: 80000 },
          ],
        };
      }
      return { ok: true, status: 200, data: [] };
    },
  });
  const proxyUrl = await proxy.start();
  t.after(() => proxy.stop());

  const lease = proxy.registerTaskLease({
    workItemId: 'wi-alpha-101',
    projectId: 'proj-alpha',
    workspaceName: 'Alpha Workspace',
    allowedTables: manifest.allowedTables,
  });

  // Verify cross-table & admin endpoints are blocked by proxy
  const blockedAdminRes = await fetch(`${proxyUrl}/task-proxy/workspace-api`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Task-Nonce': lease.nonce },
    body: JSON.stringify({ method: 'GET', path: '/admin/task-orchestrator/overview' }),
  });
  assert.equal(blockedAdminRes.status, 403);

  const blockedTableRes = await fetch(`${proxyUrl}/task-proxy/data/secret_salaries`, {
    headers: { 'X-Task-Nonce': lease.nonce },
  });
  assert.equal(blockedTableRes.status, 403);

  // Write a simulated worker task script inside `<sandbox>/workspace/run-check.js`
  const checkScriptPath = path.join(manifest.workspaceDir, 'run-check.js');
  fs.writeFileSync(
    checkScriptPath,
    [
      "const fs = require('fs');",
      "const path = require('path');",
      "const { execFileSync } = require('child_process');",
      'const results = { blockedOtherWs: false, blockedSecretApp: false, blockedEnv: false, blockedReadOnlyTools: false };',
      `try { fs.readdirSync(${JSON.stringify(ws2Dir)}); } catch (e) { results.blockedOtherWs = true; }`,
      `try { fs.readdirSync(${JSON.stringify(secretHrRepoDir)}); } catch (e) { results.blockedSecretApp = true; }`,
      `try { fs.readFileSync(${JSON.stringify(fakeEnvPath)}, 'utf8'); } catch (e) { results.blockedEnv = true; }`,
      "try { fs.writeFileSync(path.resolve('../tools/rapider-task-cli.js'), 'hacked'); } catch (e) { results.blockedReadOnlyTools = true; }",
      "execFileSync(process.execPath, ['../tools/rapider-task-cli.js', 'query-data', '--table=opportunities', '--out=../output/opps.json'], { stdio: 'inherit' });",
      "execFileSync(process.execPath, ['../tools/rapider-task-cli.js', 'export-csv', '--in=../output/opps.json', '--out=../output/deliverables/forecast.csv'], { stdio: 'inherit' });",
      "fs.appendFileSync('apps/crm/README.md', '\\n## Forecast Integration Enabled\\n', 'utf8');",
      "fs.unlinkSync('run-check.js');",
      "fs.writeFileSync('../output/task-outcome.json', JSON.stringify({",
      "  status: 'resolved',",
      "  taskCategory: 'reporting',",
      "  outcomeSummary: 'Generated 12-month forecast CSV and updated CRM documentation.',",
      "  publicReplyMarkdown: 'Analyzed **2** opportunities totaling **$200,000** and attached forecast.csv.',",
      "  deliverableFiles: ['forecast.csv'],",
      '  jailAssertions: results',
      '}, null, 2));',
      "console.log(JSON.stringify({ type: 'STEP_COMPLETE', conversationId: 'conv-sandbox-1', results }));",
    ].join('\n'),
    'utf8'
  );

  const execRes = await runInOsSandbox({
    manifest,
    proxyUrl: lease.proxyUrl,
    taskNonce: lease.nonce,
    commandSpec: {
      command: process.execPath,
      args: [checkScriptPath],
    },
    sandboxesRoot,
    workspacesRoot,
    appsCloneRoot,
    bareCacheRoot,
    protectedPaths: [tmpBase],
  });

  assert.equal(execRes.exitCode, 0, execRes.logTail);
  assert.equal(execRes.conversationId, 'conv-sandbox-1');

  // 5. Harvest results & verify OS jail blocked every unauthorized read/write!
  const harvested = harvestSandboxResults(manifest, {
    createHostBranches: true,
    pushRemoteBranches: false,
  });

  assert.equal(harvested.outcome.status, 'resolved');
  if (process.platform === 'darwin') {
    assert.deepEqual(harvested.outcome.jailAssertions, {
      blockedOtherWs: true,
      blockedSecretApp: true,
      blockedEnv: true,
      blockedReadOnlyTools: true,
    });
  }

  assert.equal(harvested.deliverables.length, 1);
  assert.equal(harvested.deliverables[0].fileName, 'forecast.csv');
  assert.equal(harvested.harvestedPatches.length, 1);
  assert.equal(harvested.pushedBranches.length, 1);
  assert.ok(harvested.pushedBranches[0].branch.startsWith('ai/task-'));

  // Master CRM repo MUST STILL be parked on `idle` even after branch harvesting!
  assert.equal(git(crmRepoDir, ['rev-parse', '--abbrev-ref', 'HEAD']), 'idle');
});

test('Stop Hook (`on-stop-verify.js`) blocks confidential path leaks and missing deliverables', () => {
  const tmpSandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'rapider-hook-test-'));
  const wsDir = path.join(tmpSandbox, 'workspace');
  const outDir = path.join(tmpSandbox, 'output');
  const delivDir = path.join(outDir, 'deliverables');
  fs.mkdirSync(wsDir, { recursive: true });
  fs.mkdirSync(delivDir, { recursive: true });

  const hookScript = path.resolve(
    __dirname,
    '../scripts/sandbox-tools/hooks/on-stop-verify.js'
  );

  // Case 1: Leaked host path `/Users/alice/...` -> must return decision="continue"
  fs.writeFileSync(
    path.join(outDir, 'task-outcome.json'),
    JSON.stringify({
      status: 'resolved',
      outcomeSummary: 'Saved at /Users/alice/secret/report.csv',
      publicReplyMarkdown: 'Done!',
      deliverableFiles: [],
    }),
    'utf8'
  );

  const run1 = spawnSync(process.execPath, [hookScript], {
    cwd: wsDir,
    input: JSON.stringify({
      terminationReason: 'NO_TOOL_CALL',
      continuationActive: false,
      cwd: wsDir,
    }),
    encoding: 'utf8',
  });
  const parsed1 = JSON.parse(run1.stdout);
  assert.equal(parsed1.decision, 'continue');
  assert.match(parsed1.reason, /confidentiality violation/i);

  // Case 2: Clean public reply + existing deliverable -> decision="allow"
  fs.writeFileSync(path.join(delivDir, 'summary.md'), '# Clean Summary\n', 'utf8');
  fs.writeFileSync(
    path.join(outDir, 'task-outcome.json'),
    JSON.stringify({
      status: 'resolved',
      outcomeSummary: 'Generated executive summary.',
      publicReplyMarkdown: 'Attached `summary.md` with your requested figures.',
      deliverableFiles: ['summary.md'],
    }),
    'utf8'
  );

  const run2 = spawnSync(process.execPath, [hookScript], {
    cwd: wsDir,
    input: JSON.stringify({
      terminationReason: 'NO_TOOL_CALL',
      continuationActive: false,
      cwd: wsDir,
    }),
    encoding: 'utf8',
  });
  const parsed2 = JSON.parse(run2.stdout);
  assert.equal(parsed2.decision, 'allow');

  fs.rmSync(tmpSandbox, { recursive: true, force: true });
});

test('IsolatedTaskOrchestrator dynamic concurrency & Management UI server gateway', async (t) => {
  const tmpDir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'rapider-orch-daemon-'))
  );
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const updatedRuns = [];
  const uploadedLogs = [];
  let claimedOnce = false;

  const orch = new IsolatedTaskOrchestrator({
    workerId: 'test-mac-worker',
    once: true,
    offline: true,
    sandboxesRoot: path.join(tmpDir, '_sandboxes'),
    workspacesRoot: path.join(tmpDir, 'WORKSPACES'),
    appsCloneRoot: path.join(tmpDir, 'APPS'),
    bareCacheRoot: path.join(tmpDir, '_cache'),
    customCommandSpec: {
      command: process.execPath,
      args: [
        '-e',
        `const fs=require("fs"); fs.writeFileSync("../output/task-outcome.json", JSON.stringify({status:"resolved", outcomeSummary:"Done fast", publicReplyMarkdown:"Completed cleanly.", deliverableFiles:[]})); console.log("ok");`,
      ],
    },
    customAdminApiHandler: async (method, endpoint, body) => {
      if (endpoint.endsWith('/worker/heartbeat')) {
        return {
          ok: true,
          state: { maxConcurrent: 7, paused: false, hardPaused: false, pollIntervalSeconds: 5, sandboxRetentionCount: 5 },
          signals: [],
        };
      }
      if (endpoint.endsWith('/worker/claim')) {
        assert.equal(body.requestedSlots, 7);
        if (claimedOnce) return { ok: true, maxConcurrent: 7, claimed: [] };
        claimedOnce = true;
        return {
          ok: true,
          maxConcurrent: 7,
          claimed: [
            {
              workItem: {
                id: 'wi-fast-1',
                projectId: 'proj-demo',
                title: 'Summarize Pipeline',
                bodyMarkdown: 'Summarize pipeline records for Q4 report.',
              },
              execution: { id: 'run-fast-1' },
              workspaceBootstrap: { workspaceName: 'Demo Workspace', installedAppKeys: [] },
            },
          ],
        };
      }
      if (method === 'PATCH' && endpoint.includes('/worker/runs/')) {
        updatedRuns.push(body);
        return { ok: true };
      }
      if (method === 'POST' && endpoint.endsWith('/logs')) {
        uploadedLogs.push(body);
        return { ok: true };
      }
      return { ok: true };
    },
  });

  await orch.start();

  assert.equal(orch.maxConcurrent, 7);
  const terminalUpdate = updatedRuns.find((u) => u.workItemStatus === 'resolved');
  assert.ok(terminalUpdate, 'Expected orchestrator to resolve claimed WorkItem');
  assert.ok(uploadedLogs.some((l) => l.kind === 'log'), 'Expected .log upload to S3 endpoint');

  // Verify Standalone Management UI server serves HTML & proxies /api cleanly
  const http = require('http');
  const mockBackend = http.createServer((req, res) => {
    if (req.url === '/admin/task-orchestrator/me') {
      const auth = req.headers['authorization'];
      if (auth !== 'Bearer valid-admin-jwt') {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Admin permission scope required' } }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, isAdmin: true, username: 'admin@test' }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => mockBackend.listen(0, '127.0.0.1', r));
  t.after(() => mockBackend.close());

  const backendPort = mockBackend.address().port;
  const uiServer = createManagementUiServer({
    backendBaseUrl: `http://127.0.0.1:${backendPort}`,
  });
  await new Promise((r) => uiServer.listen(0, '127.0.0.1', r));
  t.after(() => uiServer.close());

  const uiPort = uiServer.address().port;
  const indexRes = await fetch(`http://127.0.0.1:${uiPort}/`);
  assert.equal(indexRes.status, 200);
  const html = await indexRes.text();
  assert.match(html, /Task Orchestrator Console/);
  assert.match(html, /id="dashboardMainPane"/);
  assert.match(html, /<aside[\s\S]*?id="logDrawerBackdrop"[\s\S]*?inspector-push-drawer/);
  assert.doesNotMatch(html, /id="logDrawerBackdrop"[^>]*fixed inset-0/);
  assert.doesNotMatch(html, /id="logDrawerBackdrop"[^>]*bg-slate-900\/50/);

  const forbiddenRes = await fetch(`http://127.0.0.1:${uiPort}/api/admin/task-orchestrator/me`, {
    headers: { Authorization: 'Bearer non-admin' },
  });
  assert.equal(forbiddenRes.status, 403);

  const allowedRes = await fetch(`http://127.0.0.1:${uiPort}/api/admin/task-orchestrator/me`, {
    headers: { Authorization: 'Bearer valid-admin-jwt' },
  });
  assert.equal(allowedRes.status, 200);
});
