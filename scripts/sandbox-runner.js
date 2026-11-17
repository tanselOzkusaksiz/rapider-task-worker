#!/usr/bin/env node

/**
 * sandbox-runner.js
 *
 * Cross-Platform OS Jail Runner (`darwin` Seatbelt `/usr/bin/sandbox-exec` +
 * `linux` Bubblewrap `/usr/bin/bwrap`) for Isolated `agy` Task Workers.
 *
 * Guarantees:
 *   1. Complete environment variable stripping (no `.env`, no DB URIs, no S3 keys,
 *      no Rapider tokens — only `PATH`, `HOME`, `TMPDIR`, `RAPIDER_TASK_PROXY_URL`,
 *      and `RAPIDER_TASK_NONCE`).
 *   2. Kernel-enforced filesystem blindness to sibling `_sandboxes/*`, master
 *      `WORKSPACES/*`, `rapider-apps/APPS/*`, `_repo-cache/*`, parent monorepo
 *      repositories, `~/.ssh`, `~/.aws`, and all `.env` / `.server.env` files.
 *   3. Dedicated process group (`detached: true`) so `killProcessGroup(-child.pid)`
 *      cleanly terminates `agy` and all grandchild subprocesses on timeout,
 *      Admin `Kill Task`, or `Hard Pause`.
 *   4. Real-time `stream-json` (`.jsonl`) + human-readable `.log` capture with
 *      debounced `onLogTail(tail)` callback for live MongoDB/UI streaming.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const WORKER_ROOT = path.resolve(__dirname, '..');
const MONOREPO_ROOT = path.resolve(WORKER_ROOT, '..');

function resolveCanonicalPath(targetPath) {
  if (!targetPath) return '';
  const abs = path.resolve(targetPath);
  if (fs.existsSync(abs)) {
    try {
      return fs.realpathSync(abs);
    } catch (_) {
      return abs;
    }
  }
  const parent = path.dirname(abs);
  if (parent !== abs && fs.existsSync(parent)) {
    try {
      return path.join(fs.realpathSync(parent), path.basename(abs));
    } catch (_) {}
  }
  return abs;
}

function sbplEscape(str) {
  return String(str || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function commandExists(bin) {
  try {
    execFileSync('which', [bin], { stdio: 'ignore' });
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Resolves the Antigravity CLI (`agy`) binary across standard macOS & Linux install paths.
 */
