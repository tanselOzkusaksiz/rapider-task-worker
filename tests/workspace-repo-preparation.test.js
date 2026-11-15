const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, execFileSync } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const {
  extractTaskTargetBranch,
  calculateExpectedWorkspaceRepoName,
  buildProjectModelsContextMarkdownPure,
  buildWorkspaceEnvFilesPure,
  prepareWorkspaceRepository,
} = require('../scripts/prepare-workspace-repo');
const { stageTaskSandbox } = require('../scripts/stage-task-sandbox');
const { ScopedTaskProxyServer } = require('../scripts/scoped-task-proxy');

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function createMockWorkspaceApiClient() {
  const sampleModelsContextText = [
    'Project Data Models Context:',
    '',
    'Entity: Expense',
    'Entity Description: Canonical expense records representing individual purchases or costs incurred.',
    '',
    'Available Fields:',
    '- merchantName  (string)',
    '- amountMinor  (number)',
    '- currencyCode  (string)',
    '- status  (string): Lifecycle or record status.',
    '- reportId  (string)',
    '',
    'Available Relations:',
    '- finExpenseReport (belongsTo -> Report) [reportId -> id]',
    '- attachments (hasMany -> Expense Attachment) [id -> expenseId]: Receipts attached to the expense.',
    '',
    '---',
    '',
    'Entity: Terms',
    'Entity Description: Versioned policy referenced by invoice snapshot.',
    '',
    'Available Fields:',
    '- dueRule  (string)',
    '- status  (string)',
    '',
    'Available Relations:',
    'No relations defined.',
    '',
    '---',
  ].join('\n');

  const modelsJson = [
    {
      id: 'model-expense',
      title: 'Expense',
      name: 'FinExpense',
      dataTableName: 'fin_expenses',
      projectModelFields: [
        { key: 'merchantName', type: 'string' },
        { key: 'amountMinor', type: 'number' },
        { key: 'currencyCode', type: 'string' },
        { key: 'status', type: 'string' },
        { key: 'reportId', type: 'string' },
      ],
      projectModelRelations: [
        { name: 'finExpenseReport', type: 'belongsTo', targetModelTitle: 'Report' },
        { name: 'attachments', type: 'hasMany', targetModelTitle: 'Expense Attachment' },
      ],
    },
    {
      id: 'model-terms',
      title: 'Terms',
      name: 'FinTerms',
      dataTableName: 'fin_terms',
      projectModelFields: [
        { key: 'dueRule', type: 'string' },
        { key: 'status', type: 'string' },
      ],
      projectModelRelations: [],
    },
  ];

  const dataSources = [
    {
      id: 'ds-jira-01',
      name: 'jira_engineering',
      title: 'Jira Engineering Cloud',
      description: 'Connected Jira Cloud instance for sprint and issue tracking.',
      connector: 'integration',
      integrationConfig: {
        providerConfigKey: 'jira',
        status: 'connected',
      },
      nangoConnectionId: 'ws-prep-01-jira',
    },
    {
      id: 'ds-erp-api',
      name: 'erp_billing_openapi',
      title: 'ERP Billing OpenAPI',
      description: 'Internal billing REST OpenAPI specification.',
      connector: 'openapi',
      syncStatus: 'synced',
    },
  ];

  const toolsByDs = {
    'ds-jira-01': {
      connector: 'integration',
      disabledTools: ['jira_delete_project'],
      toolsMcp: [
        {
          name: 'jira_search_issues',
          description: 'Search Jira issues using JQL.',
          inputSchema: {
            type: 'object',
            required: ['jql'],
            properties: {
              jql: { type: 'string', description: 'JQL query string', example: 'project = ENG' },
              maxResults: { type: 'number', description: 'Max rows to return', example: 25 },
            },
          },
        },
        {
          name: 'jira_delete_project',
          description: 'Disabled administrative tool.',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
    },
    'ds-erp-api': {
      connector: 'openapi',
      disabledTools: [],
      toolsMcp: [
        {
          name: 'get_invoice_status',
          description: 'Fetch live invoice settlement status by invoiceNumber.',
          inputSchema: {
            type: 'object',
            required: ['invoiceNumber'],
            properties: {
              invoiceNumber: { type: 'string', example: 'INV-2026-001' },
            },
          },
        },
      ],
    },
  };

  return {
    async getText(endpointPath) {
      if (endpointPath === '/project-models/model-descriptions-for-ai-context') {
        return sampleModelsContextText;
      }
      throw new Error(`Unexpected getText: ${endpointPath}`);
    },
    async getBuffer(endpointPath) {
      if (endpointPath === '/project-documents/content/doc-sop-1') {
        return Buffer.from('# Reimbursement SOP\n\nSubmit receipts within 14 days.\n', 'utf8');
      }
      throw new Error(`Unexpected getBuffer: ${endpointPath}`);
    },
    async getJson(endpointPath) {
      if (endpointPath === '/projects') {
        return [{ id: 'ws-prep-01', name: 'Acme Finance Workspace' }];
      }
      if (endpointPath === '/git-infos') {
        return { projectId: 'ws-prep-01', repoName: 'acme-finance--ws-prep-01' };
      }
      if (endpointPath.startsWith('/project-models')) {
        return modelsJson;
      }
      if (endpointPath === '/data-schemas') return [];
      if (endpointPath === '/message-templates') return [];
      if (endpointPath === '/template-definitions') return [];
      if (endpointPath === '/data-sources') return dataSources;
      if (endpointPath === '/data-sources/ds-jira-01/tools') return toolsByDs['ds-jira-01'];
      if (endpointPath === '/data-sources/ds-erp-api/tools') return toolsByDs['ds-erp-api'];
      if (endpointPath === '/nango/connections') {
        return { connections: [{ provider_config_key: 'jira', connection_id: 'ws-prep-01-jira' }] };
      }
      if (endpointPath === '/integration-providers') {
        return [{ key: 'jira', title: 'Atlassian Jira' }];
      }
      if (endpointPath === '/capability-definitions') {
        return [
          {
            key: 'fn:calculateVat',
            displayName: 'Calculate VAT',
            sourceType: 'custom_function',
            effectLevel: 'read_only',
            status: 'active',
            description: 'Computes VAT minor units by country code.',
          },
        ];
      }
      if (endpointPath === '/projects/ws-prep-01/knowledge-spaces') {
        return [
          { spaceKey: 'finance-ops', name: 'Finance Operations', scope: 'company' },
        ];
      }
      if (endpointPath === '/projects/ws-prep-01/knowledge-spaces/finance-ops') {
        return {
          spaceKey: 'finance-ops',
          name: 'Finance Operations',
          description: 'Corporate finance policies & approval rules.',
          notebooks: [
            {
              key: '_space',
              name: 'Space Summary',
              pages: [{ key: 'index', title: 'Finance Ops Overview', kind: 'index', order: 0 }],
            },
            {
              key: 'policies',
              name: 'Expense Policies',
              pages: [
                {
                  key: 'expense-policy',
                  title: 'Global Expense Policy',
                  kind: 'page',
                  parentKey: null,
                  order: 0,
                  children: [
                    {
                      key: 'travel-per-diem',
                      title: 'Travel Per Diem Rates',
                      kind: 'note',
                      parentKey: 'expense-policy',
                      order: 0,
                      children: [],
                    },
                  ],
                },
              ],
            },
          ],
        };
      }
      if (endpointPath === '/projects/ws-prep-01/knowledge-spaces/finance-ops/pages/index') {
        return {
          frontmatter: { id: 'p-idx', key: 'index', title: 'Finance Ops Overview', kind: 'index' },
          body: '# Finance Operations Space\n\nCentral notebook space for Finance.',
        };
      }
      if (endpointPath === '/projects/ws-prep-01/knowledge-spaces/finance-ops/pages/expense-policy') {
        return {
          frontmatter: {
            id: 'p-pol',
            key: 'expense-policy',
            title: 'Global Expense Policy',
            space: 'finance-ops',
            notebook: 'policies',
            parentKey: null,
            order: 0,
            kind: 'page',
            status: 'published',
          },
          body: '# Global Expense Policy\n\nAll expenses over $75 require an itemized receipt.',
        };
      }
      if (endpointPath === '/projects/ws-prep-01/knowledge-spaces/finance-ops/pages/travel-per-diem') {
        return {
          frontmatter: {
            id: 'p-diem',
            key: 'travel-per-diem',
            title: 'Travel Per Diem Rates',
            space: 'finance-ops',
            notebook: 'policies',
            parentKey: 'expense-policy',
            order: 0,
            kind: 'note',
            status: 'active',
          },
          body: '# Travel Per Diem Rates\n\nStandard daily meal allowance is $65/day.',
        };
      }
      if (endpointPath === '/project-folders') {
        return [
          { id: 'fld-acct', name: 'Accounting', parentFolderId: null },
          { id: 'fld-sops', name: 'SOPs', parentFolderId: 'fld-acct' },
        ];
      }
      if (endpointPath === '/project-documents') {
        return [
          {
            id: 'doc-sop-1',
            title: 'Reimbursement SOP',
            name: 'reimbursement-guide.md',
            projectFolderId: 'fld-sops',
          },
        ];
      }
      if (endpointPath === '/project-settings') {
        return [
          { key: 'COMPANY_CURRENCY', value: 'USD' },
          { key: 'APPROVAL_THRESHOLD_MINOR', value: 7500 },
          { key: 'agentRuntime.mcp.autoApprove', value: false },
        ];
      }
      if (endpointPath === '/environment-variables') {
        return [
          { key: 'BACKEND_URL', value: 'https://dev-api.acme.example', environmentKey: 'DEV' },
          { key: 'BACKEND_URL', value: 'https://stage-api.acme.example', environmentKey: 'QA' },
          { key: 'BACKEND_URL', value: 'https://api.acme.example', environmentKey: 'PROD' },
          { key: 'STRIPE_WEBHOOK_LABEL', value: 'whsec_dev_placeholder', environmentKey: 'DEV' },
          { key: 'STRIPE_WEBHOOK_LABEL', value: 'whsec_stage_placeholder', environmentKey: 'QA' },
          { key: 'STRIPE_WEBHOOK_LABEL', value: 'whsec_prod_placeholder', environmentKey: 'PROD' },
        ];
      }
      return [];
    },
  };
}

describe('Workspace Git Repository Pre-Task Preparation Pipeline', () => {
  it('resolves task branch vs default main deterministically and rejects unsafe branch names', () => {
    assert.equal(extractTaskTargetBranch(null), 'main');
    assert.equal(extractTaskTargetBranch({ id: 't1' }), 'main');
    assert.equal(extractTaskTargetBranch({ branch: 'feat/q4-audit' }), 'feat/q4-audit');
    assert.equal(extractTaskTargetBranch({ metadata: { branch: 'refs/heads/release/2.1' } }), 'release/2.1');
    assert.equal(extractTaskTargetBranch({ branch: 'idle' }), 'main');
    assert.equal(extractTaskTargetBranch({ branch: '--upload-pack=evil' }), 'main');
    assert.equal(extractTaskTargetBranch({ branch: 'bad..branch' }), 'main');
  });

  it('pulls physical GitHub repo on main (or task branch), overwrites stale committed files, syncs models/datasources/notebooks/envs, and commits cleanly', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rapider-ws-prep-'));
    try {
      const remotesRoot = path.join(tmpRoot, 'remotes');
      const workspacesRoot = path.join(tmpRoot, 'WORKSPACES');
      const sandboxesRoot = path.join(tmpRoot, 'SANDBOXES');
      fs.mkdirSync(remotesRoot, { recursive: true });
      fs.mkdirSync(workspacesRoot, { recursive: true });

      // 1. Create a bare "GitHub" remote repo `acme-finance--ws-prep-01.git`
      const bareRemoteDir = path.join(remotesRoot, 'acme-finance--ws-prep-01.git');
      fs.mkdirSync(bareRemoteDir, { recursive: true });
      git(bareRemoteDir, ['init', '--bare', '-b', 'main']);

      // 2. Clone onto physical drive at `WORKSPACES/acme-finance--ws-prep-01` with STALE files + `.gitignore` ignoring `*.env`
      const localRepoDir = path.join(workspacesRoot, 'acme-finance--ws-prep-01');
      git(workspacesRoot, ['clone', bareRemoteDir, localRepoDir]);
      git(localRepoDir, ['config', 'user.name', 'Seed Setup']);
      git(localRepoDir, ['config', 'user.email', 'seed@rapider.local']);

      fs.writeFileSync(path.join(localRepoDir, '.gitignore'), 'node_modules/\n*.env\n', 'utf8');
      fs.writeFileSync(
        path.join(localRepoDir, 'AGENTS.md'),
        '# Custom Team Rule\nAlways use 2-space indentation.\n',
        'utf8'
      );
      fs.mkdirSync(path.join(localRepoDir, '.agents'), { recursive: true });
      fs.writeFileSync(path.join(localRepoDir, '.agents/project-data-models.md'), 'STALE OLD MODELS\n', 'utf8');
      fs.mkdirSync(path.join(localRepoDir, '_notebooks/old-space'), { recursive: true });
      fs.writeFileSync(path.join(localRepoDir, '_notebooks/old-space/deleted-page.md'), 'STALE NOTEBOOK\n', 'utf8');
      fs.writeFileSync(path.join(localRepoDir, 'dev.env'), 'COMPANY_CURRENCY=OLD_VALUE\n', 'utf8');

      git(localRepoDir, ['add', '-f', '.']);
      git(localRepoDir, ['commit', '-m', 'chore: initial stale workspace files']);
      git(localRepoDir, ['push', '-u', 'origin', 'main']);

      // 3. Simulate a fresh upstream commit pushed to `origin/main` AND a feature branch `feat/q4-expenses` on remote!
      const upstreamWriterDir = path.join(tmpRoot, 'upstream-writer');
      git(tmpRoot, ['clone', bareRemoteDir, upstreamWriterDir]);
      git(upstreamWriterDir, ['config', 'user.name', 'Upstream CodeGen']);
      git(upstreamWriterDir, ['config', 'user.email', 'codegen@rapider.local']);
      fs.mkdirSync(path.join(upstreamWriterDir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(upstreamWriterDir, 'src/index.ts'), 'export const version = 2;\n', 'utf8');
      git(upstreamWriterDir, ['add', '.']);
      git(upstreamWriterDir, ['commit', '-m', 'feat: upstream codegen update on main']);
      git(upstreamWriterDir, ['push', 'origin', 'main']);

      git(upstreamWriterDir, ['checkout', '-b', 'feat/q4-expenses']);
      fs.writeFileSync(path.join(upstreamWriterDir, 'src/q4.ts'), 'export const quarter = "Q4";\n', 'utf8');
      git(upstreamWriterDir, ['add', '.']);
      git(upstreamWriterDir, ['commit', '-m', 'feat: add q4 module on feature branch']);
      git(upstreamWriterDir, ['push', '-u', 'origin', 'feat/q4-expenses']);

      // Park local repo onto `idle` before running preparation (simulating normal worker resting state)
      git(localRepoDir, ['checkout', '--orphan', 'idle']);
      git(localRepoDir, ['rm', '-rf', '.']);
      fs.writeFileSync(path.join(localRepoDir, 'README.md'), '# Idle\n', 'utf8');
      git(localRepoDir, ['add', 'README.md']);
      git(localRepoDir, ['commit', '-m', 'chore: idle']);

      // 4. Run `prepareWorkspaceRepository` for a task WITHOUT a branch -> must switch to `main` & `git pull`!
      const api = createMockWorkspaceApiClient();
      const prepMain = await prepareWorkspaceRepository({
        projectId: 'ws-prep-01',
        workItem: { id: 'task-no-branch', projectId: 'ws-prep-01', title: 'Audit Expenses' },
        workspacesRoot,
        customApiClient: api,
      });

      assert.equal(prepMain.branch, 'main');
      assert.equal(prepMain.repoName, 'acme-finance--ws-prep-01');
      assert.equal(prepMain.existedOnDisk, true);
      assert.equal(prepMain.pulledFromRemote, true);
      assert.equal(prepMain.committed, true);

      // Pulled `src/index.ts` from `origin/main`!
      assert.equal(fs.existsSync(path.join(localRepoDir, 'src/index.ts')), true);
      assert.equal(fs.existsSync(path.join(localRepoDir, 'src/q4.ts')), false);

      // Overwrote `.agents/project-data-models.md` with fresh API Markdown
      const modelsMd = fs.readFileSync(path.join(localRepoDir, '.agents/project-data-models.md'), 'utf8');
      assert.match(modelsMd, /Project Data Models Context:/);
      assert.match(modelsMd, /Entity: Expense/);
      assert.doesNotMatch(modelsMd, /STALE OLD MODELS/);

      // Generated `.agents/project-data-manager-guide.md` with exact Entity -> dataTableName mapping
      const guideMd = fs.readFileSync(path.join(localRepoDir, '.agents/project-data-manager-guide.md'), 'utf8');
      assert.match(guideMd, /\*\*Expense\*\* \| `FinExpense` \| `fin_expenses`/);
      assert.match(guideMd, /\*\*Terms\*\* \| `FinTerms` \| `fin_terms`/);
      assert.match(guideMd, /\/project-data-manager\/\{dataTableName\}/);

      // Preserved custom rule in `AGENTS.md` while injecting managed Workspace Context block
      const repoAgentsMd = fs.readFileSync(path.join(localRepoDir, 'AGENTS.md'), 'utf8');
      assert.match(repoAgentsMd, /Always use 2-space indentation\./);
      assert.match(repoAgentsMd, /\.agents\/project-data-models\.md/);
      assert.match(repoAgentsMd, /\.agents\/project-data-manager-guide\.md/);
      assert.match(repoAgentsMd, /\.agents\/workspace-datasources-and-integrations\.md/);

      // Generated `.agents/workspace-datasources-and-integrations.md` with Jira tools (excluding disabled tools!)
      const dsMd = fs.readFileSync(
        path.join(localRepoDir, '.agents/workspace-datasources-and-integrations.md'),
        'utf8'
      );
      assert.match(dsMd, /Jira Engineering Cloud/);
      assert.match(dsMd, /jira_search_issues/);
      assert.doesNotMatch(dsMd, /jira_delete_project/);
      assert.match(dsMd, /get_invoice_status/);

      // Synced `_notebooks/` hierarchy & pruned deleted `old-space/deleted-page.md`!
      assert.equal(fs.existsSync(path.join(localRepoDir, '_notebooks/old-space/deleted-page.md')), false);
      assert.equal(fs.existsSync(path.join(localRepoDir, '_notebooks/INDEX.md')), true);
      assert.equal(fs.existsSync(path.join(localRepoDir, '_notebooks/finance-ops/README.md')), true);
      assert.equal(
        fs.existsSync(
          path.join(localRepoDir, '_notebooks/finance-ops/policies/expense-policy/expense-policy.md')
        ),
        true
      );
      assert.equal(
        fs.existsSync(
          path.join(localRepoDir, '_notebooks/finance-ops/policies/expense-policy/travel-per-diem.md')
        ),
        true
      );
      assert.equal(
        fs.existsSync(
          path.join(localRepoDir, '_notebooks/_documents/Accounting/SOPs/reimbursement-guide.md')
        ),
        true
      );

      // Generated & committed `dev.env`, `stage.env`, `prod.env` despite `*.env` in `.gitignore`!
      const devEnv = fs.readFileSync(path.join(localRepoDir, 'dev.env'), 'utf8');
      const stageEnv = fs.readFileSync(path.join(localRepoDir, 'stage.env'), 'utf8');
      const prodEnv = fs.readFileSync(path.join(localRepoDir, 'prod.env'), 'utf8');
      assert.match(devEnv, /COMPANY_CURRENCY=USD/);
      assert.match(stageEnv, /COMPANY_CURRENCY=USD/);
      assert.match(prodEnv, /COMPANY_CURRENCY=USD/);
      assert.match(devEnv, /BACKEND_URL=https:\/\/dev-api\.acme\.example/);
      assert.match(stageEnv, /BACKEND_URL=https:\/\/stage-api\.acme\.example/);
      assert.match(prodEnv, /BACKEND_URL=https:\/\/api\.acme\.example/);
      assert.equal(git(localRepoDir, ['status', '--porcelain']), '');

      // Tracked in git commit!
      const trackedEnvFiles = git(localRepoDir, ['ls-files', 'dev.env', 'stage.env', 'prod.env']);
      assert.match(trackedEnvFiles, /dev\.env/);
      assert.match(trackedEnvFiles, /stage\.env/);
      assert.match(trackedEnvFiles, /prod\.env/);

      // 5. Idempotency check: re-running with unchanged data creates ZERO new commits!
      const prepIdempotent = await prepareWorkspaceRepository({
        projectId: 'ws-prep-01',
        workItem: { id: 'task-no-branch-2', projectId: 'ws-prep-01' },
        workspacesRoot,
        customApiClient: api,
      });
      assert.equal(prepIdempotent.committed, false);
      assert.equal(prepIdempotent.headSha, prepMain.headSha);

      // 6. Task WITH explicit branch (`feat/q4-expenses`) + Sandbox Staging!
      const stagedManifest = await stageTaskSandbox({
        workItem: {
          id: 'task-q4-branch',
          projectId: 'ws-prep-01',
          branch: 'feat/q4-expenses',
          title: 'Prepare Q4 Expense Summary',
        },
        runId: 'run-q4-01',
        sandboxesRoot,
        workspacesRoot,
        customApiClient: api,
      });

      // Host repo immediately re-parked on `idle`!
      assert.equal(git(localRepoDir, ['rev-parse', '--abbrev-ref', 'HEAD']), 'idle');

      // Sandbox `workspace-context/` contains both `src/q4.ts` (from `feat/q4-expenses`) AND all prepared files!
      const wsMount = path.join(stagedManifest.workspaceDir, 'workspace-context');
      assert.equal(fs.existsSync(path.join(wsMount, 'src/q4.ts')), true);
      assert.equal(fs.existsSync(path.join(wsMount, '.agents/project-data-models.md')), true);
      assert.equal(fs.existsSync(path.join(wsMount, '.agents/project-data-manager-guide.md')), true);
      assert.equal(
        fs.existsSync(path.join(wsMount, '.agents/workspace-datasources-and-integrations.md')),
        true
      );
      assert.equal(fs.existsSync(path.join(wsMount, '_notebooks/INDEX.md')), true);
      assert.equal(fs.existsSync(path.join(wsMount, 'dev.env')), true);
      assert.equal(fs.existsSync(path.join(wsMount, 'stage.env')), true);
      assert.equal(fs.existsSync(path.join(wsMount, 'prod.env')), true);

      // Root `.agents/` inside sandbox also mirrors the 3 Markdown guides, and `TASK_BRIEF.md` indexes them!
      assert.equal(
        fs.existsSync(path.join(stagedManifest.workspaceDir, '.agents/project-data-models.md')),
        true
      );
      const briefMd = fs.readFileSync(path.join(stagedManifest.workspaceDir, 'TASK_BRIEF.md'), 'utf8');
      assert.match(briefMd, /workspace-context\/\.agents\/project-data-models\.md/);
      assert.match(briefMd, /workspace-context\/\.agents\/project-data-manager-guide\.md/);
      assert.match(briefMd, /workspace-context\/_notebooks\/INDEX\.md/);
      assert.deepEqual(stagedManifest.allowedTables, ['fin_expenses', 'fin_terms']);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('supports full project-data-manager CRUD + Jira/MCP DataSource tool execution via ScopedTaskProxyServer and rapider-task-cli.js', async () => {
    const recordedCalls = [];
    const proxy = new ScopedTaskProxyServer({
      customUpstreamFetch: async (projectId, endpointPath, init = {}) => {
        const method = init.method || 'GET';
        recordedCalls.push({ projectId, method, endpointPath, body: init.body ? JSON.parse(init.body) : null });

        if (method === 'GET' && endpointPath.startsWith('/project-data-manager/fin_expenses/count')) {
          return { ok: true, status: 200, data: { count: 14 } };
        }
        if (method === 'POST' && endpointPath === '/project-data-manager/fin_expenses') {
          return { ok: true, status: 200, data: { id: 'exp-new-1', ...JSON.parse(init.body) } };
        }
        if (method === 'POST' && endpointPath === '/project-data-manager/bulk/fin_expenses') {
          return { ok: true, status: 200, data: JSON.parse(init.body) };
        }
        if (method === 'PATCH' && endpointPath === '/project-data-manager/fin_expenses/exp-new-1') {
          return { ok: true, status: 204, data: null };
        }
        if (method === 'GET' && endpointPath === '/data-sources') {
          return { ok: true, status: 200, data: [{ id: 'ds-jira-01', name: 'jira_engineering' }] };
        }
        if (
          method === 'POST' &&
          endpointPath === '/data-sources/ds-jira-01/tools/jira_search_issues/execute'
        ) {
          return {
            ok: true,
            status: 200,
            data: { issues: [{ key: 'ENG-42', summary: 'Sync workspace notebooks' }] },
          };
        }
        return { ok: true, status: 200, data: {} };
      },
    });

    const proxyUrl = await proxy.start();
    try {
      const lease = proxy.registerTaskLease({
        workItemId: 'wi-crud-test',
        projectId: 'ws-prep-01',
        workspaceName: 'Acme Finance',
        allowedTables: ['fin_expenses'],
      });

      const cliPath = path.resolve(__dirname, '../scripts/sandbox-tools/rapider-task-cli.js');
      const runCli = async (cliArgs) => {
        const { stdout } = await execFileAsync(process.execPath, [cliPath, ...cliArgs], {
          encoding: 'utf8',
          env: {
            ...process.env,
            RAPIDER_TASK_PROXY_URL: proxyUrl,
            RAPIDER_TASK_NONCE: lease.nonce,
          },
        });
        return JSON.parse(stdout);
      };

      // 1. Count records
      const countOut = await runCli(['count-data', '--table=fin_expenses', '--where={"status":"open"}']);
      assert.equal(countOut.count, 14);

      // 2. Create record
      const created = await runCli([
        'create-record',
        '--table=fin_expenses',
        '--data={"merchantName":"Cloudflare","amountMinor":2500,"status":"open"}',
      ]);
      assert.equal(created.id, 'exp-new-1');

      // 3. Patch update (handles 204 No Content cleanly!)
      const patched = await runCli([
        'update-record',
        '--table=fin_expenses',
        '--id=exp-new-1',
        '--data={"status":"approved"}',
      ]);
      assert.equal(patched.ok, true);

      // 4. Execute Jira MCP tool via DataSource gateway!
      const jiraRes = await runCli([
        'run-datasource-tool',
        '--datasource=ds-jira-01',
        '--tool=jira_search_issues',
        '--input={"jql":"project = ENG"}',
      ]);
      assert.equal(jiraRes.issues[0].key, 'ENG-42');

      // 5. Unauthorized table & destructive datasource deletion remain strictly blocked!
      await assert.rejects(
        () => runCli(['create-record', '--table=other_tenant_table', '--data={"x":1}']),
        /not in this Workspace's authorized model list/
      );

      await assert.rejects(
        () => runCli(['workspace-api', '--method=DELETE', '--path=/data-sources/ds-jira-01']),
        /blocked by the Workspace Capability Proxy/
      );

      assert.equal(recordedCalls.every((c) => c.projectId === 'ws-prep-01'), true);
    } finally {
      await proxy.stop();
    }
  });

  it('builds fallback models context and dotenv files purely with deterministic key ordering', () => {
    const fallbackMd = buildProjectModelsContextMarkdownPure([
      {
        title: 'Invoice',
        description: 'Customer invoice.',
        projectModelFields: [{ key: 'totalMinor', type: 'number', description: 'Total in cents' }],
        projectModelRelations: [],
      },
    ]);
    assert.match(fallbackMd, /Entity: Invoice/);
    assert.match(fallbackMd, /- totalMinor  \(number\): Total in cents/);

    const envs = buildWorkspaceEnvFilesPure({
      projectSettings: [{ key: 'SHARED_REGION', value: 'us-east-1' }],
      environmentVariables: [
        { key: 'LOG_LEVEL', value: 'debug', environmentKey: 'DEV' },
        { key: 'LOG_LEVEL', value: 'info', environmentKey: 'QA' },
        { key: 'LOG_LEVEL', value: 'warn', environmentKey: 'PROD' },
      ],
    });
    assert.match(envs['dev.env'], /SHARED_REGION=us-east-1/);
    assert.match(envs['dev.env'], /LOG_LEVEL=debug/);
    assert.match(envs['stage.env'], /LOG_LEVEL=info/);
    assert.match(envs['prod.env'], /LOG_LEVEL=warn/);
  });

  it('creates missing Workspace repository (GitInfo + remote repo + local repo) with expected `${project.key}--${projectId}` name when none exists yet', async () => {
    assert.equal(
      calculateExpectedWorkspaceRepoName({ key: 'acme-erp', name: 'Acme ERP Suite' }, 'ws-new-99'),
      'acme-erp--ws-new-99'
    );
    assert.equal(
      calculateExpectedWorkspaceRepoName({ name: 'Acme ERP Suite' }, 'ws-new-99'),
      'acme-erp-suite--ws-new-99'
    );

    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rapider-ws-create-'));
    try {
      const remotesRoot = path.join(tmpRoot, 'remotes');
      const workspacesRoot = path.join(tmpRoot, 'WORKSPACES');
      fs.mkdirSync(remotesRoot, { recursive: true });
      fs.mkdirSync(workspacesRoot, { recursive: true });

      let ensureEndpointCalled = 0;
      let createdRemoteBareDir = null;

      // Simulate a Workspace that has NO `GitInfo` yet (GET `/git-infos` returns 404/null) and NO repo on disk!
      const noRepoApi = {
        async getText(endpointPath) {
          if (endpointPath === '/project-models/model-descriptions-for-ai-context') {
            return 'Project Data Models Context:\n\nEntity: Order\nEntity Description: Sales order.\n\nAvailable Fields:\n- orderNo  (string)\n\nAvailable Relations:\nNo relations defined.\n';
          }
          throw new Error(`Unexpected getText: ${endpointPath}`);
        },
        async getBuffer() {
          return null;
        },
        async postJson(endpointPath) {
          if (endpointPath === '/git-infos/ensure') {
            ensureEndpointCalled++;
            return {
              id: 'gi-new-99',
              projectId: 'ws-new-99',
              repoName: 'acme-erp--ws-new-99',
              createdGitInfo: true,
              createdRemoteRepo: false,
            };
          }
          return {};
        },
        async getJson(endpointPath) {
          if (endpointPath === '/projects') {
            return [{ id: 'ws-new-99', key: 'acme-erp', name: 'Acme ERP Suite' }];
          }
          if (endpointPath === '/git-infos') {
            const err = new Error('Git info not found.');
            err.status = 404;
            throw err;
          }
          if (endpointPath.startsWith('/project-models')) {
            return [{ id: 'm-ord', title: 'Order', name: 'ErpOrder', dataTableName: 'erp_orders' }];
          }
          if (endpointPath === '/project-settings') {
            return [{ key: 'DEFAULT_LOCALE', value: 'en-US' }];
          }
          if (endpointPath === '/environment-variables') {
            return [{ key: 'ERP_MODE', value: 'sandbox', environmentKey: 'DEV' }];
          }
          return [];
        },
      };

      const res = await prepareWorkspaceRepository({
        projectId: 'ws-new-99',
        workItem: { id: 'task-brand-new-ws', projectId: 'ws-new-99', branch: 'feat/bootstrap' },
        workspacesRoot,
        customApiClient: noRepoApi,
        customRemoteRepoCreator: ({ repoName }) => {
          createdRemoteBareDir = path.join(remotesRoot, `${repoName}.git`);
          fs.mkdirSync(createdRemoteBareDir, { recursive: true });
          git(createdRemoteBareDir, ['init', '--bare', '-b', 'main']);
          return { created: true, remoteUrl: createdRemoteBareDir };
        },
      });

      assert.equal(ensureEndpointCalled, 1);
      assert.equal(res.repoName, 'acme-erp--ws-new-99');
      assert.equal(res.existedOnDisk, false);
      assert.equal(res.createdGitInfo, true);
      assert.equal(res.createdLocalRepo, true);
      assert.equal(res.createdRemoteRepo, true);
      assert.equal(res.pushedToRemote, true);
      assert.equal(res.branch, 'feat/bootstrap');

      // Created under `WORKSPACES/acme-erp--ws-new-99` (NEVER bare `WORKSPACES/ws-new-99`!)
      const expectedLocalDir = path.join(workspacesRoot, 'acme-erp--ws-new-99');
      assert.equal(res.repoDir, expectedLocalDir);
      assert.equal(fs.existsSync(expectedLocalDir), true);
      assert.equal(fs.existsSync(path.join(workspacesRoot, 'ws-new-99')), false);
      assert.equal(fs.existsSync(path.join(expectedLocalDir, '.agents/project-data-models.md')), true);
      assert.equal(fs.existsSync(path.join(expectedLocalDir, 'dev.env')), true);

      // Remote bare repo also received both `main` and `feat/bootstrap` branches!
      const remoteBranches = git(createdRemoteBareDir, ['branch', '--list']);
      assert.match(remoteBranches, /main/);
      assert.match(remoteBranches, /feat\/bootstrap/);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
