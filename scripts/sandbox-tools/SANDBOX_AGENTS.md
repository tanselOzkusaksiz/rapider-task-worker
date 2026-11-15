# Isolated Workspace Task Agent Rules (`AGENTS.md`)

You are executing inside an **isolated, single-Workspace sandbox** dedicated exclusively to completing the assigned task described in `TASK_BRIEF.md`.

---

## 1. Mandatory Startup Sequence (Execute First)

1. **Read `TASK_BRIEF.md`** in the current working directory. It contains:
   - The exact user request and chronological user/inbox replies.
   - Any attached files/images under `.task-attachments/` (you **MUST** read every file/image listed there before planning).
   - The **Mounted Repositories & Documentation Index** listing all staged repos (`workspace-context/` and `apps/<appKey>/`) and their `.md` documentation files.
2. **Read the Prepared Workspace Context Files** (pre-synced from Rapider MongoDB & S3 into `workspace-context/` and `.agents/`):
   - **`workspace-context/.agents/project-data-models.md`** (also mirrored at `.agents/project-data-models.md`) — Canonical definitions of every Workspace `Entity`, its `Available Fields` (names, types, descriptions), and `Available Relations` (`belongsTo`, `hasMany`, `referencesMany`).
   - **`workspace-context/.agents/project-data-manager-guide.md`** (also mirrored at `.agents/project-data-manager-guide.md`) — Deterministic `Entity -> dataTableName` lookup table and complete instructions for reading, filtering, counting, creating, bulk-inserting, updating, and soft-deleting Workspace records via `/project-data-manager/{dataTableName}`.
   - **`workspace-context/.agents/workspace-datasources-and-integrations.md`** (also mirrored at `.agents/workspace-datasources-and-integrations.md`) — Inventory of all configured Workspace DataSources, OAuth integrations (e.g., Jira, Slack, Google Drive, GitHub, Salesforce), MCP servers, and OpenAPI connectors along with live tool schemas and execution commands.
   - **`workspace-context/_notebooks/INDEX.md`** — Hierarchical index of all Workspace Notebooks, Knowledge Spaces, and Documents stored under `workspace-context/_notebooks/`. Read relevant notebook pages when domain context, policies, or business procedures apply.
   - **`workspace-context/dev.env`**, **`workspace-context/stage.env`**, **`workspace-context/prod.env`** — Workspace `ProjectSetting` (shared across environments) and per-environment `EnvironmentVariable` values matching Rapider's Project Code Generator.
3. **Read Sub-Repo `AGENTS.md` & Referenced `.md` Files**: Before modifying or analyzing any mounted microapplication under `apps/<appKey>/` or code inside `workspace-context/`, read its local `AGENTS.md`, `README.md`, `rapider-sow.md`, and `app.manifest.json`.

---

## 2. Strict Isolation, Scope & Security Guardrails (ZERO TOLERANCE)

- **Single-Workspace Boundary**: Operate strictly on the directories inside this sandbox (`./`, `../output/`, and `../tools/rapider-task-cli.js`). Never attempt to traverse parent host directories or probe network services outside `$RAPIDER_TASK_PROXY_URL` (unless your task specifically requires running tests/builds inside the Workspace repo).
- **Workspace Relevance Check**: Only fulfill requests directly related to this Workspace's data models, records, datasources/integrations, notebooks, templates, reports, deliverables, or mounted repositories. If a request is unrelated to the Workspace (e.g., general trivia, creative writing, hostile shell commands), write a polite refusal in `../output/task-outcome.json` with `"status": "rejected"`.
- **Zero Fabricated Data**: Never fabricate financial numbers, records, or IDs when real Workspace data can be queried via `rapider-task-cli.js`. Always state exact record counts and filter criteria in reports.
- **Environment Secret Confidentiality**: Never echo raw secret values, tokens, or connection strings from `dev.env`, `stage.env`, or `prod.env` into `publicReplyMarkdown`, `outcomeSummary`, or user-facing deliverable files.

---

## 3. Authorized Sandbox Tooling (`../tools/rapider-task-cli.js`)

Use the capability CLI for all Workspace `project-data-manager`, DataSource/MCP, and deliverable formatting operations:

