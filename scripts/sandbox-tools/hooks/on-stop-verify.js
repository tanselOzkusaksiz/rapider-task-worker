#!/usr/bin/env node

/**
 * on-stop-verify.js
 *
 * Antigravity `Stop` hook executed inside the isolated task sandbox.
 * When `terminationReason === "NO_TOOL_CALL"` and `!continuationActive`, verifies:
 *   1. `../output/task-outcome.json` exists and parses as valid JSON with `status` + `publicReplyMarkdown`.
 *   2. Every filename listed in `deliverableFiles` exists inside `../output/deliverables/`.
 *   3. `publicReplyMarkdown` and `outcomeSummary` pass the Public Reply Confidentiality gate
 *      (no leaked `/Users/...`, `_sandboxes/`, `WORKSPACES/`, script names, or model names).
 *
 * If any check fails on the first stop attempt, returns `{"decision":"continue","reason":"..."}`
 * so the agent fixes it immediately before the process exits!
 */

const fs = require('fs');
const path = require('path');

const CONFIDENTIALITY_CHECKS = [
  { pattern: /\/Users\/[A-Za-z0-9._-]+/i, reason: 'leaks host path (/Users/...)' },
  { pattern: /_sandboxes\/|\bWORKSPACES\//i, reason: 'leaks internal sandbox/workspace path' },
  { pattern: /\brapider-task-cli\.js\b|\bISOLATED-TASK-WORKER\b/i, reason: 'mentions internal CLI/worker script names' },
  { pattern: /\b(?:gemini-\d|gpt-4|gpt-5|claude-3|claude-sonnet|claude-opus)\b/i, reason: 'mentions underlying AI model name' },
];

let rawInput = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  rawInput += chunk;
});
process.stdin.on('end', () => {
  try {
    const input = rawInput.trim() ? JSON.parse(rawInput) : {};
    if (input.continuationActive) {
      process.stdout.write(JSON.stringify({ decision: 'allow' }));
      return;
    }
    if (input.terminationReason && input.terminationReason !== 'NO_TOOL_CALL') {
      process.stdout.write(JSON.stringify({ decision: 'allow' }));
      return;
    }

    const cwd = input.cwd || process.cwd();
    const outcomePath = path.resolve(cwd, '../output/task-outcome.json');
    const deliverablesDir = path.resolve(cwd, '../output/deliverables');

    if (!fs.existsSync(outcomePath)) {
      process.stdout.write(
        JSON.stringify({
          decision: 'continue',
          reason:
            'Missing `../output/task-outcome.json`. Write valid JSON containing status, outcomeSummary, publicReplyMarkdown, and deliverableFiles before finishing.',
        })
      );
      return;
    }

    let outcome;
    try {
      outcome = JSON.parse(fs.readFileSync(outcomePath, 'utf8'));
    } catch (err) {
      process.stdout.write(
        JSON.stringify({
          decision: 'continue',
          reason: `Invalid JSON in ../output/task-outcome.json: ${err.message}. Fix the JSON syntax.`,
        })
      );
      return;
    }

    const validStatuses = new Set(['resolved', 'pending', 'rejected', 'failed']);
    if (!validStatuses.has(String(outcome.status || '').toLowerCase())) {
      process.stdout.write(
        JSON.stringify({
          decision: 'continue',
          reason:
            '../output/task-outcome.json must specify status as one of: "resolved", "pending", "rejected", or "failed".',
        })
      );
      return;
    }

    if (!outcome.publicReplyMarkdown || !String(outcome.publicReplyMarkdown).trim()) {
      process.stdout.write(
        JSON.stringify({
          decision: 'continue',
          reason:
            '../output/task-outcome.json must include a non-empty `publicReplyMarkdown` message for the user.',
        })
      );
      return;
    }

    const combinedPublic = `${outcome.outcomeSummary || ''}\n${outcome.publicReplyMarkdown || ''}`;
    const leaks = CONFIDENTIALITY_CHECKS.filter((c) => c.pattern.test(combinedPublic)).map(
      (c) => c.reason
    );
    if (leaks.length > 0) {
      process.stdout.write(
        JSON.stringify({
          decision: 'continue',
          reason: `Public reply confidentiality violation (${leaks.join(', ')}). Rewrite publicReplyMarkdown and outcomeSummary without internal paths, script names, or model names.`,
        })
      );
      return;
    }

    if (Array.isArray(outcome.deliverableFiles)) {
      const missing = outcome.deliverableFiles.filter((f) => {
        const clean = path.basename(String(f || ''));
        return !clean || !fs.existsSync(path.join(deliverablesDir, clean));
      });
      if (missing.length > 0) {
        process.stdout.write(
          JSON.stringify({
            decision: 'continue',
            reason: `Deliverable file(s) listed in task-outcome.json do not exist in ../output/deliverables/: ${missing.join(', ')}. Save them there or update deliverableFiles.`,
          })
        );
        return;
      }

      for (const f of outcome.deliverableFiles) {
        const clean = path.basename(String(f || ''));
        if (!/\.html?$/i.test(clean)) continue;
        const htmlPath = path.join(deliverablesDir, clean);
        const htmlContent = fs.readFileSync(htmlPath, 'utf8');
        if (!/<html[\s>]/i.test(htmlContent) || !/<\/body>/i.test(htmlContent) || htmlContent.trim().length < 200) {
          process.stdout.write(
            JSON.stringify({
              decision: 'continue',
              reason: `HTML deliverable "${clean}" is incomplete (must be a complete <html>...<body>...</body></html> document). Fix it before finishing.`,
            })
          );
          return;
        }
        if (htmlContent.includes('[object Object]')) {
          process.stdout.write(
            JSON.stringify({
              decision: 'continue',
              reason: `HTML deliverable "${clean}" contains unformatted "[object Object]". Fix object serialization in "${clean}" before finishing.`,
            })
          );
          return;
        }
        const htmlLeaks = CONFIDENTIALITY_CHECKS.filter((c) => c.pattern.test(htmlContent)).map(
          (c) => c.reason
        );
        if (htmlLeaks.length > 0) {
          process.stdout.write(
            JSON.stringify({
              decision: 'continue',
              reason: `HTML deliverable "${clean}" violates confidentiality (${htmlLeaks.join(', ')}). Strip internal sandbox/host paths or model names.`,
            })
          );
          return;
        }
      }
    }

    process.stdout.write(JSON.stringify({ decision: 'allow' }));
  } catch (_) {
    process.stdout.write(JSON.stringify({ decision: 'allow' }));
  }
});

