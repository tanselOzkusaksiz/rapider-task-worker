# Rapider Isolated Task Worker (`rapider-task-worker`)

Autonomous, workspace-isolated background AI task runner (**`ISOLATED-TASK-WORKER`**) for processing open Rapider `WorkItem` (`"kind": "task"`, `"status": "open"`) requests in **FIFO batches of 5** (*finish oldest 5 -> fetch next 5*).

---

## Core Capabilities

`ISOLATED-TASK-WORKER` operates **strictly and exclusively** on the target Workspace's repository and authorized Workspace data/tools:

1. **Complex Data Reporting:** Multi-table Workspace DB queries (`/project-data-manager/{dataTableName}`), cross-entity joins, cohort & pipeline analytics, and 12-month worst-case / best-case scenario projections with zero fabricated numbers.
2. **Handlebars Template Generation:** Schema-driven authoring, local Handlebars compile/render validation against live or sample Workspace records, and persistence to `.hbs` artifacts, `MessageTemplate`, and Workspace repos.
3. **File Preparation:** Clean generation, validation, and Workspace `ProjectFile` upload of `.md`, `.pdf`, `.csv`, `.hbs`, and `.json` deliverables attached directly to the `WorkItem`.
4. **Allowed API Payloads & Actions:** Schema-validated payload preparation and execution strictly via Workspace-configured APIs and MCPs (`ToolGatewayService`).

---

## 5-Step Isolated Execution Pipeline

Every queued task in each batch of 5 passes through five mandatory gates:

1. **Switch to Workspace Repo:** Activate `WORKSPACES/<projectId>/` on `main` (with a `projectId`-scoped auth token) while parking all other Workspace repos on their minimal orphan `idle` branch.
2. **Guardrail & Scope Rejection:** Analyze the user's request and discussion thread; **immediately reject** (`status: "rejected"`, `needsAttention: false`) any prompt-injected, hostile, or off-scope request unrelated to the Workspace's data and applications.
3. **Repo Models, Attachments & Tool Discovery:** Inspect all task attachments/images (`read_file`), Workspace `ProjectModel` definitions, `DataSchema`s, repo documentation, and allowed API/MCP schemas.
4. **Deliverable & API Execution:** Produce verified `.md` / `.pdf` / `.csv` reports, compiled `.hbs` Handlebars templates, and/or authorized API payloads & actions.
5. **Attach Artifacts, Reply & Resolve:** Upload deliverables to Workspace `ProjectFile` storage, link them in `WorkItem.contextRefs`, post a sanitized public `WorkItemEvent` reply, and transition `WorkItem`:
   - **`status: "resolved"`** (`needsAttention: false`) — Task completed with artifacts attached.
   - **`status: "pending"`** (`needsAttention: true`) — Clarifying question posted in `WorkItem` comments; surfaces red **`Needs attention`** pill in Inbox.
   - **`status: "failed"`** (`needsAttention: true`) — Cannot complete due to missing data/permissions/upstream blocker; clear reasons posted.
   - **`status: "rejected"`** (`needsAttention: false`) — Rejected by Step 2 Workspace & Security Guardrail.

---

## Isolated Multi-Repo Orchestrator & Standalone Admin Management UI

In addition to single-worker mode, `rapider-task-worker` includes the **Isolated Multi-Repo Task Orchestrator** (`scripts/isolated-task-orchestrator.js`) and **Standalone Admin Task Management & Monitoring UI** (`management-ui/`):

### Key Capabilities
- **Dynamic Live Concurrency (`MAX_CONCURRENT = 1..100`, default `5`)**: Stored in Rapider MongoDB (`TaskOrchestratorState`) and adjustable live from the Management UI or `rapider-task-ctl.js` without restarting workers.
- **Non-Destructive Multi-Repo Staging + 100% Repo Blindness**:
  - Persistent repos (`WORKSPACES/*`, `rapider-apps/APPS/*`, `_repo-cache/*.git`) remain permanently on disk parked on their orphan `idle` branch and are **never deleted**.
  - Each claimed task is staged into `_sandboxes/task-<id>/workspace/` via `git archive <baseSha> | tar -x` -> single-commit `ORCH_BASELINE` local git repo (**zero remotes, zero prior commits, zero other branches, zero uninstalled apps**).
  - Enforced at the OS kernel level on **macOS (`darwin` via `/usr/bin/sandbox-exec`)** and **Ubuntu Linux (`linux` via `bwrap`)**, paired with a `127.0.0.1` ephemeral-nonce capability proxy (`scripts/scoped-task-proxy.js`) so `agy` never sees `.env` files, DB URIs, or JWTs.
