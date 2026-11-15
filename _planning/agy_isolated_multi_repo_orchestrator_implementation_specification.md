# Antigravity CLI (`agy`) Isolated Multi-Repo Orchestrator — Implementation Specification

## 1. Objective & System Overview
Build an unattended, headless Linux orchestration pipeline over SSH that executes up to **5 concurrent Antigravity CLI (`agy`) sessions** in strict, rootless `bubblewrap` (`bwrap`) sandboxes.

### Core Guarantees
1. **Dynamic 5-Slot Concurrency Pool:** The orchestrator maintains a maximum of 5 concurrent tasks (`MAX_CONCURRENT = 5`). Whenever a slot frees up, it atomically claims the oldest `PENDING` task(s) from the control API (`POST /api/v1/tasks/claim`).
2. **Multi-Repo & Branch Staging:** Each task defines an array of `repos` (with `name`, `repo_url`, `base_branch`, and `target_branch`). Before starting `agy`, the orchestrator stages **only** the exact file trees of those branches into `/srv/workspaces/task-<id>/workspace/<repo_name>` using `git archive`.
3. **Writable Workspace with Strict Scope Isolation:**
   * `agy` **can** freely read, edit, create, and delete files, run builds/tests, and commit locally inside `/workspace/<repo_name>`.
   * `agy` **cannot** see other branches, commit history prior to the baseline snapshot, git remotes (`origin`), SSH keys (`~/.ssh`), host directories (`/srv`, `/home`), or sibling tasks.
   * `agy` **cannot** clone external repositories or push/fetch over the network (`GIT_ALLOW_PROTOCOL=file` and `--tmpfs $HOME`).
4. **Host-Side Change Harvesting:** When `agy` finishes (`exit_code == 0`) on a mutating task (`feature`, `bugfix`, `refactor`), the orchestrator extracts a binary-safe diff (`git diff --binary ORCH_BASELINE..HEAD`) from each repo in the sandbox, applies it to a host-side worktree, commits, and pushes `target_branch` to the remote origin using the host's SSH credentials.
5. **3-Tier Telemetry & Control:** Logs and statuses are persisted in real time to local JSONL/text files (`/var/log/agy-orchestrator/tasks/`), a local SQLite database (`/var/lib/agy-orchestrator/state.db`), and the remote API (`PATCH /api/v1/tasks/{id}/telemetry`). Lifecycle controls (`pause`, `resume`, `stop`, `restart`, `kill-task`) are managed via UNIX signals and the `agy-ctl` CLI utility.

---

## 2. Host Prerequisites & Directory Layout

### 2.1 Required Packages on Ubuntu/Debian Linux
```bash
sudo apt-get update
sudo apt-get install -y git bubblewrap sqlite3 python3 curl tar
```

### 2.2 Antigravity CLI (`agy`) Installation & One-Time SSH Auth
```bash
curl -fsSL https://antigravity.google/cli/install.sh | bash
# Run interactively once over SSH to complete Remote OAuth with your Google AI Ultra account:
~/.local/bin/agy
# Verify headless mode:
~/.local/bin/agy -p "Reply with OK" --output-format json
```

### 2.3 Directory Structure
```text
/opt/agy-orchestrator/
└── orchestrator.py                 # Main asyncio orchestrator daemon
/usr/local/bin/
└── agy-ctl                         # CLI control utility for pause/resume/kill/status
/srv/repos-cache/                   # Host-only bare git mirrors (INVISIBLE to agy)
└── <repo_slug>-<hash>.git/
/srv/workspaces/                    # Per-task isolated trees
└── task-<id>/
    ├── workspace/                  # Mounted at /workspace (RW) inside bwrap
    │   ├── <repo_1>/               # Single-branch local git tree tagged ORCH_BASELINE
    │   └── <repo_2>/
    └── output/                     # Mounted at /output (RW) inside bwrap
/var/lib/agy-orchestrator/
└── state.db                        # Local SQLite state database
/var/log/agy-orchestrator/
└── tasks/
    ├── task_<id>.jsonl             # Raw stream-json events from agy
    └── task_<id>.log               # Formatted human-readable step log & diffs
```

---

## 3. Remote API Contract & Database Schema

Your external API server and monitoring dashboard should implement the following schema and endpoints.

