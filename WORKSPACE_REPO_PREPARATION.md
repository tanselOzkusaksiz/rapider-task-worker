# Pre-Task Workspace Git Repository Preparation Guide

Before starting any Rapider `WorkItem` task (`kind: "task"`), `rapider-task-worker` (both the **Isolated Multi-Repo Task Orchestrator** [`scripts/isolated-task-orchestrator.js`](./scripts/isolated-task-orchestrator.js) and the **Single-Workspace Worker** [`scripts/task-worker-daemon.js`](./scripts/task-worker-daemon.js)) deterministically prepares the target Workspace's Git repository via [`scripts/prepare-workspace-repo.js`](./scripts/prepare-workspace-repo.js).

Every run fetches the latest Workspace metadata from **Rapider MongoDB** and **DigitalOcean Spaces S3**, overwrites any stale copies previously committed on the branch, commits the refreshed files onto the task's target branch (or `main`), and then launches the isolated AI agent.

---

## 1. End-to-End 7-Step Preparation Pipeline

1. **GitHub Repo Resolution, Automatic Missing Repo Creation, Branch Checkout & `git pull`**
   - Queries `GET /git-infos` and `GET /projects` to resolve the Workspace's canonical GitHub repository name (`GitInfo.repoName`).
   - **If no repository exists yet (`GitInfo` missing / remote GitHub repo missing / local repo missing)**:
     - Calls `POST /git-infos/ensure` on `rapider-server` (`GitInfoController.ensureProjectGitRepository`), which creates the missing `GitInfo` record in Rapider MongoDB with the expected name `${project.key}--${projectId}` (or slugified `${project.name}--${projectId}`) and provisions the private GitHub repository (`${GITHUB_OWNER}/${expectedRepoName}`) when GitHub integration is enabled.
     - On the worker host, `preparePhysicalGitRepo()` also ensures the remote GitHub repository (`gh repo create <owner>/<expectedRepoName> --private` if `git clone` indicates the remote does not yet exist) and initializes the local physical repository at `WORKSPACES/<expectedRepoName>` on `main` (and `<taskBranch>` if specified), migrating any legacy bare `WORKSPACES/<projectId>` directory to `WORKSPACES/<expectedRepoName>`.
   - **If the repository already exists on the physical drive** (`RAPIDER_CODEGEN_REPOS_DIR/<repoName>` or `WORKSPACES/<repoName>`):
     - Ensures `origin` points to `https://github.com/${GITHUB_OWNER}/${repoName}.git` (resolving `RAPIDER_GITHUB_OWNER` / `GITHUB_OWNER` dynamically without writing credentials to `.git/config`).
     - Fetches `origin`, inherits cleanly from the remote default branch (e.g., `origin/0.0.1` on boilerplate-created Workspace repos) when `origin/main` does not yet exist on GitHub, and switches to the task branch (or **`main`** when no branch is specified).
   - Step 7 pushes prepared `main` / `<taskBranch>` commits to `origin` automatically when online (`pushPreparedCommit = true` by default; skipped in `--offline` mode).

2. **Project Data Models AI Context (`<repo root>/.agents/project-data-models.md`)**
   - Calls `GET /project-models/model-descriptions-for-ai-context` (`Accept-Language: en-US,en;q=0.9,tr;q=0.8`, `Authorization: <projectToken>`) and overwrites `<repo root>/.agents/project-data-models.md` with every `Entity`, `Entity Description`, `Available Fields`, and `Available Relations` (`belongsTo`, `hasMany`, `referencesMany`).
   - Includes a deterministic pure fallback formatter (`buildProjectModelsContextMarkdownPure`) backed by `GET /project-models` if the text endpoint is unavailable.