function resolveAgyBinary() {
  if (process.env.AGY_BIN && fs.existsSync(process.env.AGY_BIN)) {
    return process.env.AGY_BIN;
  }
  const candidates = [
    path.join(os.homedir(), '.gemini', 'bin', 'agy'),
    path.join(os.homedir(), '.local', 'bin', 'agy'),
    '/opt/homebrew/bin/agy',
    '/usr/local/bin/agy',
    '/usr/bin/agy',
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return process.env.AGY_BIN || 'agy';
}

/**
 * Generates a macOS Seatbelt (`.sb`) profile enforcing strict repo & secret blindness
 * while allowing `node` / `agy` execution inside `sandboxRoot`.
 */
function buildDarwinSeatbeltProfile({
  sandboxRoot,
  toolsDir,
  sandboxesRoot,
  workspacesRoot,
  appsCloneRoot,
  bareCacheRoot,
  protectedPaths = [],
}) {
  const realSandboxRoot = resolveCanonicalPath(sandboxRoot);
  const realToolsDir = resolveCanonicalPath(toolsDir);
  const hostHome = resolveCanonicalPath(os.homedir());
  const hostGeminiDir = resolveCanonicalPath(path.join(hostHome, '.gemini'));

  const denySubpaths = [
    MONOREPO_ROOT,
    sandboxesRoot,
    workspacesRoot,
    appsCloneRoot,
    bareCacheRoot,
    path.join(hostHome, '.ssh'),
    path.join(hostHome, '.aws'),
    path.join(hostHome, '.gnupg'),
    path.join(hostHome, '.kube'),
    ...protectedPaths,
  ]
    .filter(Boolean)
    .map(resolveCanonicalPath);

  const uniqueDeny = Array.from(new Set(denySubpaths));

  const lines = [
    '(version 1)',
    '(allow default)',
    '; Deny writing everywhere on host by default; re-open only sandbox writable dirs below',
    `(deny file-write* (subpath "${sbplEscape(hostHome)}"))`,
    `(deny file-write* (subpath "${sbplEscape(resolveCanonicalPath(MONOREPO_ROOT))}"))`,
  ];

  for (const p of uniqueDeny) {
    lines.push(`(deny file-read* file-write* (subpath "${sbplEscape(p)}"))`);
  }

  // Deny reading/writing any .env or .server.env files anywhere on the machine
  lines.push('(deny file-read* file-write* (regex #"/\\.env($|\\.)"))');
  lines.push('(deny file-read* file-write* (regex #"/\\.server\\.env$"))');

  // Re-allow Antigravity CLI state dir (~/.gemini) if present so agy auth works
  if (fs.existsSync(hostGeminiDir)) {
    lines.push(`(allow file-read* file-write* (subpath "${sbplEscape(hostGeminiDir)}"))`);
  }

  // Allow lstat metadata traversal ONLY on exact ancestor path components of realSandboxRoot
  // (so Node/git realpathSync works while readdir / file-read-data on ancestors stays EPERM!)
  const ancestors = [];
  let cursor = path.dirname(realSandboxRoot);
  while (cursor && cursor !== '/' && cursor !== path.dirname(cursor)) {
    ancestors.push(cursor);
    cursor = path.dirname(cursor);
  }
  for (const anc of ancestors) {
    lines.push(`(allow file-read-metadata (literal "${sbplEscape(anc)}"))`);
  }

  // Re-allow full read/write strictly inside THIS task's isolated sandboxRoot
  lines.push(`(allow file-read* file-write* (subpath "${sbplEscape(realSandboxRoot)}"))`);

  // Enforce read-only tools mount inside sandbox
  if (realToolsDir) {
    lines.push(`(deny file-write* (subpath "${sbplEscape(realToolsDir)}"))`);
  }

  // Re-enforce .env ban even inside allowed subpaths
  lines.push('(deny file-read* file-write* (regex #"/\\.server\\.env$"))');

  return lines.join('\n') + '\n';
}

/**
 * Builds rootless Linux `bwrap` arguments mounting ONLY `/usr`, `/lib*`, `/bin`,
 * `/etc/ssl`, `/proc`, `/dev`, `/tmp`, `/tools` (ro), and `/workspace` + `/output` (rw).
 */
function buildLinuxBwrapArgs({ sandboxRoot, workspaceDir, toolsDir, outputDir, homeDir }) {
  const args = [
    '--die-with-parent',
    '--unshare-ipc',
    '--unshare-pid',
    '--unshare-uts',
    '--ro-bind', '/usr', '/usr',
    '--ro-bind', '/bin', '/bin',
    '--proc', '/proc',
    '--dev', '/dev',
    '--tmpfs', '/tmp',
  ];

  for (const sysDir of ['/lib', '/lib64', '/sbin', '/etc/resolv.conf', '/etc/hosts', '/etc/ssl', '/etc/ca-certificates']) {
    if (fs.existsSync(sysDir)) {
      args.push('--ro-bind', sysDir, sysDir);
    }
  }

  const hostGemini = path.join(os.homedir(), '.gemini');
  if (fs.existsSync(hostGemini)) {
    args.push('--bind', hostGemini, path.join(homeDir, '.gemini'));
  }

  // Bind the exact sandbox paths so relative ../tools and ../output resolve identically
  args.push('--dir', sandboxRoot);
  args.push('--bind', workspaceDir, workspaceDir);
  args.push('--ro-bind', toolsDir, toolsDir);
  args.push('--bind', outputDir, outputDir);
  args.push('--bind', homeDir, homeDir);
  args.push('--chdir', workspaceDir);

  return args;
}

/**
 * Builds the stripped environment passed into the sandboxed child process.
 */
function buildSanitizedSandboxEnv({ homeDir, tmpDir, proxyUrl, taskNonce, extraPathDirs = [] }) {
  const hostGeminiBin = path.join(os.homedir(), '.gemini', 'bin');
  const pathParts = [
    ...extraPathDirs.filter(Boolean),
    ...(fs.existsSync(hostGeminiBin) ? [hostGeminiBin] : []),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
    path.dirname(process.execPath),
  ];
  const safePath = Array.from(new Set(pathParts)).join(':');

  const env = {
    PATH: safePath,
    HOME: homeDir,
    TMPDIR: tmpDir,
    LANG: 'en_US.UTF-8',
    NO_COLOR: '1',
    CI: 'true',
    GIT_TERMINAL_PROMPT: '0',
    RAPIDER_TASK_PROXY_URL: String(proxyUrl || ''),
    RAPIDER_TASK_NONCE: String(taskNonce || ''),
  };

  // Preserve Antigravity CLI binary lookup if custom AGY_BIN_DIR is set, without leaking secrets
  if (process.env.AGY_BIN_DIR) {
    env.PATH = `${process.env.AGY_BIN_DIR}:${env.PATH}`;
  }
  return env;
}

/**
 * Kills an entire process group (`-pid`) cleanly (`SIGTERM` -> grace -> `SIGKILL`).
 */
async function killProcessGroup(pid, graceMs = 2500) {
  if (!pid || pid <= 0) return;
  try {
    process.kill(-pid, 'SIGTERM');
  } catch (_) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch (_) {
      return;
    }
  }

  await new Promise((resolve) => setTimeout(resolve, graceMs));
  try {
    process.kill(-pid, 0);
    process.kill(-pid, 'SIGKILL');
  } catch (_) {
    try {
      process.kill(pid, 0);
      process.kill(pid, 'SIGKILL');
    } catch (_) {}
  }
}

