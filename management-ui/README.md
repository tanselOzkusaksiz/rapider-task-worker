# Rapider Task Orchestrator — Standalone Admin Management & Monitoring UI (`management-ui`)

Standalone, zero-external-dependency Admin Web UI and reverse API proxy for monitoring and controlling the **Rapider Isolated Multi-Repo Task Orchestrator** (`rapider-task-worker`).

---

## Key Capabilities

1. **Rapider User Login + Strict `admin` Scope Gate (`403 Forbidden`)**
   - Sign in with your standard Rapider / Rapider UI credentials (`POST /users/login`).
   - Both the browser session guard and every `/task-orchestrator-admin/*` backend endpoint strictly enforce `PermissionScope.Admin` (`scope.includes('admin')`). Non-admin accounts immediately receive HTTP `403` and are signed out of the UI.
   - `server.js` forwards **only** the caller's `Authorization` header to `RAPIDER_BACKEND_URL` — zero server-side tokens or secrets are ever injected or stored on disk.

2. **Live Global Orchestrator Controls (Rapider MongoDB `TaskOrchestratorState`)**
   - **Dynamic `MAX_CONCURRENT` (`1..100`, default `5`)**: Adjust worker concurrency live without restarting `isolated-task-orchestrator.js`.
   - **Live Default Model Selector (`Default Model`, default `gemini-3.8-flash-medium`)**: Switch the default `agy --model` used across all workers live via `PATCH /admin/task-orchestrator/config` (never modifies global `~/.gemini/antigravity-cli/settings.json`).
   - **Soft Pause / Hard Pause / Resume**:
     - *Soft Pause*: Stops claiming new tasks while allowing active sandboxes to finish cleanly.
     - *Hard Pause*: Stops claiming new tasks **and** broadcasts `SIGTERM -> SIGKILL` to every running worker process group.
   - **Poll Interval & Sandbox Retention**: Tune `pollIntervalSeconds` (`2..300s`) and `sandboxRetentionCount` (`0..100`) live.
   - **Active Workers Heartbeat Bar**: Inspect live worker hostnames, PIDs, OS (`darwin` / `linux`), active task slots, observed model, and last heartbeat timestamps.

3. **Tab 1 — Active & Upcoming Queue (`Running` + `Next 20`)**
   - **Currently In-Progress Tasks**: Live elapsed runtime, Workspace name, active model badge (`resolvedModel`), worker ID/PID, mounted repos, **inline verbatim User Request + Task Context preview**, **Context** inspector button, **Logs** button, and one-click **Kill** (`kill_task` signal).
   - **Next 20 Queued Tasks**: Ordered deterministically by `(queueOrder ASC, createdDate ASC)`, displaying title, verbatim `User asked` prompt, stripped Markdown description preview, and an **inline per-task Model dropdown** (`PATCH /admin/task-orchestrator/tasks/{id}/model`) to pin a specific model or leave on `Default`.
   - **Queue Ordering Controls**:
     - **Drag-and-Drop Row Reordering** + `▲` / `▼` step buttons (`PATCH /admin/task-orchestrator/queue/reorder`).
     - **Pin to Top** (`#1`) — sets `queueOrder = min(queueOrder) - 1000`.
     - **+ New Task Modal** (`POST /admin/task-orchestrator/queue/tasks`) — select any Workspace (`Project`), optionally choose a task-specific **Task Model** (or `Use Default`), specify title, Markdown prompt/instructions, and immediately enqueue at the top (`pinToTop: true`) or bottom of the queue.

4. **Tab 2 — Execution History (`Last 20`) & Slide-Over Task Inspector Drawer**
   - **Last 20 Past Executions**: Displays `completed` / `resolved`, `failed`, `killed`, `rejected`, `cancelled`, and `pending` runs with verbatim user prompt, outcome preview, durations, harvested branch names, and deliverable file counts.
   - **Re-queue #1**: Re-run any failed/killed/completed task at the front of the queue with one click (`POST /admin/task-orchestrator/tasks/{id}/control`).
   - **Slide-Over Task Inspector & Private S3 Log Drawer**: Clicking any task title or **Context** button opens directly to **`Request & Context`**, alongside private DigitalOcean Spaces log tabs fetched via `s3-file.service.ts` (`isPublic = false`, with offline `_offline-spaces` fallback):
     - **`Request & Context`**: Metadata strip, verbatim **Original User Request** callout, synthesized summary/prior step context, rendered GFM Markdown `bodyMarkdown` (headings, blockquotes, lists, tables, code), execution outcome, and attached deliverables.
     - **`.log`**: Raw `stdout` / `stderr` execution output.
     - **`.jsonl`**: Structured `agy --output-format stream-json` trajectory stream.
     - **`.patch`**: Harvested multi-repo git diff patches (`git format-patch`).
     - **`Live Tail`**: Real-time rolling MongoDB `logTail`.

5. **100% Offline-Ready Assets**
   - Bundles Tailwind CSS (`public/vendor/tailwindcss/tailwind.js`) and FontAwesome (`public/vendor/fontawesome/`) locally so the UI works seamlessly on air-gapped networks or without internet access.

---

## Scripts (`package.json`)

From `rapider-task-worker/` (root):

```bash
npm run ui
```

Or directly inside `rapider-task-worker/management-ui/`:

| Script | Command | Description |
| :--- | :--- | :--- |
| `npm start` | `node server.js` | Starts the Management UI HTTP server on `http://127.0.0.1:4310` |
| `npm run dev` | `node --watch server.js` | Starts `server.js` in Node watch mode for local UI development |
| `npm run healthcheck` | `curl -fsS http://127.0.0.1:4310/healthz` | Verifies the UI server is up and reports target `backendBaseUrl` |

---

## Environment Variables

No secrets are stored in `management-ui`. Configuration is read from environment variables (or `rapider-task-worker/.env` for `RAPIDER_BACKEND_URL` only):

| Variable | Default | Description |
| :--- | :--- | :--- |
| `MANAGEMENT_UI_HOST` | `127.0.0.1` | Bind address (`127.0.0.1` for local Mac or Nginx reverse proxy on Ubuntu) |
| `MANAGEMENT_UI_PORT` | `4310` | HTTP listen port |
| `RAPIDER_BACKEND_URL` | `http://localhost:8081` | Upstream Rapider LoopBack 4 API URL proxied under `/api/*` |

---

## Related Documentation

- **[Root README (`../README.md`)](../README.md)** — Overview, quick start, `package.json` scripts reference, and full documentation index.
- **[Isolated Task Orchestrator Guide (`../ISOLATED_TASK_ORCHESTRATOR_GUIDE.md`)](../ISOLATED_TASK_ORCHESTRATOR_GUIDE.md)** — Complete architecture, OS sandboxing (`sandbox-exec` & `bwrap`), capability proxy, 4-layer agent rules/hooks, and Ubuntu deployment guide.
- **[Backend Admin API & S3 Logs (`../../rapider-server/documentation/task-orchestrator-admin-api.md`)](../../rapider-server/documentation/task-orchestrator-admin-api.md)** — LoopBack 4 models (`TaskOrchestratorState`, `TaskExecutionRecord`, `WorkItem.queueOrder`), admin REST endpoints, and private S3 storage paths.