3. **`AGENTS.md` Update + Project Data Manager CRUD Guide (`<repo root>/.agents/project-data-manager-guide.md`)**
   - Generates `<repo root>/.agents/project-data-manager-guide.md` containing:
     - **Deterministic `Entity -> Model Name -> dataTableName` Lookup Table** mapping every `Entity:` title in `.agents/project-data-models.md` to its exact `{dataTableName}` path parameter.
     - Complete `ProjectDataManagerController` REST & Sandbox CLI reference (`GET /{dataTableName}?filter=...`, `GET /{dataTableName}/count?where=...`, `GET /{dataTableName}/{id}`, `POST /{dataTableName}`, `POST /bulk/{dataTableName}`, `PATCH /{dataTableName}/{id}`, `PATCH /{dataTableName}/{id}/replace`, and single-record soft `DELETE /{dataTableName}/{id}`).
   - Upserts a managed `<!-- BEGIN RAPIDER WORKSPACE CONTEXT --> ... <!-- END RAPIDER WORKSPACE CONTEXT -->` section in `<repo root>/AGENTS.md` (preserving any custom user/team rules outside the managed block) and mirrors the guides into `<sandbox>/workspace/.agents/` during isolated sandbox staging.

4. **Workspace DataSources, Connected Integrations, MCP & API Guide (`<repo root>/.agents/workspace-datasources-and-integrations.md`)**
   - Queries `GET /data-sources`, `GET /data-sources/{id}/tools`, `GET /nango/connections`, `GET /integration-providers`, and `GET /capability-definitions`.
   - Overwrites `<repo root>/.agents/workspace-datasources-and-integrations.md` listing every configured connector (e.g., **Jira**, **Slack**, **Google Drive**, **GitHub**, **Salesforce**, MCP servers, OpenAPI specs, databases, and RAG/file sources), its enabled tool names (automatically excluding `disabledTools`), JSON input schemas, and ready-to-run `rapider-task-cli.js run-datasource-tool` / `POST /data-sources/{id}/tools/{toolName}/execute` commands.

5. **Workspace Notebooks Hierarchy Sync (`<repo root>/_notebooks/`)**
   - Queries `GET /projects/{projectId}/knowledge-spaces`, each space's manifest (`GET /projects/{projectId}/knowledge-spaces/{spaceKey}`), and each page's Markdown body from DigitalOcean Spaces S3 (`GET .../pages/{pageKey}`), plus any legacy `ProjectFolder` + `ProjectDocument` files (`GET /project-folders`, `GET /project-documents`, `GET /project-documents/content/{id}`).
   - Rebuilds `<repo root>/_notebooks/` cleanly from scratch (pruning deleted pages and overwriting modified ones) while preserving the full `Space -> Notebook/Folder -> Nested Page (parentKey)` directory tree and generating `<repo root>/_notebooks/INDEX.md`.

6. **Environment & Project Settings Files (`dev.env`, `stage.env`, `prod.env`)**
   - Queries `GET /project-settings` (shared across all environments) and `GET /environment-variables` (`DEV`, `QA`/`STAGE`, `PROD` in Rapider MongoDB).
   - Deterministically generates and overwrites `<repo root>/dev.env`, `<repo root>/stage.env`, and `<repo root>/prod.env` matching Rapider's Project Code Generator layout.

7. **Deterministic Overwrite & Branch Commit Before Task Execution**
   - Stages all updated/deleted preparation artifacts (`git add -A` + `git add -f` on managed files so template `.gitignore` rules like `*.env` never silently skip Workspace env files) and commits onto `<branch>` when changes exist. If Workspace data has not changed since the prior run, `git status` is clean (`committed: false`) with zero noisy empty commits.

---

## 2. Prepared Workspace Repository File Layout

