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

## Documentation & Rules Index

- **[AGENTS.md](file:///Users/tanselozkusaksiz/Projects/Rappider/code/_rapider-monorepo/rapider-task-worker/AGENTS.md)** — Mandatory agent rules, zero-tolerance security/secrets policy, guardrail matrix, capability standards, and public reply confidentiality rules.
- **[TASK_WORKER_AUTOMATION_GUIDE.md](file:///Users/tanselozkusaksiz/Projects/Rappider/code/_rapider-monorepo/rapider-task-worker/TASK_WORKER_AUTOMATION_GUIDE.md)** — Full system architecture, Mermaid state/pipeline diagrams, REST API contracts, batch-of-5 FIFO drain design, orphan `idle` branch protocol, and CLI reference.
- **[TASK_WORKER_AUTOMATION_CRON_JOB.md](file:///Users/tanselozkusaksiz/Projects/Rappider/code/_rapider-monorepo/rapider-task-worker/TASK_WORKER_AUTOMATION_CRON_JOB.md)** — Copy-pasteable `/schedule` Antigravity IDE cron command (`*/5 * * * *`) for autonomous batch-of-5 background execution.

---

## Directory Structure

```text
rapider-task-worker/
├── AGENTS.md                           # Canonical rules & guardrails for ISOLATED-TASK-WORKER
├── TASK_WORKER_AUTOMATION_GUIDE.md     # Full lifecycle, REST contracts & repo isolation architecture
├── TASK_WORKER_AUTOMATION_CRON_JOB.md  # Scheduled /schedule cron job prompt & workflow
├── .env.example                        # Environment variable template (NEVER commit real .env)
├── scripts/                            # CLI helpers (fetch-tasks, manage-workspace-repos, patch-workitem)
├── WORKSPACES/                         # Isolated per-projectId workspace clones (1 active, N-1 on 'idle')
├── _artifacts/                         # Temporary per-task computation & generated deliverables (gitignored)
├── _process-logs/
│   ├── task-attachments/               # Downloaded task input files & S3 screenshots (gitignored)
│   └── execution/
│       └── daily-task-executions/      # Daily JSON execution ledgers (task-executions-YYYY-MM-DD.json)
└── logs/                               # Iteration audit logs (task-worker-agent-log-YYYYMMDD-Iter.md)
```
