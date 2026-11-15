/* global window, document, sessionStorage, fetch */

/**
 * Rapider Isolated Task Orchestrator — Standalone Admin Console Client
 *
 * Strictly zero hardcoded secrets, tokens, or project IDs.
 * Authenticates via Rapider `/api/users/login` -> `/api/users/people` ->
 * `/api/users/change-active-person` and verifies `admin` permission scope
 * via `/api/admin/task-orchestrator/me`.
 */

(function () {
  const SESSION_TOKEN_KEY = 'rapider_task_orch_admin_jwt';

  const state = {
    token: sessionStorage.getItem(SESSION_TOKEN_KEY) || '',
    adminProfile: null,
    activeTab: 'queue',
    overview: null,
    history: [],
    queueSearch: '',
    historySearch: '',
    draggingWorkItemId: null,
    pollTimer: null,
    logViewer: {
      open: false,
      workItemId: null,
      title: '',
      type: 'log',
    },
  };

  function escapeHtml(raw) {
    return String(raw == null ? '' : raw)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatDateTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleString([], {
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  }

  function formatDuration(ms) {
    const n = Number(ms);
    if (!Number.isFinite(n) || n <= 0) return '—';
    if (n < 1000) return `${Math.round(n)}ms`;
    const s = Math.round(n / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    const rem = s % 60;
    return `${m}m ${rem}s`;
  }

  function statusBadgeHtml(status) {
    const s = String(status || 'open').toLowerCase();
    const styles = {
      running: 'bg-blue-100 text-blue-800 border-blue-200',
      staging: 'bg-indigo-100 text-indigo-800 border-indigo-200',
      queued: 'bg-amber-50 text-amber-800 border-amber-200',
      open: 'bg-slate-100 text-slate-700 border-slate-200',
      resolved: 'bg-emerald-100 text-emerald-800 border-emerald-200',
      completed: 'bg-emerald-100 text-emerald-800 border-emerald-200',
      pending: 'bg-purple-100 text-purple-800 border-purple-200',
      failed: 'bg-red-100 text-red-800 border-red-200',
      killed: 'bg-red-100 text-red-800 border-red-200',
      rejected: 'bg-orange-100 text-orange-800 border-orange-200',
      cancelled: 'bg-slate-100 text-slate-500 border-slate-200',
    };
    const cls = styles[s] || 'bg-slate-100 text-slate-700 border-slate-200';
    return `<span class="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold border ${cls}">${escapeHtml(s.toUpperCase())}</span>`;
  }

  function showToast(message, variant = 'info') {
    const container = document.getElementById('toastContainer');
    if (!container) return;
    const el = document.createElement('div');
    const bg =
      variant === 'error'
        ? 'bg-red-600 !text-white text-white'
        : variant === 'success'
          ? 'bg-emerald-600 !text-white text-white'
          : 'bg-slate-900 !text-white text-white';
    el.className = `rounded-xl px-4 py-2.5 text-xs font-medium shadow-lg transition ${bg}`;
    el.style.setProperty('color', '#ffffff', 'important');
    el.textContent = message;
    container.appendChild(el);
    setTimeout(() => {
      el.remove();
    }, 3600);
  }

  async function apiFetch(endpointPath, options = {}) {
    const headers = {
      Accept: 'application/json',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    };
    const tok = options.tokenOverride !== undefined ? options.tokenOverride : state.token;
    if (tok) {
      headers.Authorization = tok;
    }

    const res = await fetch(`/api${endpointPath}`, {
      method: options.method || 'GET',
      headers,
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(
        data?.error?.message || data?.message || `HTTP ${res.status}`
      );
      err.status = res.status;
      throw err;
    }
    return data;
  }

  // ---------------------------------------------------------------------------
  // Authentication & Strict Admin Gate
  // ---------------------------------------------------------------------------
  function showAuthScreen({ forbiddenMsg = '', errorMsg = '' } = {}) {
    if (state.pollTimer) {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
    }
    document.getElementById('dashboardView').classList.add('hidden');
    document.getElementById('authView').classList.remove('hidden');

    const fbBanner = document.getElementById('authForbiddenBanner');
    const errBanner = document.getElementById('authErrorBanner');

    if (forbiddenMsg) {
      document.getElementById('authForbiddenMessage').textContent = forbiddenMsg;
      fbBanner.classList.remove('hidden');
    } else {
      fbBanner.classList.add('hidden');
    }

    if (errorMsg) {
      errBanner.textContent = errorMsg;
      errBanner.classList.remove('hidden');
    } else {
      errBanner.classList.add('hidden');
    }
  }

  async function verifySessionAndEnterDashboard(candidateToken) {
    const me = await apiFetch('/admin/task-orchestrator/me', {
      tokenOverride: candidateToken,
    });
    state.token = candidateToken;
    state.adminProfile = me;
    sessionStorage.setItem(SESSION_TOKEN_KEY, candidateToken);

    document.getElementById('authView').classList.add('hidden');
    document.getElementById('dashboardView').classList.remove('hidden');
    document.getElementById('adminIdentityLabel').textContent =
      me.personFullName || me.username || 'Admin';

    await refreshAllData();
    if (!state.pollTimer) {
      state.pollTimer = setInterval(() => {
        refreshAllData({ silent: true }).catch(() => {});
      }, 5000);
    }
  }

  async function handleLoginSubmit(ev) {
    ev.preventDefault();
    const btn = document.getElementById('loginSubmitBtn');
    const originalHtml = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-1.5"></i> Verifying Admin Access...';
    btn.style.setProperty('color', '#ffffff', 'important');

    try {
      const username = document.getElementById('loginEmail').value.trim();
      const password = document.getElementById('loginPassword').value;

      const loginData = await apiFetch('/users/login', {
        method: 'POST',
        tokenOverride: '',
        body: { username, password },
      });

      let token = loginData.authenticationToken;
      if (!token) {
        throw new Error('Authentication failed: no token returned.');
      }

      // Upgrade to active Person profile when available so personFullName/personId are populated
      try {
        const peopleData = await apiFetch('/users/people', { tokenOverride: token });
        const people = Array.isArray(peopleData)
          ? peopleData
          : peopleData.people || [];
        if (people.length > 0 && people[0].id) {
          const switched = await apiFetch('/users/change-active-person', {
            method: 'POST',
            tokenOverride: token,
            body: { personId: people[0].id },
          });
          if (switched && switched.authenticationToken) {
            token = switched.authenticationToken;
          }
        }
      } catch (_) {}

      await verifySessionAndEnterDashboard(token);
      document.getElementById('loginPassword').value = '';
      showToast('Signed in to Task Orchestrator Admin Console.', 'success');
    } catch (err) {
      sessionStorage.removeItem(SESSION_TOKEN_KEY);
      state.token = '';
      if (err.status === 403) {
        showAuthScreen({
          forbiddenMsg:
            err.message ||
            'Access denied: only Rapider users with the "admin" permission scope may use this console.',
        });
      } else {
        showAuthScreen({ errorMsg: err.message || 'Sign-in failed.' });
      }
    } finally {
      btn.disabled = false;
      btn.innerHTML = originalHtml;
      btn.style.setProperty('color', '#ffffff', 'important');
    }
  }

  // ---------------------------------------------------------------------------
  // Data Fetching & Rendering
  // ---------------------------------------------------------------------------
  async function refreshAllData(opts = {}) {
    if (!state.token) return;
    try {
      const [overview, historyRes] = await Promise.all([
        apiFetch('/admin/task-orchestrator/overview?queueLimit=20'),
        apiFetch('/admin/task-orchestrator/history?limit=20'),
      ]);
      state.overview = overview;
      state.history = Array.isArray(historyRes.history) ? historyRes.history : [];

      renderHeaderAndWorkers();
      renderActiveTasks();
      renderQueueTable();
      renderHistoryTable();
      populateWorkspaceDropdown();

      document.getElementById('lastSyncedLabel').textContent =
        `Synced ${new Date().toLocaleTimeString()}`;
    } catch (err) {
      if (err.status === 401 || err.status === 403) {
        sessionStorage.removeItem(SESSION_TOKEN_KEY);
        state.token = '';
        showAuthScreen({
          forbiddenMsg:
            err.status === 403 ? err.message : '',
          errorMsg:
            err.status === 401 ? 'Session expired. Please sign in again.' : '',
        });
      } else if (!opts.silent) {
        showToast(err.message, 'error');
      }
    }
  }

  function renderHeaderAndWorkers() {
    const ov = state.overview;
    if (!ov) return;

    const badge = document.getElementById('globalStateBadge');
    const pauseBtn = document.getElementById('togglePauseBtn');

    if (ov.state.hardPaused) {
      badge.className = 'inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold bg-red-100 text-red-800';
      badge.textContent = 'HARD STOPPED';
      pauseBtn.innerHTML = '<i class="fas fa-play mr-1 text-emerald-600"></i>Resume';
    } else if (ov.state.paused) {
      badge.className = 'inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold bg-amber-100 text-amber-800';
      badge.textContent = 'PAUSED (DRAINING)';
      pauseBtn.innerHTML = '<i class="fas fa-play mr-1 text-emerald-600"></i>Resume';
    } else {
      badge.className = 'inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold bg-emerald-100 text-emerald-800';
      badge.textContent = 'RUNNING';
      pauseBtn.innerHTML = '<i class="fas fa-pause mr-1"></i>Pause';
    }

    document.getElementById('slotGaugeText').textContent =
      `${ov.metrics.activeCount} / ${ov.metrics.maxConcurrent}`;
    document.getElementById('queuedCountText').textContent =
      String(ov.metrics.totalQueuedCount || 0);

    const maxInput = document.getElementById('maxConcurrentInput');
    if (document.activeElement !== maxInput) {
      maxInput.value = String(ov.metrics.maxConcurrent);
    }

    const workersStrip = document.getElementById('workersStrip');
    const workers = Array.isArray(ov.state.workers) ? ov.state.workers : [];
    if (workers.length === 0) {
      workersStrip.innerHTML =
        '<span class="text-slate-400"><i class="fas fa-circle text-[9px] mr-1"></i>No worker daemon heartbeats yet (run <code>npm run orchestrator</code>)</span>';
    } else {
      workersStrip.innerHTML = workers
        .map((w) => {
          const online = w.status === 'online';
          const dotCls = online ? 'bg-emerald-500' : 'bg-slate-300';
          const osIcon =
            w.platform === 'darwin'
              ? 'fab fa-apple'
              : w.platform === 'linux'
                ? 'fab fa-linux'
                : 'fas fa-server';
          return `<span class="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-slate-50 px-2.5 py-0.5 text-[11px] text-slate-700" title="Last heartbeat: ${escapeHtml(formatDateTime(w.lastHeartbeatAt))}">
            <span class="w-2 h-2 rounded-full ${dotCls}"></span>
            <i class="${osIcon}"></i>
            <span class="font-semibold">${escapeHtml(w.workerId)}</span>
            <span class="text-slate-400">(${w.activeCount || 0} active)</span>
          </span>`;
        })
        .join('');
    }
  }

  function renderActiveTasks() {
    const ov = state.overview;
    const list = Array.isArray(ov?.activeTasks) ? ov.activeTasks : [];
    document.getElementById('activeTasksBadge').textContent = String(list.length);
    const container = document.getElementById('activeTasksContainer');

    if (list.length === 0) {
      container.innerHTML = `
        <div class="text-center py-6 text-xs text-slate-500">
          <i class="fas fa-check-circle text-slate-300 text-xl mb-1.5 block"></i>
          No tasks are currently executing. Workers will automatically claim tasks from the queue below.
        </div>`;
      return;
    }

    container.innerHTML = `<div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
      ${list
        .map((t) => {
          const run = t.execution || {};
          const startedMs = run.startedAt ? new Date(run.startedAt).getTime() : 0;
          const elapsed = startedMs ? formatDuration(Date.now() - startedMs) : '—';
          const repos = Array.isArray(run.stagedRepos) ? run.stagedRepos : [];
          const repoChips = repos
            .map(
              (r) =>
                `<span class="px-2 py-0.5 rounded bg-slate-100 text-slate-700 font-mono text-[10px]">${escapeHtml(r.mountRelPath || r.repoKey)}</span>`
            )
            .join(' ');
          const tail = escapeHtml(
            (run.logTail || 'Staging sandbox...').trim().split('\n').slice(-5).join('\n')
          );

          return `<div class="rounded-xl border border-blue-200 bg-blue-50/20 p-4 flex flex-col gap-3">
            <div class="flex items-start justify-between gap-2">
              <div class="min-w-0">
                <div class="flex items-center gap-2 mb-1">
                  ${statusBadgeHtml(run.status || t.status)}
                  <span class="text-[11px] font-semibold text-slate-600">${escapeHtml(t.workspaceName)}</span>
                  <span class="text-[11px] text-slate-400">• ${escapeHtml(elapsed)}</span>
                </div>
                <button
                  type="button"
                  data-open-logs="${escapeHtml(t.id)}"
                  data-task-title="${escapeHtml(t.title)}"
                  class="font-semibold text-blue-600 hover:underline text-sm text-left cursor-pointer"
                >
                  ${escapeHtml(t.title)}
                </button>
                <div class="text-[11px] text-slate-500 mt-0.5">
                  Worker: <code>${escapeHtml(run.workerId || 'claiming')}</code>
                  ${run.workerPid ? `• PID <code>${escapeHtml(run.workerPid)}</code>` : ''}
                </div>
              </div>
              <div class="flex items-center gap-1.5 shrink-0">
                <button
                  type="button"
                  data-open-logs="${escapeHtml(t.id)}"
                  data-task-title="${escapeHtml(t.title)}"
                  class="rounded-lg border border-slate-300 bg-white hover:bg-slate-50 px-2.5 py-1 text-xs font-medium text-slate-700 cursor-pointer"
                >
                  <i class="fas fa-terminal mr-1"></i>Logs
                </button>
                <button
                  type="button"
                  data-kill-task="${escapeHtml(t.id)}"
                  class="btn-danger-strict rounded-lg bg-red-600 px-2.5 py-1 text-xs font-semibold !text-white text-white cursor-pointer"
                  style="color: #ffffff !important;"
                >
                  <i class="fas fa-stop-circle mr-1"></i>Kill
                </button>
              </div>
            </div>
            ${repoChips ? `<div class="flex flex-wrap gap-1">${repoChips}</div>` : ''}
            <pre class="terminal-pre rounded-lg p-2.5 max-h-28 overflow-auto whitespace-pre-wrap m-0">${tail}</pre>
          </div>`;
        })
        .join('')}
    </div>`;
  }

  function renderFilterBar(barId, queryValue, onClearAttr) {
    const bar = document.getElementById(barId);
    if (!queryValue) {
      bar.classList.add('hidden');
      bar.innerHTML = '';
      return;
    }
    bar.classList.remove('hidden');
    bar.innerHTML = `
      <span class="text-slate-500 font-medium text-[11px] uppercase tracking-wider">Active:</span>
      <span class="inline-flex items-center gap-1.5 rounded-full bg-blue-50 border border-blue-200 px-2.5 py-0.5 text-xs text-blue-800">
        Search: "${escapeHtml(queryValue)}"
        <button type="button" ${onClearAttr}="1" class="text-blue-600 hover:text-blue-900 cursor-pointer" aria-label="Remove search filter">
          <i class="fas fa-times"></i>
        </button>
      </span>
      <button type="button" ${onClearAttr}="1" class="text-xs text-blue-600 hover:underline font-semibold cursor-pointer ml-auto">
        <i class="fas fa-times-circle mr-1"></i>Clear all
      </button>
    `;
  }

  function renderQueueTable() {
    const rawQueue = Array.isArray(state.overview?.nextQueue)
      ? state.overview.nextQueue
      : [];
    const term = state.queueSearch.trim().toLowerCase();

    renderFilterBar('activeFilterTagsBar', state.queueSearch.trim(), 'data-clear-queue-search');

    const filtered = !term
      ? rawQueue
      : rawQueue.filter((item) => {
          const hay = [
            item.title,
            item.summary,
            item.workspaceName,
            item.status,
            item.id,
          ]
            .join(' ')
            .toLowerCase();
          return hay.includes(term);
        });

    const tbody = document.getElementById('queueTableBody');
    if (filtered.length === 0) {
      tbody.innerHTML = `<tr>
        <td colspan="6" class="py-10 text-center text-xs text-slate-500">
          ${term ? 'No queued tasks match your active search filter.' : 'No tasks waiting in the queue. Click <strong>+ New Task</strong> to enqueue one.'}
        </td>
      </tr>`;
      return;
    }

    tbody.innerHTML = filtered
      .map((item) => {
        return `<tr
          draggable="${term ? 'false' : 'true'}"
          data-queue-row-id="${escapeHtml(item.id)}"
          class="hover:bg-slate-50/90 transition"
        >
          <td class="py-3 px-4 font-bold text-slate-700 whitespace-nowrap">
            <span class="inline-flex items-center gap-1.5 cursor-grab text-slate-400 mr-1" title="Drag row to reorder">
              <i class="fas fa-grip-vertical"></i>
            </span>
            #${escapeHtml(item.rank)}
          </td>
          <td class="py-3 px-4">
            <button
              type="button"
              data-open-logs="${escapeHtml(item.id)}"
              data-task-title="${escapeHtml(item.title)}"
              class="font-semibold text-blue-600 hover:underline cursor-pointer text-left block"
            >
              ${escapeHtml(item.title)}
            </button>
            <div class="text-[11px] text-slate-500 line-clamp-1 mt-0.5">
              ${escapeHtml(item.summary || item.bodyMarkdown || '')}
            </div>
          </td>
          <td class="py-3 px-4 font-medium text-slate-700">${escapeHtml(item.workspaceName)}</td>
          <td class="py-3 px-4">${statusBadgeHtml(item.status)}</td>
          <td class="py-3 px-4 text-slate-500 whitespace-nowrap">${escapeHtml(formatDateTime(item.occurredAt || item.createdDate))}</td>
          <td class="py-3 px-4 text-right whitespace-nowrap">
            <div class="inline-flex items-center gap-1">
              <button
                type="button"
                data-reorder-op="pin_top"
                data-task-id="${escapeHtml(item.id)}"
                title="Pin to Top (#1)"
                class="rounded border border-blue-200 bg-blue-50 hover:bg-blue-100 px-2 py-1 text-[11px] font-semibold text-blue-700 cursor-pointer"
              >
                <i class="fas fa-angle-double-up mr-0.5"></i>#1
              </button>
              <button
                type="button"
                data-reorder-op="move_up"
                data-task-id="${escapeHtml(item.id)}"
                title="Move Up"
                class="rounded border border-slate-200 bg-white hover:bg-slate-100 px-2 py-1 text-slate-600 cursor-pointer"
              >
                <i class="fas fa-arrow-up"></i>
              </button>
              <button
                type="button"
                data-reorder-op="move_down"
                data-task-id="${escapeHtml(item.id)}"
                title="Move Down"
                class="rounded border border-slate-200 bg-white hover:bg-slate-100 px-2 py-1 text-slate-600 cursor-pointer"
              >
                <i class="fas fa-arrow-down"></i>
              </button>
              <button
                type="button"
                data-cancel-task="${escapeHtml(item.id)}"
                title="Cancel queued task"
                aria-label="Delete"
                class="rounded border border-red-200 bg-red-50 hover:bg-red-100 px-2 py-1 text-red-600 cursor-pointer"
              >
                <i class="fas fa-trash-alt"></i>
              </button>
            </div>
          </td>
        </tr>`;
      })
      .join('');
  }

  function renderHistoryTable() {
    const rawHistory = state.history || [];
    const term = state.historySearch.trim().toLowerCase();

    renderFilterBar('historyFilterTagsBar', state.historySearch.trim(), 'data-clear-history-search');

    const filtered = !term
      ? rawHistory
      : rawHistory.filter((item) => {
          const hay = [
            item.title,
            item.outcome,
            item.workspaceName,
            item.status,
            item.id,
          ]
            .join(' ')
            .toLowerCase();
          return hay.includes(term);
        });

    const tbody = document.getElementById('historyTableBody');
    if (filtered.length === 0) {
      tbody.innerHTML = `<tr>
        <td colspan="6" class="py-10 text-center text-xs text-slate-500">
          ${term ? 'No past tasks match your filter.' : 'No finished tasks recorded yet.'}
        </td>
      </tr>`;
      return;
    }

    tbody.innerHTML = filtered
      .map((item) => {
        const run = item.execution || {};
        const filesCount = Array.isArray(run.attachedFiles)
          ? run.attachedFiles.length
          : 0;
        const branches = Array.isArray(run.pushedBranches)
          ? run.pushedBranches.filter((b) => b && b.branch)
          : [];
        const duration = run.durationMs ? formatDuration(run.durationMs) : '';

        return `<tr class="hover:bg-slate-50/90 transition">
          <td class="py-3 px-4">
            <button
              type="button"
              data-open-logs="${escapeHtml(item.id)}"
              data-task-title="${escapeHtml(item.title)}"
              class="font-semibold text-blue-600 hover:underline cursor-pointer text-left block"
            >
              ${escapeHtml(item.title)}
            </button>
            <div class="text-[11px] text-slate-500 line-clamp-2 mt-0.5">
              ${escapeHtml(item.outcome || run.resultSummary || run.errorReason || '—')}
            </div>
          </td>
          <td class="py-3 px-4 font-medium text-slate-700">${escapeHtml(item.workspaceName)}</td>
          <td class="py-3 px-4">
            ${statusBadgeHtml(item.status)}
            ${duration ? `<div class="text-[10px] text-slate-400 mt-0.5">${escapeHtml(duration)}</div>` : ''}
          </td>
          <td class="py-3 px-4">
            <div class="flex flex-col gap-1">
              <span class="text-[11px] text-slate-600">
                <i class="fas fa-paperclip text-slate-400 mr-1"></i>${filesCount} file(s)
              </span>
              ${branches
                .map(
                  (b) =>
                    `<span class="inline-block rounded bg-emerald-50 border border-emerald-200 px-1.5 py-0.5 font-mono text-[10px] text-emerald-800 truncate max-w-[140px]" title="${escapeHtml(b.branch)}">${escapeHtml(b.branch)}</span>`
                )
                .join('')}
            </div>
          </td>
          <td class="py-3 px-4 text-slate-500 whitespace-nowrap">${escapeHtml(formatDateTime(run.finishedAt || item.updatedDate || item.createdDate))}</td>
          <td class="py-3 px-4 text-right whitespace-nowrap">
            <div class="inline-flex items-center gap-1.5">
              <button
                type="button"
                data-open-logs="${escapeHtml(item.id)}"
                data-task-title="${escapeHtml(item.title)}"
                class="rounded-lg border border-slate-300 bg-white hover:bg-slate-50 px-2.5 py-1 text-xs font-medium text-slate-700 cursor-pointer"
              >
                <i class="fas fa-file-code mr-1"></i>S3 Logs
              </button>
              <button
                type="button"
                data-requeue-top="${escapeHtml(item.id)}"
                class="rounded-lg border border-blue-200 bg-blue-50 hover:bg-blue-100 px-2.5 py-1 text-xs font-semibold text-blue-700 cursor-pointer"
              >
                <i class="fas fa-redo mr-1"></i>Re-queue #1
              </button>
            </div>
          </td>
        </tr>`;
      })
      .join('');
  }

  function populateWorkspaceDropdown() {
    const select = document.getElementById('newTaskWorkspace');
    const workspaces = Array.isArray(state.overview?.workspaces)
      ? state.overview.workspaces
      : [];
    const prevVal = select.value;
    select.innerHTML = workspaces
      .map(
        (w) =>
          `<option value="${escapeHtml(w.id)}">${escapeHtml(w.name)}</option>`
      )
      .join('');
    if (prevVal && workspaces.some((w) => w.id === prevVal)) {
      select.value = prevVal;
    }
  }

  // ---------------------------------------------------------------------------
  // Private S3 Log / JSONL / Patch Inspector Drawer
  // ---------------------------------------------------------------------------
  async function loadAndRenderDrawerLog() {
    const { workItemId, type } = state.logViewer;
    if (!workItemId) return;

    const pre = document.getElementById('logContentPre');
    const badge = document.getElementById('logSourceBadge');
    pre.textContent = 'Fetching private execution artifact via s3-file.service.ts...';

    document.querySelectorAll('.log-tab-btn').forEach((btn) => {
      const isSelected = btn.getAttribute('data-log-type') === type;
      if (isSelected) {
        btn.className = 'log-tab-btn px-3 py-1 rounded-md text-xs font-semibold bg-blue-600 !text-white text-white cursor-pointer';
        btn.style.setProperty('color', '#ffffff', 'important');
      } else {
        btn.className = 'log-tab-btn px-3 py-1 rounded-md text-xs font-semibold bg-white border border-slate-200 text-slate-700 cursor-pointer';
        btn.style.removeProperty('color');
      }
    });

    try {
      const data = await apiFetch(
        `/admin/task-orchestrator/tasks/${encodeURIComponent(workItemId)}/logs?type=${encodeURIComponent(type)}`
      );
      badge.textContent = data.s3Key
        ? `S3 Private Key: ${data.s3Key}`
        : `Source: ${data.source || 'n/a'}`;
      pre.textContent = data.content || '(empty)';
    } catch (err) {
      pre.textContent = `Error loading ${type}: ${err.message}`;
    }
  }

  function openLogDrawer(workItemId, title) {
    state.logViewer = {
      open: true,
      workItemId,
      title: title || workItemId,
      type: 'log',
    };
    document.getElementById('logDrawerTitle').textContent = title || 'Task Logs';
    document.getElementById('logDrawerSubtitle').textContent = `Task ID: ${workItemId}`;
    document.getElementById('logDrawerBackdrop').classList.remove('hidden');
    loadAndRenderDrawerLog();
  }

  function closeLogDrawer() {
    state.logViewer.open = false;
    document.getElementById('logDrawerBackdrop').classList.add('hidden');
  }

  // ---------------------------------------------------------------------------
  // Event Listeners & Drag-and-Drop Queue Reordering
  // ---------------------------------------------------------------------------
  function bindEvents() {
    document
      .getElementById('loginForm')
      .addEventListener('submit', handleLoginSubmit);

    document.getElementById('logoutBtn').addEventListener('click', () => {
      sessionStorage.removeItem(SESSION_TOKEN_KEY);
      state.token = '';
      showAuthScreen();
    });

    document.getElementById('manualRefreshBtn').addEventListener('click', () => {
      refreshAllData();
    });

    // Tab switching
    const switchTab = (tab) => {
      state.activeTab = tab;
      const isQueue = tab === 'queue';
      document.getElementById('tabPanelQueue').classList.toggle('hidden', !isQueue);
      document.getElementById('tabPanelHistory').classList.toggle('hidden', isQueue);
      document.getElementById('tabBtnQueue').className = isQueue
        ? 'px-4 py-2.5 text-xs sm:text-sm font-semibold border-b-2 border-blue-600 text-blue-600 cursor-pointer'
        : 'px-4 py-2.5 text-xs sm:text-sm font-semibold border-b-2 border-transparent text-slate-500 hover:text-slate-800 cursor-pointer';
      document.getElementById('tabBtnHistory').className = !isQueue
        ? 'px-4 py-2.5 text-xs sm:text-sm font-semibold border-b-2 border-blue-600 text-blue-600 cursor-pointer'
        : 'px-4 py-2.5 text-xs sm:text-sm font-semibold border-b-2 border-transparent text-slate-500 hover:text-slate-800 cursor-pointer';
    };
    document.getElementById('tabBtnQueue').addEventListener('click', () => switchTab('queue'));
    document.getElementById('tabBtnHistory').addEventListener('click', () => switchTab('history'));

    // Live MAX_CONCURRENT update
    document.getElementById('applyConcurrencyBtn').addEventListener('click', async () => {
      const btn = document.getElementById('applyConcurrencyBtn');
      const orig = btn.innerHTML;
      btn.disabled = true;
      btn.innerHTML = '...';
      btn.style.setProperty('color', '#ffffff', 'important');
      try {
        const val = parseInt(document.getElementById('maxConcurrentInput').value, 10);
        await apiFetch('/admin/task-orchestrator/config', {
          method: 'PATCH',
          body: { maxConcurrent: val },
        });
        showToast(`Live MAX_CONCURRENT updated to ${val}.`, 'success');
        await refreshAllData();
      } catch (err) {
        showToast(err.message, 'error');
      } finally {
        btn.disabled = false;
        btn.innerHTML = orig;
        btn.style.setProperty('color', '#ffffff', 'important');
      }
    });

    // Soft Pause / Resume
    document.getElementById('togglePauseBtn').addEventListener('click', async () => {
      try {
        const isPaused = Boolean(
          state.overview?.state?.paused || state.overview?.state?.hardPaused
        );
        await apiFetch('/admin/task-orchestrator/config', {
          method: 'PATCH',
          body: { paused: !isPaused, hardPaused: false },
        });
        showToast(isPaused ? 'Orchestrator resumed.' : 'Orchestrator paused.', 'success');
        await refreshAllData();
      } catch (err) {
        showToast(err.message, 'error');
      }
    });

    // Hard Stop
    document.getElementById('hardPauseBtn').addEventListener('click', async () => {
      try {
        await apiFetch('/admin/task-orchestrator/config', {
          method: 'PATCH',
          body: { paused: true, hardPaused: true },
        });
        showToast('Hard Stop activated — active worker tasks signaled to terminate.', 'info');
        await refreshAllData();
      } catch (err) {
        showToast(err.message, 'error');
      }
    });

    // Search filters + Clear all
    document.getElementById('queueSearchInput').addEventListener('input', (e) => {
      state.queueSearch = e.target.value;
      renderQueueTable();
    });
    document.getElementById('historySearchInput').addEventListener('input', (e) => {
      state.historySearch = e.target.value;
      renderHistoryTable();
    });

    // New Task Modal lifecycle (AGENTS.md Auto-Close + finally button reset)
    const modal = document.getElementById('newTaskModal');
    const closeModal = () => modal.classList.add('hidden');
    document.getElementById('openNewTaskModalBtn').addEventListener('click', () => {
      populateWorkspaceDropdown();
      modal.classList.remove('hidden');
    });
    document.getElementById('closeNewTaskModalBtn').addEventListener('click', closeModal);
    document.getElementById('cancelNewTaskBtn').addEventListener('click', closeModal);

    document.getElementById('newTaskForm').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const btn = document.getElementById('submitNewTaskBtn');
      const orig = btn.innerHTML;
      btn.disabled = true;
      btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-1"></i> Saving...';
      btn.style.setProperty('color', '#ffffff', 'important');
      try {
        const projectId = document.getElementById('newTaskWorkspace').value;
        const title = document.getElementById('newTaskTitle').value.trim();
        const bodyMarkdown = document.getElementById('newTaskBody').value.trim();
        const pinToTop = document.getElementById('newTaskPinTop').checked;

        await apiFetch('/admin/task-orchestrator/queue/tasks', {
          method: 'POST',
          body: { projectId, title, summary: title, bodyMarkdown, pinToTop },
        });
        document.getElementById('newTaskTitle').value = '';
        document.getElementById('newTaskBody').value = '';
        closeModal();
        showToast(
          pinToTop ? 'Task pinned at Rank #1!' : 'Task added to queue.',
          'success'
        );
        await refreshAllData();
      } catch (err) {
        showToast(err.message, 'error');
      } finally {
        btn.disabled = false;
        btn.innerHTML = orig;
        btn.style.setProperty('color', '#ffffff', 'important');
      }
    });

    // Log Drawer events
    document.getElementById('closeLogDrawerBtn').addEventListener('click', closeLogDrawer);
    document.getElementById('refreshLogBtn').addEventListener('click', loadAndRenderDrawerLog);
    document.querySelectorAll('.log-tab-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.logViewer.type = btn.getAttribute('data-log-type') || 'log';
        loadAndRenderDrawerLog();
      });
    });

    // Delegated actions across tables/cards
    document.body.addEventListener('click', async (ev) => {
      const clearQ = ev.target.closest('[data-clear-queue-search]');
      if (clearQ) {
        state.queueSearch = '';
        document.getElementById('queueSearchInput').value = '';
        renderQueueTable();
        return;
      }
      const clearH = ev.target.closest('[data-clear-history-search]');
      if (clearH) {
        state.historySearch = '';
        document.getElementById('historySearchInput').value = '';
        renderHistoryTable();
        return;
      }

      const logBtn = ev.target.closest('[data-open-logs]');
      if (logBtn) {
        openLogDrawer(
          logBtn.getAttribute('data-open-logs'),
          logBtn.getAttribute('data-task-title')
        );
        return;
      }

      const reorderBtn = ev.target.closest('[data-reorder-op]');
      if (reorderBtn) {
        const workItemId = reorderBtn.getAttribute('data-task-id');
        const operation = reorderBtn.getAttribute('data-reorder-op');
        try {
          await apiFetch('/admin/task-orchestrator/queue/reorder', {
            method: 'PATCH',
            body: { workItemId, operation },
          });
          await refreshAllData();
        } catch (err) {
          showToast(err.message, 'error');
        }
        return;
      }

      const cancelBtn = ev.target.closest('[data-cancel-task]');
      if (cancelBtn) {
        const id = cancelBtn.getAttribute('data-cancel-task');
        // Optimistic UI removal from queue
        if (state.overview && Array.isArray(state.overview.nextQueue)) {
          state.overview.nextQueue = state.overview.nextQueue.filter((i) => i.id !== id);
          renderQueueTable();
        }
        try {
          await apiFetch(`/admin/task-orchestrator/tasks/${encodeURIComponent(id)}/control`, {
            method: 'POST',
            body: { action: 'cancel' },
          });
          showToast('Task cancelled from queue.', 'success');
          await refreshAllData();
        } catch (err) {
          showToast(err.message, 'error');
          await refreshAllData();
        }
        return;
      }

      const killBtn = ev.target.closest('[data-kill-task]');
      if (killBtn) {
        const id = killBtn.getAttribute('data-kill-task');
        try {
          await apiFetch(`/admin/task-orchestrator/tasks/${encodeURIComponent(id)}/control`, {
            method: 'POST',
            body: { action: 'kill' },
          });
          showToast('Kill signal sent to worker.', 'info');
          await refreshAllData();
        } catch (err) {
          showToast(err.message, 'error');
        }
        return;
      }

      const requeueBtn = ev.target.closest('[data-requeue-top]');
      if (requeueBtn) {
        const id = requeueBtn.getAttribute('data-requeue-top');
        try {
          await apiFetch(`/admin/task-orchestrator/tasks/${encodeURIComponent(id)}/control`, {
            method: 'POST',
            body: { action: 'requeue_top' },
          });
          showToast('Task re-queued at Rank #1!', 'success');
          switchTab('queue');
          await refreshAllData();
        } catch (err) {
          showToast(err.message, 'error');
        }
      }
    });

    // HTML5 Drag-and-Drop Queue Reordering
    const tbody = document.getElementById('queueTableBody');
    tbody.addEventListener('dragstart', (ev) => {
      const row = ev.target.closest('[data-queue-row-id]');
      if (!row) return;
      state.draggingWorkItemId = row.getAttribute('data-queue-row-id');
      row.classList.add('queue-row-dragging');
      ev.dataTransfer.effectAllowed = 'move';
    });

    tbody.addEventListener('dragend', (ev) => {
      const row = ev.target.closest('[data-queue-row-id]');
      if (row) row.classList.remove('queue-row-dragging');
      tbody
        .querySelectorAll('.queue-row-drop-target')
        .forEach((el) => el.classList.remove('queue-row-drop-target'));
      state.draggingWorkItemId = null;
    });

    tbody.addEventListener('dragover', (ev) => {
      const row = ev.target.closest('[data-queue-row-id]');
      if (!row || !state.draggingWorkItemId) return;
      ev.preventDefault();
      tbody
        .querySelectorAll('.queue-row-drop-target')
        .forEach((el) => el.classList.remove('queue-row-drop-target'));
      row.classList.add('queue-row-drop-target');
    });

    tbody.addEventListener('drop', async (ev) => {
      ev.preventDefault();
      const targetRow = ev.target.closest('[data-queue-row-id]');
      const draggedId = state.draggingWorkItemId;
      if (!targetRow || !draggedId) return;
      const targetId = targetRow.getAttribute('data-queue-row-id');
      if (!targetId || targetId === draggedId) return;

      const list = Array.isArray(state.overview?.nextQueue)
        ? [...state.overview.nextQueue]
        : [];
      const fromIdx = list.findIndex((i) => i.id === draggedId);
      const toIdx = list.findIndex((i) => i.id === targetId);
      if (fromIdx < 0 || toIdx < 0) return;

      // Optimistic reorder
      const [moved] = list.splice(fromIdx, 1);
      list.splice(toIdx, 0, moved);
      list.forEach((item, idx) => {
        item.rank = idx + 1;
      });
      state.overview.nextQueue = list;
      renderQueueTable();

      try {
        await apiFetch('/admin/task-orchestrator/queue/reorder', {
          method: 'PATCH',
          body: { orderedWorkItemIds: list.map((i) => i.id) },
        });
        showToast('Queue order updated.', 'success');
        await refreshAllData({ silent: true });
      } catch (err) {
        showToast(err.message, 'error');
        await refreshAllData();
      }
    });
  }

  // Bootstrap
  document.addEventListener('DOMContentLoaded', async () => {
    bindEvents();
    if (state.token) {
      try {
        await verifySessionAndEnterDashboard(state.token);
      } catch (_) {
        sessionStorage.removeItem(SESSION_TOKEN_KEY);
        state.token = '';
        showAuthScreen();
      }
    } else {
      showAuthScreen();
    }
  });
})();

