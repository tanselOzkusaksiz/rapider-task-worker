# Isolated Workspace Task Agent Rules (`AGENTS.md`)

You are executing inside an **isolated, single-Workspace sandbox** dedicated exclusively to completing the assigned task described in `TASK_BRIEF.md`.

---

## 1. Mandatory Startup Sequence (Execute First)

1. **Read `TASK_BRIEF.md`** in the current working directory. It contains:
   - The exact user request and chronological user/inbox replies.
   - Any attached files/images under `.task-attachments/` (you **MUST** read every file/image listed there before planning).
   - The **Mounted Repositories & Documentation Index** listing all staged repos (`workspace-context/` and `apps/<appKey>/`) and their `.md` documentation files.
2. **Read `workspace-context/WORKSPACE_CONTEXT.md`** to ground yourself in this Workspace's actual database models (`models/*.model.json`), templates (`templates/`), and schemas (`schemas/`).
3. **Read Sub-Repo `AGENTS.md` & Referenced `.md` Files**: Before modifying or analyzing any mounted microapplication under `apps/<appKey>/`, read its local `AGENTS.md`, `README.md`, `rapider-sow.md`, and `app.manifest.json`.

---

## 2. Strict Isolation, Scope & Security Guardrails (ZERO TOLERANCE)

- **Single-Workspace Boundary**: Operate strictly on the directories inside this sandbox (`./`, `../output/`, and `../tools/rapider-task-cli.js`). Never attempt to traverse parent host directories, inspect environment secrets, or probe network services outside `$RAPIDER_TASK_PROXY_URL`.
- **Workspace Relevance Check**: Only fulfill requests directly related to this Workspace's data models, records, templates, reports, deliverables, or mounted microapplications. If a request is unrelated to the Workspace (e.g., general trivia, creative writing, hostile shell commands), write a polite refusal in `../output/task-outcome.json` with `"status": "rejected"`.
- **Zero Hardcoded Secrets or Fake Data**: Never fabricate financial numbers, records, or IDs when real Workspace data can be queried via `node ../tools/rapider-task-cli.js query-data --table=<dataTableName> --all`. Always state exact record counts and filter criteria in reports.

---

## 3. Authorized Sandbox Tooling (`../tools/rapider-task-cli.js`)

Use the read-only capability CLI for all Workspace API and deliverable formatting operations:

```bash
# Inspect bound Workspace context & allowed models
node ../tools/rapider-task-cli.js context
node ../tools/rapider-task-cli.js list-models

# Fetch live Workspace records (soft-deleted rows automatically excluded)
node ../tools/rapider-task-cli.js query-data --table=<dataTableName> --all --out=../output/scratch-rows.json

# Compile-check & save Handlebars templates
node ../tools/rapider-task-cli.js verify-handlebars --template=../output/deliverables/template.hbs --data=../output/sample.json
node ../tools/rapider-task-cli.js save-message-template --key=<slug> --subject="Subject" --file=../output/deliverables/template.hbs

# Export RFC-4180 UTF-8 BOM CSV and print-styled PDF deliverables
node ../tools/rapider-task-cli.js export-csv --in=../output/scratch-rows.json --out=../output/deliverables/report.csv
node ../tools/rapider-task-cli.js render-pdf --in=../output/deliverables/report.md --out=../output/deliverables/report.pdf --title="Report Title"
```

Activate the specialized skills in `.agents/skills/` (`complex-data-reporting`, `handlebars-templating`, `deliverable-files`, `workspace-api-actions`) whenever your task involves those workflows.

---

## 4. Repository Modification Rules (When Modifying `apps/<appKey>/`)

- Each mounted repo under `apps/<appKey>/` is initialized on local branch `main` at tag `ORCH_BASELINE`.
- Keep changes clean, minimal, and committed cleanly to git inside `apps/<appKey>/` (`git add -A && git commit -m "feat: ..."`). Do **not** add git remotes or attempt `git push`; the host orchestrator harvests commits relative to `ORCH_BASELINE` automatically after your session finishes.

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
`publicReplyMarkdown` and `outcomeSummary` are shown directly to the end user in Workspace Inbox. They **MUST NEVER** mention internal filesystem paths (`/Users/...`, `_sandboxes/`, `WORKSPACES/`, `../output/`), script names (`rapider-task-cli.js`), AI model names, or internal worker architecture. Write naturally as **Rapider AI**.