```text
<workspace-repo-root>/
├── AGENTS.md                                           # Preserves custom repo rules + managed Workspace Context pointers
├── WORKSPACE_CONTEXT.md                                # Concise Workspace snapshot summary
├── dev.env                                             # ProjectSetting (shared) + DEV EnvironmentVariable values
├── stage.env                                           # ProjectSetting (shared) + QA/STAGE EnvironmentVariable values
├── prod.env                                            # ProjectSetting (shared) + PROD EnvironmentVariable values
├── .agents/
│   ├── project-data-models.md                          # Exact output of /project-models/model-descriptions-for-ai-context
│   ├── project-data-manager-guide.md                   # Entity -> dataTableName table + full CRUD/filter/bulk API guide
│   └── workspace-datasources-and-integrations.md       # Jira/Slack/MCP/OpenAPI connectors, tool schemas & CLI examples
└── _notebooks/
    ├── INDEX.md                                        # Full hierarchical table of contents
    ├── <spaceKey>/
    │   ├── README.md                                   # Space root summary (_space/index)
    │   └── <notebookKey>/
    │       ├── <leafPageKey>.md
    │       └── <parentPageKey>/
    │           ├── <parentPageKey>.md
    │           └── <childPageKey>.md
    └── _documents/                                     # Legacy ProjectFolder / ProjectDocument files from S3
        └── <FolderHierarchy>/<documentFile>
```

---

## 3. CLI & `package.json` Scripts

Run the full preparation pipeline or individual deterministic steps from `rapider-task-worker/`:

| `npm run` Script | Command | Purpose |
| --- | --- | --- |
| `npm run prepare:workspace -- --project=<id> [--branch=main]` | `node scripts/prepare-workspace-repo.js` | Execute all 7 steps (`git pull` + models + datasources + notebooks + envs + commit). |
| `npm run prepare:models -- --project=<id>` | `node scripts/prepare-workspace-repo.js --step=models` | Refresh `.agents/project-data-models.md` & `.agents/project-data-manager-guide.md` only. |
| `npm run prepare:datasources -- --project=<id>` | `node scripts/prepare-workspace-repo.js --step=datasources` | Refresh `.agents/workspace-datasources-and-integrations.md` & `mcp/datasources-and-tools.json`. |
| `npm run prepare:notebooks -- --project=<id>` | `node scripts/prepare-workspace-repo.js --step=notebooks` | Re-sync `_notebooks/` hierarchy from MongoDB + S3. |
| `npm run prepare:envs -- --project=<id>` | `node scripts/prepare-workspace-repo.js --step=envs` | Regenerate `dev.env`, `stage.env`, and `prod.env`. |
| `npm run test:prepare` | `node --test tests/workspace-repo-preparation.test.js` | Run automated tests for repo pull, overwrite, notebooks hierarchy, env files & proxy CRUD/MCP. |

---

## 4. Sandbox Capability CLI (`rapider-task-cli.js`) Reference

Inside the jailed sandbox (`sandbox-exec` on macOS / `bwrap` on Linux), the isolated agent executes all `project-data-manager` and DataSource/MCP operations through `ScopedTaskProxyServer` without raw admin credentials:

```bash
# Project Data Manager CRUD & Aggregations
node ../tools/rapider-task-cli.js query-data --table=<dataTableName> --all --out=../output/rows.json
node ../tools/rapider-task-cli.js count-data --table=<dataTableName> --where='{"status":"active"}'
node ../tools/rapider-task-cli.js get-record --table=<dataTableName> --id="<uuid>" --filter='{"include":[{"relation":"attachments"}]}'
node ../tools/rapider-task-cli.js create-record --table=<dataTableName> --data='{"status":"open"}'
node ../tools/rapider-task-cli.js bulk-create-records --table=<dataTableName> --file=../output/new-rows.json
node ../tools/rapider-task-cli.js update-record --table=<dataTableName> --id="<uuid>" --data='{"status":"approved"}'
node ../tools/rapider-task-cli.js delete-record --table=<dataTableName> --id="<uuid>"

# Connected Integrations (Jira, Slack, Google Drive, OpenAPI, MCP)
node ../tools/rapider-task-cli.js list-datasources
node ../tools/rapider-task-cli.js list-datasource-tools --datasource="<dataSourceId>"
node ../tools/rapider-task-cli.js run-datasource-tool --datasource="<dataSourceId>" --tool="<toolName>" --input='{"jql":"project = ENG"}'
```