- **4-Layer Agent Rules, Skills & Hooks**: Every sandbox receives `/workspace/AGENTS.md` (`< 12 KB`), `TASK_BRIEF.md` with an auto-discovered **Mounted Repo & Docs Index**, modular `.agents/skills/*/SKILL.md` playbooks, and `.agents/hooks.json` (`SessionStart` + `Stop` confidentiality/deliverable verification gate).
- **Private S3 Logs via `s3-file.service.ts`**: Uploads `.log`, `stream-json` `.jsonl` trajectories, and git `.patch` diffs privately (`isPublic = false`) to DigitalOcean Spaces (with automatic offline `/_offline-spaces` fallback).

### Quick Start (Local macOS & Ubuntu Linux)

```bash
# 1. Start the Isolated Multi-Repo Task Orchestrator Daemon
cd rapider-task-worker
npm run orchestrator

# 2. Start the Standalone Admin Management & Monitoring UI (http://localhost:4310)
npm run ui

# 3. Operator CLI Controls
npm run ctl -- status
npm run ctl -- set-concurrency 8
npm run ctl -- pause
npm run ctl -- resume
npm run ctl -- pin-top <workItemId>
npm run ctl -- logs <workItemId> --type=log
```

For Ubuntu 22.04 / 24.04 LTS server provisioning (`bwrap` + `systemd` units), see `deploy/ubuntu-setup.sh`, `deploy/rapider-task-orchestrator.service`, and `deploy/rapider-task-management-ui.service`.

---

## `package.json` Scripts Reference

