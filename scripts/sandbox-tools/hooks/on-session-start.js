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
      '1. Read TASK_BRIEF.md, .agents/project-data-models.md, .agents/project-data-manager-guide.md, .agents/workspace-datasources-and-integrations.md, and workspace-context/_notebooks/INDEX.md first.',
      `2. ${attachNote}`,
      '3. Use `node ../tools/rapider-task-cli.js` for live Workspace data queries and HTML/CSV/PDF/Handlebars verification.',
      '4. Default Deliverable Rule: For reports, forecasts, and analyses, generate a well-designed printable Tailwind `.html` page (with Executive Summary, KPI cards, inline SVG charts, formatted tables, and `window.print()` button) + companion `.csv` schedule(s) in `../output/deliverables/`, list the `.html` file first in `deliverableFiles`, and finalize `../output/task-outcome.json`.',
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