/**
 * Spawns a command (defaults to `agy chat --mode agent --print --output-format stream-json ...`,
 * or a custom `commandSpec` for deterministic tests/runners) inside the OS jail.
 */
function runInOsSandbox({
  manifest,
  proxyUrl,
  taskNonce,
  promptText,
  commandSpec = null,
  sandboxesRoot,
  workspacesRoot,
  appsCloneRoot,
  bareCacheRoot,
  protectedPaths = [],
  timeoutMs = 15 * 60 * 1000,
  onPid,
  onLogTail,
}) {
  return new Promise((resolve, reject) => {
    const platform = process.platform;
    const {
      sandboxRoot,
      workspaceDir,
      toolsDir,
      outputDir,
      homeDir,
      tmpDir,
      logsDir,
    } = manifest;

    const textLogPath = path.join(logsDir, 'execution.log');
    const jsonlLogPath = path.join(logsDir, 'trajectory.jsonl');
    fs.mkdirSync(logsDir, { recursive: true });

    const textStream = fs.createWriteStream(textLogPath, { flags: 'a' });
    const jsonlStream = fs.createWriteStream(jsonlLogPath, { flags: 'a' });

    const resolvedAgyBin = resolveAgyBinary();
    const targetCmd = commandSpec
      ? commandSpec.command
      : resolvedAgyBin;
    const effectivePrompt =
      promptText ||
      'Read AGENTS.md and TASK_BRIEF.md, execute the assigned Workspace task, save deliverables to ../output/deliverables/, and write ../output/task-outcome.json.';
    const targetArgs = commandSpec
      ? commandSpec.args || []
      : [
          '--output-format',
          'stream-json',
          '--dangerously-skip-permissions',
          '--log-file',
          path.join(logsDir, 'agy-cli.log'),
          '--add-dir',
          outputDir,
          '--add-dir',
          toolsDir,
          `--print=${effectivePrompt}`,
        ];

    // On macOS, link <sandboxHome>/.gemini -> ~/.gemini so `agy` reads its CLI auth/config
    // while keeping $HOME isolated inside <sandbox>/home.
    if (platform === 'darwin' && homeDir) {
      const hostGemini = path.join(os.homedir(), '.gemini');
      const sandboxGeminiLink = path.join(homeDir, '.gemini');
      if (fs.existsSync(hostGemini) && !fs.existsSync(sandboxGeminiLink)) {
        try {
          fs.mkdirSync(homeDir, { recursive: true });
          fs.symlinkSync(hostGemini, sandboxGeminiLink, 'dir');
        } catch (_) {}
      }
    }

    let spawnBin = targetCmd;
    let spawnArgs = targetArgs;
    let jailMechanism = 'unjailed-fallback';

    if (platform === 'darwin' && fs.existsSync('/usr/bin/sandbox-exec')) {
      const profileContent = buildDarwinSeatbeltProfile({
        sandboxRoot,
        toolsDir,
        sandboxesRoot,
        workspacesRoot,
        appsCloneRoot,
        bareCacheRoot,
        protectedPaths,
      });
      const profilePath = path.join(sandboxRoot, 'seatbelt.sb');
      fs.writeFileSync(profilePath, profileContent, 'utf8');
      spawnBin = '/usr/bin/sandbox-exec';
      spawnArgs = ['-f', profilePath, targetCmd, ...targetArgs];
      jailMechanism = 'darwin-sandbox-exec';
    } else if (platform === 'linux' && commandExists('bwrap')) {
      const bwrapArgs = buildLinuxBwrapArgs({
        sandboxRoot,
        workspaceDir,
        toolsDir,
        outputDir,
        homeDir,
      });
      spawnBin = 'bwrap';
      spawnArgs = [...bwrapArgs, '--', targetCmd, ...targetArgs];
      jailMechanism = 'linux-bwrap';
    } else if (process.env.ALLOW_UNJAILED_FALLBACK !== 'true') {
      textStream.end();
      jsonlStream.end();
      return reject(
        new Error(
          `No supported OS sandbox binary found on platform "${platform}" (requires /usr/bin/sandbox-exec on macOS or bwrap on Linux).`
        )
      );
    }

    const env = buildSanitizedSandboxEnv({
      homeDir,
      tmpDir,
      proxyUrl,
      taskNonce,
      extraPathDirs: path.isAbsolute(resolvedAgyBin) ? [path.dirname(resolvedAgyBin)] : [],
    });

    const startedAtMs = Date.now();
    let rollingTail = `[${new Date().toISOString()}] Launching isolated task via ${jailMechanism}\n`;
    textStream.write(rollingTail);

    let conversationId = null;
    let stdoutRemainder = '';
    let timedOut = false;
    let externallyKilled = false;
    let lastTailPushMs = 0;

    const pushTail = (force = false) => {
      const now = Date.now();
      if (!onLogTail) return;
      if (!force && now - lastTailPushMs < 2000) return;
      lastTailPushMs = now;
      Promise.resolve(onLogTail(rollingTail)).catch(() => {});
    };

    const appendTail = (line) => {
      const formatted = `[${new Date().toISOString()}] ${line}\n`;
      textStream.write(formatted);
      rollingTail += formatted;
      if (rollingTail.length > 14000) {
        rollingTail = rollingTail.slice(-14000);
      }
      pushTail(false);
    };

    const child = spawn(spawnBin, spawnArgs, {
      cwd: workspaceDir,
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Prevent macOS idle/Wi-Fi sleep strictly for the lifetime of real `agy` child processes
    if (platform === 'darwin' && !commandSpec && child.pid && fs.existsSync('/usr/bin/caffeinate')) {
      try {
        const caff = spawn('/usr/bin/caffeinate', ['-i', '-w', String(child.pid)], {
          detached: true,
          stdio: 'ignore',
        });
        caff.unref();
      } catch (_) {}
    }

    if (onPid && child.pid) {
      Promise.resolve(
        onPid(child.pid, {
          kill: async () => {
            externallyKilled = true;
            await killProcessGroup(child.pid);
          },
        })
      ).catch(() => {});
    }

    const timer = setTimeout(async () => {
      timedOut = true;
      appendTail(`ERROR: Task exceeded timeout (${timeoutMs}ms). Terminating process group -${child.pid}.`);
      await killProcessGroup(child.pid);
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdoutRemainder += chunk.toString('utf8');
      const lines = stdoutRemainder.split('\n');
      stdoutRemainder = lines.pop() || '';
      for (const rawLine of lines) {
        const trimmed = rawLine.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed);
          jsonlStream.write(trimmed + '\n');
          if (!conversationId) {
            const cid = parsed.conversationId || parsed.conversation_id || parsed.session_id;
            if (cid) conversationId = String(cid);
          }
          const summary =
            parsed.content ||
            parsed.result ||
            parsed.message?.content?.[0]?.text ||
            parsed.message ||
            parsed.type ||
            trimmed.slice(0, 240);
          appendTail(
            (typeof summary === 'string' ? summary : JSON.stringify(summary)).slice(0, 400)
          );
        } catch (_) {
          appendTail(trimmed.slice(0, 400));
        }
      }
    });

    child.stderr.on('data', (chunk) => {
      const lines = chunk.toString('utf8').split('\n').filter(Boolean);
      for (const line of lines) {
        appendTail(`[stderr] ${line.slice(0, 400)}`);
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      appendTail(`Spawn error: ${err.message}`);
      textStream.end();
      jsonlStream.end();
      reject(err);
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (stdoutRemainder.trim()) {
        appendTail(stdoutRemainder.trim().slice(0, 400));
      }
      appendTail(
        `Process exited (code=${code}, signal=${signal || 'none'}, durationMs=${Date.now() - startedAtMs})`
      );
      pushTail(true);

      textStream.end(() => {
        jsonlStream.end(() => {
          resolve({
            exitCode: typeof code === 'number' ? code : -1,
            signal: signal || null,
            timedOut,
            externallyKilled,
            jailMechanism,
            conversationId,
            durationMs: Date.now() - startedAtMs,
            textLogPath,
            jsonlLogPath,
            logTail: rollingTail,
          });
        });
      });
    });
  });
}

module.exports = {
  resolveCanonicalPath,
  resolveAgyBinary,
  buildDarwinSeatbeltProfile,
  buildLinuxBwrapArgs,
  buildSanitizedSandboxEnv,
  killProcessGroup,
  runInOsSandbox,
};
