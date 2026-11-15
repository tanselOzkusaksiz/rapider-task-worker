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
   - **Soft Pause / Hard Pause / Resume**:
     - *Soft Pause*: Stops claiming new tasks while allowing active sandboxes to finish cleanly.
     - *Hard Pause*: Stops claiming new tasks **and** broadcasts `SIGTERM -> SIGKILL` to every running worker process group.
   - **Poll Interval & Sandbox Retention**: Tune `pollIntervalSeconds` (`2..300s`) and `sandboxRetentionCount` (`0..100`) live.
   - **Active Workers Heartbeat Bar**: Inspect live worker hostnames, PIDs, OS (`darwin` / `linux`), active task slots, and last heartbeat timestamps.

3. **Tab 1 — Active & Upcoming Queue (`Running` + `Next 20`)**
   - **Currently In-Progress Tasks**: Live elapsed runtime, Workspace ID, worker ID, mounted repos, and one-click **Kill** (`kill_task` signal).
   - **Next 20 Queued Tasks**: Ordered deterministically by `(queueOrder ASC, createdDate ASC)`.
   - **Queue Ordering Controls**:
     - **Drag-and-Drop Row Reordering** + `▲` / `▼` step buttons (`POST /task-orchestrator-admin/queue/reorder`).
     - **Pin to Top** (`POST /task-orchestrator-admin/queue/{id}/move-to-top`) — sets `queueOrder = min(queueOrder) - 1000`.
     - **+ Add Task to Top of Queue Modal** (`POST /task-orchestrator-admin/tasks`) — select any Workspace (`Project`), specify title, Markdown prompt/instructions, priority, and immediately enqueue at the top (`pinToTop: true`) or bottom of the queue.

4. **Tab 2 — Execution History (`Last 20`) & Private S3 Log Drawer**
   - **Last 20 Past Executions**: Displays `completed` / `resolved`, `failed`, `killed`, `rejected`, and `pending` runs with exit codes, durations, harvested branch names, commit SHAs, changed file counts, and error codes (`TASK_TIMEOUT`, `OPERATOR_KILL`, `AUTH_SCOPE_DENIED`, etc.).
   - **Requeue to Top**: Re-run any failed/killed/completed task at the front of the queue with one click (`POST /task-orchestrator-admin/tasks/{id}/requeue`).
   - **Private S3 Execution Log & Trajectory Drawer**: Fetches private DigitalOcean Spaces objects via `s3-file.service.ts` (`isPublic = false`, with offline `_offline-spaces` fallback):
     - **`.log`**: Raw `stdout` / `stderr` execution output.
     - **`.jsonl`**: Structured `agy --output-format stream-json` trajectory stream.
     - **`.patch`**: Harvested multi-repo git diff patches (`git format-patch`).

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