### 3.1 API Database Schema (PostgreSQL)
```sql
CREATE TABLE agy_tasks (
    id VARCHAR(64) PRIMARY KEY,
    title VARCHAR(255) NOT NULL,
    task_type VARCHAR(32) NOT NULL DEFAULT 'feature', -- 'feature' | 'bugfix' | 'code_review' | 'refactor' | 'custom'
    repos JSONB NOT NULL,                             -- Array of {name, repo_url, base_branch, target_branch}
    user_prompt TEXT NOT NULL,
    model VARCHAR(64) NOT NULL DEFAULT 'gemini-2.5-pro',
    priority INT NOT NULL DEFAULT 0,
    status VARCHAR(32) NOT NULL DEFAULT 'PENDING',    -- PENDING, CLAIMED, RUNNING, COMPLETED, FAILED, CANCELLED
    conversation_id VARCHAR(128),
    worker_pid INT,
    exit_code INT,
    result_summary TEXT,
    pushed_branches JSONB DEFAULT '[]'::jsonb,
    log_tail TEXT,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    started_at TIMESTAMP WITH TIME ZONE,
    finished_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX idx_agy_tasks_claim ON agy_tasks (status, priority DESC, created_at ASC);
```

### 3.2 Task JSON Payload Format (`repos` Array)
```json
{
  "id": "task-1042",
  "title": "Sync Auth DTOs across Backend and Frontend",
  "task_type": "feature",
  "model": "gemini-2.5-pro",
  "repos": [
    {
      "name": "backend-api",
      "repo_url": "git@github.com:org/backend-api.git",
      "base_branch": "develop",
      "target_branch": "agy/task-1042-backend"
    },
    {
      "name": "web-app",
      "repo_url": "git@github.com:org/web-app.git",
      "base_branch": "main",
      "target_branch": "agy/task-1042-web"
    }
  ],
  "user_prompt": "Add `mfa_verified_at: string | null` to the UserProfile response in `backend-api` and display a verified badge in `web-app` profile settings."
}
```

### 3.3 Required REST API Endpoints
1. **`POST /api/v1/tasks/claim`**
   * **Request Body:** `{"max_count": 3}`
   * **Behavior:** Atomically selects up to `max_count` oldest `PENDING` tasks (`ORDER BY priority DESC, created_at ASC FOR UPDATE SKIP LOCKED`), sets `status = 'CLAIMED'`, and returns `{"tasks": [...]}`.
2. **`PATCH /api/v1/tasks/{task_id}/telemetry`**
   * **Request Body:**
     ```json
     {
       "status": "RUNNING",
       "worker_pid": 48192,
       "conversation_id": "conv_991823",
       "log_tail": "[12:01:04] step_update...",
       "result_summary": "Final markdown output...",
       "pushed_branches": [{"repo": "backend-api", "branch": "agy/task-1042-backend"}],
       "exit_code": 0
     }
     ```
3. **`POST /api/v1/tasks`** & **`GET /api/v1/tasks/monitor`**
   * Used by your frontend Monitor UI to enqueue new tasks (`code_review`, `feature`, `bugfix`) and view the 5 active slots alongside historical completed tasks.

---

## 4. Complete Orchestrator Implementation (`/opt/agy-orchestrator/orchestrator.py`)

Create `/opt/agy-orchestrator/orchestrator.py` and make it executable (`chmod +x /opt/agy-orchestrator/orchestrator.py`).