All orchestrator, management UI, operator CLI, workspace repo parking, and verification commands are exposed in [`package.json`](file:///Users/tanselozkusaksiz/Projects/Rappider/code/_rapider-monorepo/rapider-task-worker/package.json):

### 1. Isolated Multi-Repo Orchestrator & Standalone Admin UI

| Script | Command | Description |
| :--- | :--- | :--- |
| `npm run orchestrator` | `node scripts/isolated-task-orchestrator.js` | Starts the continuous Isolated Multi-Repo Orchestrator daemon (polls MongoDB state, stages sandboxes up to live `MAX_CONCURRENT`, harvests diffs, uploads private S3 logs). |
| `npm run orchestrator:once` | `node scripts/isolated-task-orchestrator.js --once` | Runs a single poll/claim/execute drain cycle and exits cleanly. |
| `npm run orchestrator:offline` | `node scripts/isolated-task-orchestrator.js --offline` | Runs continuous orchestrator in local/offline mode (skips remote `git fetch`/`git push`, uses local repo cache). |
| `npm run orchestrator:once:offline` | `node scripts/isolated-task-orchestrator.js --once --offline` | Runs a single offline cycle on local macOS/Linux for testing without internet. |
| `npm run ui` | `node management-ui/server.js` | Starts the Standalone Admin Task Management & Monitoring UI on `http://127.0.0.1:4310` (`admin` scope required). |

### 2. Operator Control CLI (`ctl:*`)

| Script | Example Usage | Description |
| :--- | :--- | :--- |
| `npm run ctl` | `npm run ctl -- <subcommand>` | Invokes `scripts/rapider-task-ctl.js` with any subcommand. |
| `npm run ctl:status` | `npm run ctl:status` | Displays orchestrator state (`maxConcurrent`, pause flags, active workers), running tasks, and next 20 queued tasks. |
| `npm run ctl:history` | `npm run ctl:history` | Lists the last 20 past task executions (`TaskExecutionRecord`) with exit codes, durations, and S3 keys. |
| `npm run ctl:pause` | `npm run ctl:pause` | Soft-pauses new task claims; running workers finish gracefully. |
| `npm run ctl:hard-pause` | `npm run ctl:hard-pause` | Hard-pauses new claims **and** sends `SIGTERM -> SIGKILL` to all active sandboxes. |
| `npm run ctl:resume` | `npm run ctl:resume` | Clears `paused` and `hardPaused` flags to resume normal scheduling. |
| `npm run ctl:concurrency` | `npm run ctl:concurrency -- 8` | Updates live `MAX_CONCURRENT` (`1..100`) in Rapider MongoDB immediately. |
| `npm run ctl:pin-top` | `npm run ctl:pin-top -- <workItemId>` | Moves a queued task to position #1 (`queueOrder = min - 1000`). |
| `npm run ctl:kill-task` | `npm run ctl:kill-task -- <workItemId>` | Enqueues an immediate `kill_task` signal for a running task. |
| `npm run ctl:requeue-top` | `npm run ctl:requeue-top -- <workItemId>` | Re-opens a failed/killed/completed task and pins it to the top of the queue. |
| `npm run ctl:logs` | `npm run ctl:logs -- <workItemId> --type=log` | Fetches and prints private S3 `.log`, `.jsonl`, or `.patch` content (`--type=log\|jsonl\|patch`). |
| `npm run ctl:cache-status` | `npm run ctl:cache-status` | Inspects local `_repo-cache/*.git` mirrors, `WORKSPACES/*`, and `APPS/*` idle/parking status. |

### 3. Workspace Repo Parking, Single-Worker Helpers, Tests & Provisioning

| Script | Command | Description |
| :--- | :--- | :--- |
| `npm run status` | `node scripts/manage-workspace-repos.js --status` | Shows active vs. `idle`-parked branch status across `WORKSPACES/` and `rapider-apps/APPS/`. |
| `npm run activate` | `node scripts/manage-workspace-repos.js <projectId>` | Activates a single Workspace repo on `main` while parking all others on orphan `idle`. |
| `npm run park:all` | `node scripts/manage-workspace-repos.js --park-all` | Parks every Workspace and App repository onto its minimal `README.md`-only `idle` branch. |
| `npm run fetch-tasks` | `node scripts/fetch-and-validate-tasks.js --limit=5` | Fetches and validates the next batch of open tasks ordered by `(queueOrder ASC, createdDate ASC)`. |
| `npm run fetch-tasks:all` | `node scripts/fetch-and-validate-tasks.js --all` | Lists and validates all open tasks across Workspaces. |
| `npm run worker` / `worker:1m` / `worker:once` / `worker:headless` | `node scripts/task-worker-daemon.js ...` | Legacy single-worker sequential FIFO daemon modes. |
| `npm run workspace:tools` | `node scripts/workspace-tools-cli.js` | Direct CLI for Workspace models, schemas, DB records, and Handlebars compilation checks. |
| `npm run upload-artifact` | `node scripts/upload-task-artifacts.js` | Uploads deliverable files to Workspace `ProjectFile` storage. |
| `npm run patch-task` | `node scripts/patch-workitem-task.js` | Posts `WorkItemEvent` replies and transitions `WorkItem` status. |
| `npm run logs:sync` | `node scripts/generate-iteration-logs.js` | Synchronizes markdown iteration audit logs under `logs/`. |
| `npm test` | `node --test tests/*.test.js` | Runs the complete automated test suite (including OS kernel sandbox isolation checks). |
| `npm run test:orchestrator` | `node --test tests/isolated-orchestrator.test.js` | Runs the 11-test Isolated Multi-Repo Orchestrator & Seatbelt/Bubblewrap suite. |
| `npm run ubuntu:setup` | `bash deploy/ubuntu-setup.sh` | Provisions Ubuntu 22.04/24.04 LTS (`bubblewrap`, unprivileged `rapider-orch` user, `systemd` services). |

---

## Documentation & Rules Index

- **[ISOLATED_TASK_ORCHESTRATOR_GUIDE.md](file:///Users/tanselozkusaksiz/Projects/Rappider/code/_rapider-monorepo/rapider-task-worker/ISOLATED_TASK_ORCHESTRATOR_GUIDE.md)** — **Master Implementation & Operations Guide**: full architecture, dynamic `MAX_CONCURRENT`, non-destructive multi-repo staging, macOS Seatbelt + Linux Bubblewrap OS jailing, `127.0.0.1` capability proxy, 4-layer agent rules/skills/hooks, private S3 logging, complete `package.json` scripts reference, and Mac/Ubuntu deployment steps.
- **[management-ui/README.md](file:///Users/tanselozkusaksiz/Projects/Rappider/code/_rapider-monorepo/rapider-task-worker/management-ui/README.md)** — **Standalone Admin Task Management & Monitoring UI Guide**: Rapider login + `admin` permission enforcement (`403`), live concurrency & pause controls, Active/Next-20 queue reordering & Pin-to-Top, Last-20 execution history, and S3 `.log`/`.jsonl`/`.patch` viewer.
- **[../rapider-server/documentation/task-orchestrator-admin-api.md](file:///Users/tanselozkusaksiz/Projects/Rappider/code/_rapider-monorepo/rapider-server/documentation/task-orchestrator-admin-api.md)** — **Backend Admin API & MongoDB/S3 Specification**: LoopBack 4 models (`TaskOrchestratorState`, `TaskExecutionRecord`, `WorkItem.queueOrder`), `TaskOrchestratorAdminController` endpoints, and private `s3-file.service.ts` key layout.
- **[AGENTS.md](file:///Users/tanselozkusaksiz/Projects/Rappider/code/_rapider-monorepo/rapider-task-worker/AGENTS.md)** — Mandatory host/worker agent rules, zero-tolerance security/secrets policy, guardrail matrix, capability standards, and public reply confidentiality rules.
- **[scripts/sandbox-tools/SANDBOX_AGENTS.md](file:///Users/tanselozkusaksiz/Projects/Rappider/code/_rapider-monorepo/rapider-task-worker/scripts/sandbox-tools/SANDBOX_AGENTS.md)** — Concise (`< 12 KB`) Level-1 `AGENTS.md` injected into `/workspace/AGENTS.md` inside every isolated task sandbox alongside `.agents/skills/*/SKILL.md` and `.agents/hooks.json`.
- **[TASK_WORKER_AUTOMATION_GUIDE.md](file:///Users/tanselozkusaksiz/Projects/Rappider/code/_rapider-monorepo/rapider-task-worker/TASK_WORKER_AUTOMATION_GUIDE.md)** — Single-worker lifecycle guide, Mermaid state/pipeline diagrams, REST API contracts, batch-of-5 FIFO drain design, and orphan `idle` branch protocol.
- **[TASK_WORKER_AUTOMATION_CRON_JOB.md](file:///Users/tanselozkusaksiz/Projects/Rappider/code/_rapider-monorepo/rapider-task-worker/TASK_WORKER_AUTOMATION_CRON_JOB.md)** — Copy-pasteable `/schedule` Antigravity IDE cron command (`*/5 * * * *`) for autonomous batch-of-5 background execution.
- **[_planning/rapider_isolated_task_orchestrator_detailed_implementation_plan.md](file:///Users/tanselozkusaksiz/Projects/Rappider/code/_rapider-monorepo/rapider-task-worker/_planning/rapider_isolated_task_orchestrator_detailed_implementation_plan.md)** — Detailed 5-phase engineering design & implementation plan combining MongoDB state, private S3 logs, standalone Admin UI, and cross-platform OS sandboxing.
- **[_planning/agy_isolated_multi_repo_orchestrator_implementation_specification.md](file:///Users/tanselozkusaksiz/Projects/Rappider/code/_rapider-monorepo/rapider-task-worker/_planning/agy_isolated_multi_repo_orchestrator_implementation_specification.md)** — Foundational specification for isolated multi-repository `agy` sandboxing, baseline `git archive` staging, and patch harvesting.

---

## Directory Structure

```text
rapider-task-worker/
├── README.md                           # Overview, quick start, scripts table & markdown docs index
├── ISOLATED_TASK_ORCHESTRATOR_GUIDE.md # Complete architecture, scripts, sandbox & Ubuntu deployment guide
├── AGENTS.md                           # Canonical rules & guardrails for ISOLATED-TASK-WORKER
├── TASK_WORKER_AUTOMATION_GUIDE.md     # Single-worker lifecycle, REST contracts & idle branch protocol
├── TASK_WORKER_AUTOMATION_CRON_JOB.md  # Scheduled /schedule cron job prompt & workflow
├── .env.example                        # Environment variable template (NEVER commit real .env)
├── management-ui/                      # Standalone Admin Task Management & Monitoring Web UI (port 4310)
│   ├── README.md                       # Management UI usage, auth gate & env config
│   ├── package.json                    # UI start / dev / healthcheck scripts
│   ├── server.js                       # Static server + zero-secret /api/* reverse proxy
│   └── public/                         # Offline-ready SPA (index.html, app.js, styles.css, local vendor/)
├── deploy/                             # Ubuntu 22.04/24.04 provisioning & systemd service units
│   ├── ubuntu-setup.sh
│   ├── rapider-task-orchestrator.service
│   └── rapider-task-management-ui.service
├── scripts/                            # Orchestrator, OS sandbox runner, proxy, CLI & workspace helpers
│   ├── isolated-task-orchestrator.js   # Parallel multi-repo daemon (dynamic MAX_CONCURRENT)
│   ├── stage-task-sandbox.js           # git archive -> single-commit ORCH_BASELINE sandbox builder
│   ├── sandbox-runner.js               # macOS sandbox-exec & Linux bwrap launcher + trajectory logger
│   ├── scoped-task-proxy.js            # 127.0.0.1 ephemeral-nonce capability proxy
│   ├── harvest-repo-changes.js         # Post-run diff/patch harvester -> task/<id> branch publisher
│   ├── rapider-task-ctl.js             # Operator CLI (status, pause, concurrency, pin-top, logs)
│   └── sandbox-tools/                  # Jailed CLI, SANDBOX_AGENTS.md, skills/ & hooks/
├── tests/                              # Automated unit & OS kernel sandbox isolation tests
├── _planning/                          # Architectural specifications & implementation plans
├── WORKSPACES/                         # Persistent per-projectId workspace repos (parked on 'idle')
├── _repo-cache/                        # Bare git mirrors for fast local/offline staging (gitignored)
├── _sandboxes/                         # Ephemeral per-task OS-jailed workspaces (gitignored)
├── _artifacts/                         # Temporary per-task computation & deliverables (gitignored)
├── _process-logs/                      # Downloaded task attachments & daily execution ledgers
└── logs/                               # Iteration audit logs
```