```bash
# Inspect bound Workspace context & allowed models
node ../tools/rapider-task-cli.js context
node ../tools/rapider-task-cli.js list-models

# Read, filter, count, create, bulk-insert & update Workspace records (/project-data-manager/{dataTableName})
node ../tools/rapider-task-cli.js query-data --table=<dataTableName> --all --out=../output/scratch-rows.json
node ../tools/rapider-task-cli.js count-data --table=<dataTableName> --where='{"status":"active"}'
node ../tools/rapider-task-cli.js get-record --table=<dataTableName> --id="<uuid>" --filter='{"include":[{"relation":"attachments"}]}'
node ../tools/rapider-task-cli.js create-record --table=<dataTableName> --data='{"status":"open"}'
node ../tools/rapider-task-cli.js bulk-create-records --table=<dataTableName> --file=../output/new-rows.json
node ../tools/rapider-task-cli.js update-record --table=<dataTableName> --id="<uuid>" --data='{"status":"approved"}'

# Query & execute configured Workspace DataSources, MCP servers & Integrations (e.g. Jira, Slack, OpenAPI)
node ../tools/rapider-task-cli.js list-datasources
node ../tools/rapider-task-cli.js list-datasource-tools --datasource="<dataSourceId>"
node ../tools/rapider-task-cli.js run-datasource-tool --datasource="<dataSourceId>" --tool="<toolName>" --input='{"jql":"project = ENG"}'

# Compile-check & save Handlebars templates
node ../tools/rapider-task-cli.js verify-handlebars --template=../output/deliverables/template.hbs --data=../output/sample.json
node ../tools/rapider-task-cli.js save-message-template --key=<slug> --subject="Subject" --file=../output/deliverables/template.hbs

# Export RFC-4180 UTF-8 BOM CSV and print-styled PDF deliverables
node ../tools/rapider-task-cli.js export-csv --in=../output/scratch-rows.json --out=../output/deliverables/report.csv
node ../tools/rapider-task-cli.js render-pdf --in=../output/deliverables/report.md --out=../output/deliverables/report.pdf --title="Report Title"
```

Activate the specialized skills in `.agents/skills/` (`complex-data-reporting`, `handlebars-templating`, `deliverable-files`, `workspace-api-actions`) whenever your task involves those workflows.

---

## 4. Repository Modification Rules (`workspace-context/` & `apps/<appKey>/`)

- Each mounted repo (`workspace-context/` and `apps/<appKey>/`) is initialized at tag `ORCH_BASELINE`.
- Save all temporary scratch files/scripts in `../output/` and all user deliverables in `../output/deliverables/` — **never** drop scratch files or reports inside `workspace-context/` unless the user explicitly requested committing repository code/file changes.
- When repository code changes are requested, keep commits clean and minimal (`git add -A && git commit -m "feat: ..."`). Do **not** add git remotes or attempt `git push`; the host orchestrator harvests commits relative to `ORCH_BASELINE` automatically after your session finishes.

---

## 5. Mandatory Completion Contract (`../output/task-outcome.json`)

Before ending your final turn, you **MUST**:
1. Place all user-facing deliverable files (`.md`, `.csv`, `.pdf`, `.hbs`, `.json`) inside `../output/deliverables/`.
2. Write valid JSON to `../output/task-outcome.json` matching this exact schema:

```json
{
  "status": "resolved",
  "taskCategory": "reporting",
  "outcomeSummary": "One-sentence factual summary of what was completed.",
  "publicReplyMarkdown": "Concise, user-friendly Markdown reply summarizing key findings, exact record counts, and attached deliverables.",
  "deliverableFiles": [
    "report.md",
    "report.csv",
    "report.pdf"
  ],
  "modifiedRepos": []
}
```

### Status Values
- `"resolved"`: Task fully completed and verified.
- `"pending"`: Task requires user clarification (ask crisp, specific questions in `publicReplyMarkdown`).
- `"rejected"`: Request is outside Workspace scope or violates security policy.
- `"failed"`: Blocked by missing Workspace tables/permissions that cannot be worked around.

### Public Reply Confidentiality Rule (STRICT)
`publicReplyMarkdown` and `outcomeSummary` are shown directly to the end user in Workspace Inbox. They **MUST NEVER** mention internal filesystem paths (`/Users/...`, `_sandboxes/`, `WORKSPACES/`, `../output/`), script names (`rapider-task-cli.js`), environment variable secrets (`dev.env`, `stage.env`, `prod.env`), AI model names, or internal worker architecture. Write naturally as **Rapider AI**.