```python
#!/usr/bin/env python3
"""
Antigravity CLI (agy) Isolated Multi-Repo Orchestrator
- Maintains up to 5 concurrent isolated tasks (FIFO claim from API)
- Stages multi-repo trees via git archive + local-only baseline commits
- Sandboxes agy inside rootless Bubblewrap (bwrap) with GIT_ALLOW_PROTOCOL=file
- Harvests diffs on completion and pushes target branches from host
- Logs to JSONL, human-readable text logs, local SQLite, and remote REST API
"""

import asyncio
import hashlib
import json
import os
import re
import shutil
import signal
import sqlite3
import subprocess
import sys
import time
import urllib.request
from pathlib import Path
from typing import Any

# --- CONFIGURATION (Override via Environment Variables) ---
API_BASE_URL = os.getenv("ORCH_API_URL", "https://your-api.example.com/api/v1")
API_TOKEN = os.getenv("ORCH_API_TOKEN", "replace-with-token")
REPO_CACHE_DIR = Path(os.getenv("REPO_CACHE_DIR", "/srv/repos-cache"))
WORKSPACE_ROOT = Path(os.getenv("WORKSPACE_ROOT", "/srv/workspaces"))
LOG_DIR = Path(os.getenv("LOG_DIR", "/var/log/agy-orchestrator"))
DB_PATH = Path(os.getenv("DB_PATH", "/var/lib/agy-orchestrator/state.db"))

AGY_BIN = os.getenv("AGY_BIN", str(Path.home() / ".local/bin/agy"))
AGY_CONFIG_DIR = os.getenv("AGY_CONFIG_DIR", str(Path.home() / ".gemini"))
DEFAULT_MODEL = os.getenv("AGY_MODEL", "gemini-2.5-pro")

MAX_CONCURRENT = int(os.getenv("MAX_CONCURRENT", "5"))
POLL_INTERVAL = int(os.getenv("POLL_INTERVAL", "10"))
GIT_AUTHOR_NAME = os.getenv("GIT_AUTHOR_NAME", "AGY Orchestrator")
GIT_AUTHOR_EMAIL = os.getenv("GIT_AUTHOR_EMAIL", "agy-orchestrator@internal.local")

# --- RUNTIME STATE ---
PAUSED = False
SHUTTING_DOWN = False
ACTIVE_TASKS: dict[str, asyncio.Task] = {}
ACTIVE_PROCS: dict[str, asyncio.subprocess.Process] = {}


# =====================================================================
# 1. STORAGE & DATABASE INITIALIZATION
# =====================================================================

def init_storage() -> None:
    REPO_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    WORKSPACE_ROOT.mkdir(parents=True, exist_ok=True)
    (LOG_DIR / "tasks").mkdir(parents=True, exist_ok=True)
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)

    with sqlite3.connect(DB_PATH) as conn:
        conn.execute("PRAGMA journal_mode=WAL;")
        conn.execute("""
            CREATE TABLE IF NOT EXISTS tasks (
                task_id TEXT PRIMARY KEY,
                task_type TEXT,
                repos_json TEXT,
                workspace_path TEXT,
                pid INTEGER,
                conversation_id TEXT,
                status TEXT,
                exit_code INTEGER,
                pushed_branches_json TEXT,
                result_summary TEXT,
                jsonl_log TEXT,
                text_log TEXT,
                started_at REAL,
                updated_at REAL,
                finished_at REAL
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS orchestrator_state (
                key TEXT PRIMARY KEY,
                value TEXT
            )
        """)
        conn.execute(
            "INSERT OR REPLACE INTO orchestrator_state (key, value) VALUES ('status', 'RUNNING'), ('pid', ?)",
            (str(os.getpid()),),
        )


def db_update_task(task_id: str, **fields: Any) -> None:
    fields["updated_at"] = time.time()
    cols = ", ".join(f"{k} = ?" for k in fields.keys())
    vals = list(fields.values()) + [task_id]
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute(f"UPDATE tasks SET {cols} WHERE task_id = ?", vals)


# =====================================================================
# 2. REMOTE API CLIENT
# =====================================================================

def api_request(method: str, endpoint: str, payload: dict | None = None) -> Any:
    url = f"{API_BASE_URL.rstrip('/')}/{endpoint.lstrip('/')}"
    headers = {
        "Authorization": f"Bearer {API_TOKEN}",
        "Content-Type": "application/json",
        "Accept": "application/json",
    }
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            raw = resp.read().decode("utf-8")
            return json.loads(raw) if raw else {}
    except Exception as exc:
        print(f"[API ERROR] {method} {url}: {exc}", file=sys.stderr)
        return None


def claim_oldest_tasks(free_slots: int) -> list[dict]:
    res = api_request("POST", "/tasks/claim", {"max_count": free_slots})
    if isinstance(res, dict) and isinstance(res.get("tasks"), list):
        return res["tasks"]
    if isinstance(res, list):
        return res
    return []


def push_telemetry(task_id: str, **payload: Any) -> None:
    payload["timestamp"] = time.time()
    api_request("PATCH", f"/tasks/{task_id}/telemetry", payload)


# =====================================================================
# 3. HOST-SIDE GIT MIRROR & ISOLATED TREE STAGING
# =====================================================================

def sanitize_name(name: str) -> str:
    return re.sub(r"[^a-zA-Z0-9._-]", "_", name)


def sync_bare_repo(repo_url: str) -> Path:
    """Fetches latest refs into host-only bare repo cache (/srv/repos-cache)."""
    repo_tail = repo_url.rstrip("/").split("/")[-1].replace(".git", "")
    slug = sanitize_name(repo_tail)
    url_hash = hashlib.sha1(repo_url.encode("utf-8")).hexdigest()[:8]
    cached_repo = REPO_CACHE_DIR / f"{slug}-{url_hash}.git"

    if not cached_repo.exists():
        subprocess.run(["git", "clone", "--mirror", repo_url, str(cached_repo)], check=True)
    else:
        subprocess.run(["git", "-C", str(cached_repo), "fetch", "--all", "--prune"], check=True)
    return cached_repo


def stage_isolated_workspace(task: dict) -> tuple[Path, Path]:
    """
    Prepares `/srv/workspaces/task-<id>/workspace/<repo_name>` for every repo in `task['repos']`.
    Exports ONLY the requested `base_branch` snapshot via `git archive` and initializes a single-commit,
    remote-less local git repository tagged `ORCH_BASELINE`.
    """
    task_id = sanitize_name(str(task["id"]))
    task_root = WORKSPACE_ROOT / f"task-{task_id}"
    ws_dir = task_root / "workspace"
    out_dir = task_root / "output"

    if task_root.exists():
        shutil.rmtree(task_root)
    ws_dir.mkdir(parents=True, exist_ok=True)
    out_dir.mkdir(parents=True, exist_ok=True)

    repos = task.get("repos", [])
    if not repos:
        raise ValueError(f"Task {task_id} contains an empty 'repos' array.")

    for repo_spec in repos:
        name = sanitize_name(repo_spec["name"])
        repo_url = repo_spec["repo_url"]
        base_branch = repo_spec.get("base_branch", "main")
        target_branch = repo_spec.get("target_branch") or f"agy/task-{task_id}"

        bare_repo = sync_bare_repo(repo_url)
        repo_dir = ws_dir / name
        repo_dir.mkdir(parents=True, exist_ok=True)

        # Resolve exact commit SHA of base_branch
        rev_proc = subprocess.run(
            ["git", "-C", str(bare_repo), "rev-parse", f"refs/heads/{base_branch}"],
            capture_output=True,
            text=True,
            check=True,
        )
        base_sha = rev_proc.stdout.strip()
        repo_spec["_resolved_base_sha"] = base_sha

        # Export exact branch file tree without history or other branches
        archive_cmd = f"git -C {bare_repo} archive {base_sha} | tar -x -C {repo_dir}"
        subprocess.run(archive_cmd, shell=True, check=True)

        # Initialize local single-branch git repository with zero remotes
        subprocess.run(["git", "-C", str(repo_dir), "init", "-q", "-b", target_branch], check=True)
        subprocess.run(["git", "-C", str(repo_dir), "config", "user.name", "agy-sandbox"], check=True)
        subprocess.run(["git", "-C", str(repo_dir), "config", "user.email", "agy@sandbox.local"], check=True)
        subprocess.run(["git", "-C", str(repo_dir), "add", "-A"], check=True)
        subprocess.run(
            ["git", "-C", str(repo_dir), "commit", "-q", "-m", f"Baseline snapshot of {name}@{base_branch} ({base_sha[:8]})"],
            check=True,
        )
        subprocess.run(["git", "-C", str(repo_dir), "tag", "ORCH_BASELINE"], check=True)

    return ws_dir, out_dir


# =====================================================================
# 4. PROMPT INJECTION & BUBBLEWRAP SANDBOX BUILDER
# =====================================================================

def build_task_prompt(task: dict) -> str:
    task_type = task.get("task_type", "feature").lower()
    repos = task.get("repos", [])
    user_prompt = task.get("user_prompt", "")

    manifest_lines = [
        f"- `/workspace/{sanitize_name(r['name'])}` (Base branch: `{r.get('base_branch', 'main')}`, Working branch: `{r.get('target_branch', 'agy/task-' + str(task['id']))}`)"
        for r in repos
    ]
    manifest = "\n".join(manifest_lines)

    common_header = (
        f"You are operating inside an isolated multi-repository workspace at `/workspace`.\n"
        f"MOUNTED REPOSITORIES:\n{manifest}\n\n"
        f"ENVIRONMENT CONSTRAINTS:\n"
        f"1. You only have access to the repositories listed above inside `/workspace`.\n"
        f"2. Git remotes and external `git clone` / `git fetch` / `git push` are disabled by the sandbox.\n"
        f"3. Do NOT attempt to push or configure git remotes; the host orchestrator automatically harvests your file edits and local commits after you finish.\n\n"
    )

    if task_type == "code_review":
        type_rules = (
            "TASK TYPE: CODE REVIEW\n"
            "- Inspect the code across the mounted repositories in `/workspace`.\n"
            "- Do NOT modify source files unless running a temporary analysis check (revert any scratch changes before finishing).\n"
            "- Produce a comprehensive Markdown Code Review report categorized by Critical, Warning, and Suggestion, citing exact file paths and line numbers.\n\n"
        )
    else:
        type_rules = (
            f"TASK TYPE: {task_type.upper()}\n"
            "- Modify the necessary files inside the `/workspace/<repo_name>` directories to complete the task.\n"
            "- Run relevant unit tests, linters, or build checks inside the respective repository directories.\n"
            "- Leave your changes saved (or committed locally) inside each repository directory.\n"
            "- Conclude with a clear Markdown summary of root cause, files changed per repository, and verification results.\n\n"
        )

    return f"{common_header}{type_rules}USER TASK INSTRUCTIONS:\n{user_prompt}"


def build_bwrap_command(ws_dir: Path, out_dir: Path, prompt: str, model: str, read_only: bool = False) -> list[str]:
    home_dir = str(Path.home())
    cmd = [
        "bwrap",
        "--unshare-all",
        "--share-net",
        "--die-with-parent",
        "--ro-bind", "/usr", "/usr",
        "--ro-bind", "/lib", "/lib",
        "--ro-bind-try", "/lib64", "/lib64",
        "--ro-bind", "/bin", "/bin",
        "--ro-bind", "/sbin", "/sbin",
        "--ro-bind-try", "/etc/alternatives", "/etc/alternatives",
        "--ro-bind", "/etc/resolv.conf", "/etc/resolv.conf",
        "--ro-bind", "/etc/ssl", "/etc/ssl",
        "--ro-bind-try", "/etc/ca-certificates", "/etc/ca-certificates",
        "--ro-bind", "/etc/passwd", "/etc/passwd",
        "--ro-bind", "/etc/group", "/etc/group",
        "--proc", "/proc",
        "--dev", "/dev",
        "--tmpfs", "/tmp",
        # Hide host $HOME (~/.ssh, ~/.gitconfig, etc.)
        "--tmpfs", home_dir,
        "--ro-bind", AGY_BIN, AGY_BIN,
        "--bind", AGY_CONFIG_DIR, AGY_CONFIG_DIR,
        "--bind", str(out_dir), "/output",
    ]

    if read_only:
        cmd += ["--ro-bind", str(ws_dir), "/workspace"]
    else:
        cmd += ["--bind", str(ws_dir), "/workspace"]

    cmd += [
        "--chdir", "/workspace",
        "--setenv", "HOME", home_dir,
        "--setenv", "GIT_ALLOW_PROTOCOL", "file",
        "--setenv", "GIT_TERMINAL_PROMPT", "0",
        AGY_BIN,
        "-p", prompt,
        "--model", model,
        "--output-format", "stream-json",
        "--dangerously-skip-permissions",
    ]
    return cmd


# =====================================================================
# 5. POST-TASK DIFF HARVESTING & HOST GIT PUSH
# =====================================================================

def harvest_and_push_changes(task: dict, ws_dir: Path, text_log_path: Path) -> list[dict]:
    """
    Inspects each repo in `/workspace/<repo_name>` after `agy` exits cleanly.
    Generates binary-safe diffs against `ORCH_BASELINE`, applies them to a host worktree,
    and pushes `target_branch` to `repo_url`.
    """
    task_id = sanitize_name(str(task["id"]))
    task_type = task.get("task_type", "feature").lower()
    if task_type == "code_review":
        return []

    pushed_branches: list[dict] = []

    for repo_spec in task.get("repos", []):
        name = sanitize_name(repo_spec["name"])
        repo_url = repo_spec["repo_url"]
        base_sha = repo_spec.get("_resolved_base_sha")
        target_branch = repo_spec.get("target_branch") or f"agy/task-{task_id}"
        repo_dir = ws_dir / name

        if not repo_dir.exists() or not base_sha:
            continue

        # Stage any uncommitted file modifications made by agy
        subprocess.run(["git", "-C", str(repo_dir), "add", "-A"], check=True)
        status_out = subprocess.run(
            ["git", "-C", str(repo_dir), "status", "--porcelain"],
            capture_output=True,
            text=True,
            check=True,
        ).stdout.strip()

        if status_out:
            subprocess.run(
                ["git", "-C", str(repo_dir), "commit", "-q", "-m", f"chore(agy): task {task_id} changes"],
                check=True,
            )

        diff_proc = subprocess.run(
            ["git", "-C", str(repo_dir), "diff", "--binary", "ORCH_BASELINE..HEAD"],
            capture_output=True,
            text=True,
            check=True,
        )
        patch_data = diff_proc.stdout
        if not patch_data.strip():
            continue

        # Save patch artifact in output folder
        patch_file = ws_dir.parent / "output" / f"{name}.patch"
        patch_file.write_text(patch_data, encoding="utf-8")

        # Apply patch to a temporary host worktree and push using host SSH credentials
        bare_repo = sync_bare_repo(repo_url)
        push_wt = ws_dir.parent / f"host-push-{name}"
        if push_wt.exists():
            subprocess.run(["git", "-C", str(bare_repo), "worktree", "remove", "--force", str(push_wt)], check=False)

        subprocess.run(
            ["git", "-C", str(bare_repo), "worktree", "add", "-B", target_branch, str(push_wt), base_sha],
            check=True,
        )
        try:
            subprocess.run(
                ["git", "-C", str(push_wt), "apply", "--index", "-"],
                input=patch_data,
                text=True,
                check=True,
            )
            subprocess.run(
                [
                    "git", "-C", str(push_wt),
                    "-c", f"user.name={GIT_AUTHOR_NAME}",
                    "-c", f"user.email={GIT_AUTHOR_EMAIL}",
                    "commit", "-m", f"feat(agy): complete task {task_id} ({ task.get('title', '') })",
                ],
                check=True,
            )
            subprocess.run(
                ["git", "-C", str(push_wt), "push", "--force", repo_url, f"HEAD:refs/heads/{target_branch}"],
                check=True,
            )
            pushed_branches.append({"repo": name, "repo_url": repo_url, "branch": target_branch})
            with open(text_log_path, "a", encoding="utf-8") as tf:
                tf.write(f"\n[ORCHESTRATOR] Pushed changes for {name} -> {target_branch}\n")
        finally:
            subprocess.run(["git", "-C", str(bare_repo), "worktree", "remove", "--force", str(push_wt)], check=False)

    return pushed_branches


# =====================================================================
# 6. ASYNC TASK WORKER & MAIN ORCHESTRATION LOOP
# =====================================================================

async def execute_isolated_task(task: dict) -> None:
    task_id = str(task["id"])
    task_type = task.get("task_type", "feature").lower()
    model = task.get("model") or DEFAULT_MODEL
    jsonl_log = LOG_DIR / "tasks" / f"task_{sanitize_name(task_id)}.jsonl"
    text_log = LOG_DIR / "tasks" / f"task_{sanitize_name(task_id)}.log"

    with sqlite3.connect(DB_PATH) as conn:
        conn.execute(
            """INSERT OR REPLACE INTO tasks
               (task_id, task_type, repos_json, status, jsonl_log, text_log, started_at, updated_at)
               VALUES (?, ?, ?, 'STAGING', ?, ?, ?, ?)""",
            (
                task_id,
                task_type,
                json.dumps(task.get("repos", [])),
                str(jsonl_log),
                str(text_log),
                time.time(),
                time.time(),
            ),
        )

    try:
        ws_dir, out_dir = await asyncio.to_thread(stage_isolated_workspace, task)
    except Exception as exc:
        err_msg = f"Workspace staging failed: {exc}"
        db_update_task(task_id, status="FAILED", result_summary=err_msg, finished_at=time.time())
        push_telemetry(task_id, status="FAILED", result_summary=err_msg)
        return

    prompt = build_task_prompt(task)
    read_only = task_type == "code_review"
    cmd = build_bwrap_command(ws_dir, out_dir, prompt, model, read_only=read_only)

    proc = await asyncio.create_subprocess_exec(
        *cmd,
        cwd=str(ws_dir),
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
        start_new_session=True,
    )
    ACTIVE_PROCS[task_id] = proc

    db_update_task(task_id, workspace_path=str(ws_dir), pid=proc.pid, status="RUNNING")
    push_telemetry(task_id, status="RUNNING", worker_pid=proc.pid)

    conversation_id = None
    final_result = ""
    recent_steps: list[str] = []
    last_push_ts = time.time()

    with open(jsonl_log, "a", encoding="utf-8") as jf, open(text_log, "a", encoding="utf-8") as tf:
        assert proc.stdout is not None
        async for raw_line in proc.stdout:
            line = raw_line.decode("utf-8", errors="replace").strip()
            if not line:
                continue
            jf.write(line + "\n")
            jf.flush()

            try:
                evt = json.loads(line)
                evt_type = evt.get("event")
                if evt_type == "init":
                    conversation_id = evt.get("conversation_id")
                    db_update_task(task_id, conversation_id=conversation_id)
                elif evt_type == "step_update":
                    step_line = f"[{time.strftime('%H:%M:%S')}] {json.dumps(evt.get('step', {}))}"
                    tf.write(step_line + "\n")
                    tf.flush()
                    recent_steps.append(step_line)
                    recent_steps = recent_steps[-30:]

                    if time.time() - last_push_ts >= 5.0:
                        push_telemetry(
                            task_id,
                            status="RUNNING",
                            conversation_id=conversation_id,
                            log_tail="\n".join(recent_steps),
                        )
                        last_push_ts = time.time()
                elif evt_type == "result":
                    final_result = evt.get("text", "")
                    tf.write(f"\n=== FINAL AGY RESULT ===\n{final_result}\n")
                    tf.flush()
            except json.JSONDecodeError:
                tf.write(f"[RAW] {line}\n")
                tf.flush()

    exit_code = await proc.wait()
    ACTIVE_PROCS.pop(task_id, None)

    pushed_branches: list[dict] = []
    if exit_code == 0:
        try:
            pushed_branches = await asyncio.to_thread(harvest_and_push_changes, task, ws_dir, text_log)
            final_status = "COMPLETED"
        except Exception as exc:
            final_status = "FAILED"
            final_result += f"\n\n[Host Git Harvest/Push Error]: {exc}"
    else:
        final_status = "FAILED"

    db_update_task(
        task_id,
        status=final_status,
        exit_code=exit_code,
        conversation_id=conversation_id,
        pushed_branches_json=json.dumps(pushed_branches),
        result_summary=final_result,
        finished_at=time.time(),
    )

    push_telemetry(
        task_id,
        status=final_status,
        exit_code=exit_code,
        conversation_id=conversation_id,
        pushed_branches=pushed_branches,
        result_summary=final_result,
        log_tail="\n".join(recent_steps),
    )

    # Clean up workspace on success; retain on failure for post-mortem debugging
    if final_status == "COMPLETED":
        shutil.rmtree(ws_dir.parent, ignore_errors=True)


async def orchestrator_loop() -> None:
    init_storage()
    print(f"[Orchestrator] Active with PID {os.getpid()} (Max Concurrent Slots: {MAX_CONCURRENT})")

    while not SHUTTING_DOWN:
        done_ids = [tid for tid, t in ACTIVE_TASKS.items() if t.done()]
        for tid in done_ids:
            ACTIVE_TASKS.pop(tid, None)

        free_slots = MAX_CONCURRENT - len(ACTIVE_TASKS)
        if not PAUSED and free_slots > 0:
            claimed = await asyncio.to_thread(claim_oldest_tasks, free_slots)
            for task_obj in claimed:
                tid = str(task_obj["id"])
                if tid not in ACTIVE_TASKS:
                    ACTIVE_TASKS[tid] = asyncio.create_task(execute_isolated_task(task_obj))

        await asyncio.sleep(POLL_INTERVAL)

    if ACTIVE_TASKS:
        await asyncio.gather(*ACTIVE_TASKS.values(), return_exceptions=True)


def handle_signal(sig: int, _frame: Any) -> None:
    global PAUSED, SHUTTING_DOWN
    with sqlite3.connect(DB_PATH) as conn:
        if sig == signal.SIGUSR1:
            PAUSED = True
            conn.execute("INSERT OR REPLACE INTO orchestrator_state (key, value) VALUES ('status', 'PAUSED')")
            print("[Orchestrator] PAUSED — running tasks will finish; no new tasks will be claimed.")
        elif sig == signal.SIGUSR2:
            PAUSED = False
            conn.execute("INSERT OR REPLACE INTO orchestrator_state (key, value) VALUES ('status', 'RUNNING')")
            print("[Orchestrator] RESUMED — claiming tasks up to 5 concurrent slots.")
        elif sig in (signal.SIGTERM, signal.SIGINT):
            SHUTTING_DOWN = True
            conn.execute("INSERT OR REPLACE INTO orchestrator_state (key, value) VALUES ('status', 'STOPPING')")
            for proc in list(ACTIVE_PROCS.values()):
                try:
                    os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
                except ProcessLookupError:
                    pass


if __name__ == "__main__":
    signal.signal(signal.SIGUSR1, handle_signal)
    signal.signal(signal.SIGUSR2, handle_signal)
    signal.signal(signal.SIGTERM, handle_signal)
    signal.signal(signal.SIGINT, handle_signal)
    asyncio.run(orchestrator_loop())
```

