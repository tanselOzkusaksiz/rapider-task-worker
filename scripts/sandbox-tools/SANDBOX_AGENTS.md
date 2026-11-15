# Isolated Workspace Task Agent Rules (`AGENTS.md`)

You are executing inside an **isolated, single-Workspace sandbox** dedicated exclusively to completing the assigned task described in `TASK_BRIEF.md`.

---

## 1. Mandatory Startup Sequence (Execute First)

1. **Read `TASK_BRIEF.md`** in the current working directory. It contains:
   - The exact user request and chronological user/inbox replies.
   - Any attached files/images under `.task-attachments/` (you **MUST** read every file/image listed there before planning).
   - The **Mounted Repositories & Documentation Index** listing all staged repos (`workspace-context/` and `apps/<appKey>/`) and their `.md` documentation files.
2. **Read the Prepared Workspace Context Files** (pre-synced from Rapider MongoDB & S3 into `workspace-context/` and `.agents/`):
   - **`.agents/project-data-manager-guide.md`** — Read this **FIRST** for the complete `Entity -> Model Name -> dataTableName` lookup table and `/project-data-manager/{dataTableName}` query syntax!
   - **`.agents/project-data-models.md`** — Canonical definitions of every Workspace `Entity`, its `Available Fields`, and `Available Relations`. **Efficiency rule:** On large Workspaces this file can exceed 4,000 lines — do **not** read the entire file chunk-by-chunk; instead locate only the specific entities you need from `.agents/project-data-manager-guide.md` or search by `Entity:` heading.
   - **`.agents/workspace-datasources-and-integrations.md`** — Inventory of all configured Workspace DataSources, OAuth integrations (e.g., Jira, Slack, Google Drive, GitHub, Salesforce), MCP servers, and OpenAPI connectors along with live tool schemas and execution commands.
   - **`workspace-context/_notebooks/INDEX.md`** — Hierarchical index of all Workspace Notebooks, Knowledge Spaces, and Documents stored under `workspace-context/_notebooks/`. Read relevant notebook pages when domain context, policies, or business procedures apply.
   - **`workspace-context/dev.env`**, **`workspace-context/stage.env`**, **`workspace-context/prod.env`** — Workspace `ProjectSetting` (shared across environments) and per-environment `EnvironmentVariable` values matching Rapider's Project Code Generator.
   - **Data Analysis Speed Rule:** When analyzing multiple tables, write a single fast Node.js aggregation script in `../output/analyze.js` that queries only the target `dataTableName`s, computes exact totals/breakdowns, and writes the `.html` and `.csv` deliverables directly — avoid calling `read_file` on multi-hundred-KB raw JSON dumps, and pass `WaitMsBeforeAsync: 10000` on `run_command` so short scripts return synchronously in one turn!
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

# Export RFC-4180 UTF-8 BOM CSV, validate Executive HTML reports, and (if explicitly requested) render PDF
node ../tools/rapider-task-cli.js export-csv --in=../output/scratch-rows.json --out=../output/deliverables/report-data.csv
node ../tools/rapider-task-cli.js verify-html --in=../output/deliverables/executive-report.html
node ../tools/rapider-task-cli.js render-pdf --in=../output/deliverables/report.md --out=../output/deliverables/report.pdf --title="Report Title"
```

Activate the specialized skills in `.agents/skills/` (`complex-data-reporting`, `handlebars-templating`, `deliverable-files`, `workspace-api-actions`) whenever your task involves those workflows.

---

## 3b. Default Deliverable Format Standard (Executive Printable HTML + Companion CSV)

Unless the user explicitly requests **only** a specific format (e.g., "CSV only", "Markdown only", or "PDF only"):
1. **Default Primary Output = Executive Self-Contained `.html` Page (`../output/deliverables/<slug>.html`)**:
   - Rapider Inbox renders `.html` deliverables directly inside an interactive **HTML Preview** pane with Print and Fullscreen controls.
   - Include `<script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4"></script>` in `<head>` for crisp Tailwind CSS styling, plus `@media print` rules (`.no-print { display: none !important; }`, `print-color-adjust: exact`, `break-inside: avoid`) and a top-right `<button onclick="window.print()" class="no-print ... bg-indigo-600 !text-white text-white" style="color: #ffffff !important;">Print / Save as PDF</button>`.
   - Structure every report with: **(a) Executive Summary & Headline KPI Cards**, **(b) Crisp Inline `<svg>` Charts** (e.g., 12-month forecast bar/line chart, Best vs. Worst Case comparison bars, or category breakdown), **(c) Clean Tabular Schedules** (`tabular-nums` right-aligned currency/numbers, status badges, bold `<tfoot>` totals), and **(d) Methodology & Data Notes**.
   - Run `node ../tools/rapider-task-cli.js verify-html --in=../output/deliverables/<slug>.html` to verify clean HTML structure and zero `NaN` / `[object Object]` defects.
2. **Companion `.csv` Data Exports**:
   - Whenever tabular datasets, monthly projections, or line-item schedules are computed, **also** export companion `.csv` file(s) (`export-csv`) into `../output/deliverables/` so users can download raw spreadsheet data alongside the interactive HTML report.
3. **List `.html` First in `deliverableFiles`**:
   - Put the primary `.html` report first in `deliverableFiles` inside `../output/task-outcome.json` so Rapider Inbox auto-previews it immediately. Keep `publicReplyMarkdown` concise (3–6 bullet highlights + executive summary) rather than duplicating giant multi-hundred-row tables that are already rendered in the HTML report.

---

## 4. Repository Modification Rules (`workspace-context/` & `apps/<appKey>/`)

- Each mounted repo (`workspace-context/` and `apps/<appKey>/`) is initialized at tag `ORCH_BASELINE`.
- Save all temporary scratch files/scripts in `../output/` and all user deliverables in `../output/deliverables/` — **never** drop scratch files or reports inside `workspace-context/` unless the user explicitly requested committing repository code/file changes.
- When repository code changes are requested, keep commits clean and minimal (`git add -A && git commit -m "feat: ..."`). Do **not** add git remotes or attempt `git push`; the host orchestrator harvests commits relative to `ORCH_BASELINE` automatically after your session finishes.

---

## 5. Mandatory Completion Contract (`../output/task-outcome.json`)

Before ending your final turn, you **MUST**:
1. Place all user-facing deliverable files (`.html`, `.csv`, `.pdf`, `.md`, `.hbs`, `.json`) inside `../output/deliverables/`.
2. Write valid JSON to `../output/task-outcome.json` matching this exact schema:

```json
{
  "status": "resolved",
  "taskCategory": "reporting",
  "outcomeSummary": "One-sentence factual summary of what was completed.",
  "aiRecommendationMarkdown": "2-4 concise, actionable recommendations or next steps for the user based on the findings.",
  "publicReplyMarkdown": "Concise executive highlights summarizing key metrics, record counts, and the interactive HTML + CSV deliverables.",
  "deliverableFiles": [
    "executive-report.html",
    "report-schedule.csv"
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
