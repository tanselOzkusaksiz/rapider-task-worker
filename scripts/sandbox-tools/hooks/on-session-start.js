#!/usr/bin/env node

/**
 * on-session-start.js
 *
 * Antigravity `SessionStart` hook executed inside the isolated task sandbox.
 * Injects a concise startup checklist reminding the agent to inspect `TASK_BRIEF.md`,
 * `.task-attachments/`, `workspace-context/WORKSPACE_CONTEXT.md`, and write
 * `../output/task-outcome.json` before stopping.
 */

const fs = require('fs');
const path = require('path');

let rawInput = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  rawInput += chunk;
});
process.stdin.on('end', () => {
  try {
    const cwd = process.cwd();
    const attachDir = path.join(cwd, '.task-attachments');
    let attachmentList = [];
    if (fs.existsSync(attachDir)) {
      attachmentList = fs
        .readdirSync(attachDir)
        .filter((f) => !f.startsWith('.'));
    }

    const attachNote =
      attachmentList.length > 0
        ? `MANDATORY: Inspect all ${attachmentList.length} attached file(s) in .task-attachments/ (${attachmentList.join(', ')}) before planning.`
        : 'No pre-downloaded attachments in .task-attachments/.';

    const msg = [
      '[Isolated Task Sandbox Ready]',
      '1. Read TASK_BRIEF.md and workspace-context/WORKSPACE_CONTEXT.md first.',
      `2. ${attachNote}`,
      '3. Use `node ../tools/rapider-task-cli.js` for live Workspace data queries and CSV/PDF/Handlebars verification.',
      '4. Write deliverables to `../output/deliverables/` and finalize `../output/task-outcome.json` before ending your turn.',
    ].join(' ');

    process.stdout.write(
      JSON.stringify({
        injectSteps: [
          {
            systemMessage: {
              systemMessage: msg,
            },
          },
        ],
      })
    );
  } catch (_) {
    process.stdout.write(JSON.stringify({}));
  }
});