---

## 5. CLI Controller Script (`/usr/local/bin/agy-ctl`)

Create `/usr/local/bin/agy-ctl` (`chmod +x /usr/local/bin/agy-ctl`) to inspect, pause, resume, stop, restart, or kill individual tasks over SSH.

```bash
#!/usr/bin/env bash
set -euo pipefail

DB="/var/lib/agy-orchestrator/state.db"
LOG_DIR="/var/log/agy-orchestrator/tasks"
ORCH_PID=$(sqlite3 "$DB" "SELECT value FROM orchestrator_state WHERE key='pid';" 2>/dev/null || true)

case "${1:-help}" in
  status)
    echo "=== Orchestrator Daemon ==="
    sqlite3 -header -column "$DB" "SELECT * FROM orchestrator_state;"
    echo ""
    echo "=== Active & Recent Tasks (Max 5 Running) ==="
    sqlite3 -header -column "$DB" "
      SELECT task_id, task_type, pid, status, exit_code,
             datetime(started_at, 'unixepoch') AS started,
             datetime(finished_at, 'unixepoch') AS finished
      FROM tasks
      ORDER BY started_at DESC
      LIMIT 15;
    "
    ;;
  pause)
    if [[ "${2:-}" == "--hard" ]]; then
      sqlite3 "$DB" "SELECT pid FROM tasks WHERE status='RUNNING';" | xargs -r -I{} kill -STOP -{}
      echo "Sent SIGSTOP to all running agy sandbox process groups."
    fi
    kill -USR1 "$ORCH_PID"
    echo "Orchestrator set to PAUSED."
    ;;
  resume)
    sqlite3 "$DB" "SELECT pid FROM tasks WHERE status='RUNNING';" | xargs -r -I{} kill -CONT -{}
    kill -USR2 "$ORCH_PID"
    echo "Orchestrator RESUMED."
    ;;
  kill-task)
    TASK_ID="${2:?Usage: agy-ctl kill-task <task_id>}"
    TASK_PID=$(sqlite3 "$DB" "SELECT pid FROM tasks WHERE task_id='$TASK_ID' AND status='RUNNING';")
    if [[ -n "$TASK_PID" ]]; then
      kill -TERM -"$TASK_PID"
      echo "Terminated isolated agy sandbox for task $TASK_ID (PGID $TASK_PID)."
    else
      echo "Task $TASK_ID is not currently running."
    fi
    ;;
  logs)
    TASK_ID="${2:?Usage: agy-ctl logs <task_id>}"
    tail -n 100 -f "$LOG_DIR/task_${TASK_ID}.log"
    ;;
  stop)
    sudo systemctl stop agy-orchestrator
    echo "Orchestrator stopped."
    ;;
  restart)
    sudo systemctl restart agy-orchestrator
    echo "Orchestrator restarted."
    ;;
  *)
    echo "Usage: agy-ctl {status|pause [--hard]|resume|kill-task <task_id>|logs <task_id>|stop|restart}"
    ;;
esac
```

---

## 6. Systemd Service Unit (`/etc/systemd/system/agy-orchestrator.service`)

```ini
[Unit]
Description=Antigravity CLI (agy) Isolated Multi-Repo Orchestrator
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=YOUR_SSH_USER
Group=YOUR_SSH_USER
Environment="ORCH_API_URL=https://your-api.example.com/api/v1"
Environment="ORCH_API_TOKEN=replace-with-token"
Environment="MAX_CONCURRENT=5"
Environment="POLL_INTERVAL=10"
ExecStart=/usr/bin/python3 /opt/agy-orchestrator/orchestrator.py
ExecReload=/bin/kill -USR2 $MAINPID
Restart=always
RestartSec=5
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
```

### Enable and Start the Pipeline
```bash
sudo mkdir -p /opt/agy-orchestrator /srv/repos-cache /srv/workspaces /var/lib/agy-orchestrator /var/log/agy-orchestrator/tasks
sudo chown -R $USER:$USER /opt/agy-orchestrator /srv/repos-cache /srv/workspaces /var/lib/agy-orchestrator /var/log/agy-orchestrator
sudo systemctl daemon-reload
sudo systemctl enable --now agy-orchestrator
agy-ctl status
```

---

## 7. Implementation Checklist for the Coding Agent
1. [ ] Provision `/opt/agy-orchestrator/orchestrator.py` and `/usr/local/bin/agy-ctl` with executable permissions.
2. [ ] Verify `bwrap --version` works for the unprivileged SSH user (if running on Ubuntu 24.04+ with restricted AppArmor user namespaces, add an AppArmor profile for `/usr/bin/bwrap` or set `kernel.apparmor_restrict_unprivileged_userns=0`).
3. [ ] Implement the 3 REST endpoints (`/api/v1/tasks/claim`, `/api/v1/tasks/{id}/telemetry`, and `/api/v1/tasks`) on the backend server using the `agy_tasks` schema.
4. [ ] Test a single `code_review` task and a multi-repo `feature` task via `agy-ctl status` and `agy-ctl logs <task_id>`.