#!/usr/bin/env node

/**
 * rapider-task-cli.js
 *
 * Zero-secret sandbox tool CLI mounted read-only at `<sandbox>/tools/rapider-task-cli.js`.
 * Communicates strictly with `RAPIDER_TASK_PROXY_URL` using `RAPIDER_TASK_NONCE` for
 * Workspace data/model/template operations, and executes pure local CSV, Handlebars,
 * and printable HTML/PDF helpers inside the jailed sandbox.
 *
 * Commands:
 *   node ../tools/rapider-task-cli.js context
 *   node ../tools/rapider-task-cli.js list-models
 *   node ../tools/rapider-task-cli.js query-data --table=<dataTableName> [--all] [--limit=200] [--out=../output/rows.json]
 *   node ../tools/rapider-task-cli.js verify-handlebars --template=tpl.hbs --data=sample.json [--out=preview.html]
 *   node ../tools/rapider-task-cli.js save-message-template --key=<slug> --subject="..." --file=tpl.hbs [--type=EMAIL] [--env=DEV]
 *   node ../tools/rapider-task-cli.js export-csv --in=rows.json --out=../output/deliverables/report.csv [--columns=a,b,c]
 *   node ../tools/rapider-task-cli.js render-pdf --in=report.md --out=../output/deliverables/report.pdf [--title="Report"]
 *   node ../tools/rapider-task-cli.js workspace-api --method=GET --path=/project-data-manager/accounts
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function getArg(args, name, fallback = null) {
  const prefix = `--${name}=`;
  const hit = args.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
}

function hasFlag(args, name) {
  return args.includes(`--${name}`);
}

async function callProxy(endpointPath, options = {}) {
  const proxyUrl = String(process.env.RAPIDER_TASK_PROXY_URL || '').trim();
  const nonce = String(process.env.RAPIDER_TASK_NONCE || '').trim();
  if (!proxyUrl || !nonce) {
    throw new Error(
      'RAPIDER_TASK_PROXY_URL and RAPIDER_TASK_NONCE must be set in sandbox environment.'
    );
  }
  const res = await fetch(`${proxyUrl}${endpointPath}`, {
    method: options.method || 'GET',
    headers: {
      Accept: 'application/json',
      'X-Task-Nonce': nonce,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `Proxy HTTP ${res.status}`);
  }
  return data;
}

function toRfc4180Csv(rows = [], explicitColumns = null) {
  const safeRows = Array.isArray(rows) ? rows : [];
  const columns =
    Array.isArray(explicitColumns) && explicitColumns.length > 0
      ? explicitColumns
      : Array.from(
          safeRows.reduce((set, row) => {
            if (row && typeof row === 'object') {
              Object.keys(row).forEach((k) => set.add(k));
            }
            return set;
          }, new Set())
        );

  const escapeCell = (val) => {
    if (val === null || val === undefined) return '';
    const str =
      val instanceof Date
        ? val.toISOString()
        : typeof val === 'object'
          ? JSON.stringify(val)
          : String(val);
    if (/[",\r\n]/.test(str)) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  if (columns.length === 0) return '\uFEFF';
  const lines = [columns.map(escapeCell).join(',')];
  for (const row of safeRows) {
    lines.push(columns.map((col) => escapeCell(row ? row[col] : '')).join(','));
  }
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}

function compileHandlebars(templateSource, sampleData = {}) {
  const hbPathCandidates = [
    path.join(__dirname, 'node_modules/handlebars'),
    'handlebars',
  ];
  let Handlebars = null;
  for (const candidate of hbPathCandidates) {
    try {
      Handlebars = require(candidate);
      break;
    } catch (_) {}
  }
  if (!Handlebars) {
    throw new Error('Handlebars module not found in sandbox tools.');
  }

  const hb = Handlebars.create();
  hb.registerHelper('uppercase', (v) => (v == null ? '' : String(v).toUpperCase()));
  hb.registerHelper('lowercase', (v) => (v == null ? '' : String(v).toLowerCase()));
  hb.registerHelper('currency', (v, symbol) => {
    const num = Number(v || 0);
    const sym = typeof symbol === 'string' ? symbol : '$';
    return `${sym}${num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  });
  hb.registerHelper('eq', (a, b) => a === b);
  hb.registerHelper('gt', (a, b) => Number(a) > Number(b));
  hb.registerHelper('lt', (a, b) => Number(a) < Number(b));

  const compiled = hb.compile(String(templateSource || ''), { noEscape: false });
  const rendered = compiled(sampleData || {});
  const warnings = [];
  if (/\{\{[^}]+\}\}/.test(rendered)) {
    warnings.push('Rendered output still contains uninterpolated `{{...}}` tokens.');
  }
  if (rendered.includes('[object Object]')) {
    warnings.push('Rendered output contains `[object Object]`.');
  }
  return { valid: warnings.length === 0, rendered, warnings };
}

function wrapPrintableHtml(inputContent, isMarkdown, title = 'Workspace Report') {
  const escapeHtml = (s) =>
    String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  let bodyHtml = inputContent;
  if (isMarkdown) {
    const lines = String(inputContent || '').split('\n');
    const blocks = [];
    let tableRows = [];
    const flushTable = () => {
      if (!tableRows.length) return;
      const head = tableRows[0]
        .split('|')
        .slice(1, -1)
        .map((c) => `<th>${escapeHtml(c.trim())}</th>`)
        .join('');
      const body = tableRows
        .slice(2)
        .map((r) => {
          const cells = r
            .split('|')
            .slice(1, -1)
            .map((c) => `<td>${escapeHtml(c.trim())}</td>`)
            .join('');
          return `<tr>${cells}</tr>`;
        })
        .join('\n');
      blocks.push(`<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`);
      tableRows = [];
    };
    for (const raw of lines) {
      const line = raw.trimEnd();
      if (/^\|.*\|$/.test(line.trim())) {
        tableRows.push(line.trim());
        continue;
      }
      flushTable();
      if (/^###\s+/.test(line)) blocks.push(`<h3>${escapeHtml(line.replace(/^###\s+/, ''))}</h3>`);
      else if (/^##\s+/.test(line)) blocks.push(`<h2>${escapeHtml(line.replace(/^##\s+/, ''))}</h2>`);
      else if (/^#\s+/.test(line)) blocks.push(`<h1>${escapeHtml(line.replace(/^#\s+/, ''))}</h1>`);
      else if (/^-\s+/.test(line)) blocks.push(`<p>&bull; ${escapeHtml(line.replace(/^-\s+/, ''))}</p>`);
      else if (/^---+$/.test(line.trim())) blocks.push('<hr/>');
      else if (line.trim()) {
        blocks.push(
          `<p>${escapeHtml(line)
            .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
            .replace(/`([^`]+)`/g, '<code>$1</code>')}</p>`
        );
      }
    }
    flushTable();
    bodyHtml = blocks.join('\n');
  }
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"/><title>${escapeHtml(title)}</title>
<style>
@page { size: A4; margin: 18mm 16mm; }
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #111827; font-size: 12px; line-height: 1.55; }
h1 { font-size: 20px; border-bottom: 2px solid #e5e7eb; padding-bottom: 6px; }
h2 { font-size: 15px; margin-top: 16px; }
table { width: 100%; border-collapse: collapse; margin: 12px 0; font-size: 11px; }
th, td { border: 1px solid #d1d5db; padding: 6px 8px; text-align: left; }
th { background: #f3f4f6; font-weight: 600; }
</style></head><body>${bodyHtml}</body></html>`;
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd) {
    console.error('Usage: rapider-task-cli.js <context|list-models|query-data|verify-handlebars|save-message-template|export-csv|render-pdf|workspace-api> [flags]');
    process.exit(1);
  }

  if (cmd === 'context') {
    console.log(JSON.stringify(await callProxy('/task-proxy/context'), null, 2));
    return;
  }

  if (cmd === 'list-models') {
    console.log(JSON.stringify(await callProxy('/task-proxy/models'), null, 2));
    return;
  }

  if (cmd === 'query-data') {
    const table = getArg(args, 'table');
    if (!table) throw new Error('--table=<dataTableName> is required.');
    const fetchAll = hasFlag(args, 'all');
    const pageLimit = parseInt(getArg(args, 'limit', '200'), 10) || 200;
    const rawFilter = getArg(args, 'filter');
    const baseFilter = rawFilter ? JSON.parse(rawFilter) : {};
    const outFile = getArg(args, 'out');

    let allRows = [];
    if (fetchAll) {
      let skip = 0;
      while (true) {
        const pageFilter = { ...baseFilter, limit: pageLimit, skip };
        const page = await callProxy(
          `/task-proxy/data/${encodeURIComponent(table)}?filter=${encodeURIComponent(JSON.stringify(pageFilter))}`
        );
        const rows = (Array.isArray(page) ? page : []).filter((r) => r && r.isDeleted !== true);
        allRows.push(...rows);
        if (!Array.isArray(page) || page.length < pageLimit || skip >= 20000) break;
        skip += pageLimit;
      }
    } else {
      const pageFilter = { limit: pageLimit, ...baseFilter };
      const page = await callProxy(
        `/task-proxy/data/${encodeURIComponent(table)}?filter=${encodeURIComponent(JSON.stringify(pageFilter))}`
      );
      allRows = (Array.isArray(page) ? page : []).filter((r) => r && r.isDeleted !== true);
    }

    if (outFile) {
      const absOut = path.resolve(outFile);
      fs.mkdirSync(path.dirname(absOut), { recursive: true });
      fs.writeFileSync(absOut, JSON.stringify(allRows, null, 2), 'utf8');
      console.log(JSON.stringify({ ok: true, table, rowCount: allRows.length, outFile: absOut }, null, 2));
    } else {
      console.log(JSON.stringify(allRows, null, 2));
    }
    return;
  }

  if (cmd === 'verify-handlebars') {
    const tplFile = getArg(args, 'template');
    const dataFile = getArg(args, 'data');
    const outFile = getArg(args, 'out');
    if (!tplFile) throw new Error('--template=<file.hbs> is required.');
    const tpl = fs.readFileSync(path.resolve(tplFile), 'utf8');
    const sample = dataFile && fs.existsSync(path.resolve(dataFile))
      ? JSON.parse(fs.readFileSync(path.resolve(dataFile), 'utf8'))
      : {};
    const result = compileHandlebars(tpl, sample);
    if (outFile) {
      const absOut = path.resolve(outFile);
      fs.mkdirSync(path.dirname(absOut), { recursive: true });
      fs.writeFileSync(absOut, result.rendered, 'utf8');
    }
    console.log(JSON.stringify({ valid: result.valid, warnings: result.warnings }, null, 2));
    if (!result.valid) process.exit(2);
    return;
  }

  if (cmd === 'save-message-template') {
    const key = getArg(args, 'key');
    const subject = getArg(args, 'subject', key);
    const type = getArg(args, 'type', 'EMAIL');
    const environmentKey = getArg(args, 'env', 'DEV');
    const file = getArg(args, 'file');
    if (!key || !file) throw new Error('--key=<slug> and --file=<tpl.hbs> are required.');
    const content = fs.readFileSync(path.resolve(file), 'utf8');
    const resp = await callProxy('/task-proxy/templates/message', {
      method: 'POST',
      body: { key, subject, content, type, environmentKey },
    });
    console.log(JSON.stringify(resp, null, 2));
    return;
  }

  if (cmd === 'export-csv') {
    const inFile = getArg(args, 'in');
    const outFile = getArg(args, 'out');
    const colsRaw = getArg(args, 'columns');
    if (!inFile || !outFile) throw new Error('--in=<rows.json> and --out=<file.csv> are required.');
    const rows = JSON.parse(fs.readFileSync(path.resolve(inFile), 'utf8'));
    const cols = colsRaw ? colsRaw.split(',').map((s) => s.trim()).filter(Boolean) : null;
    const csv = toRfc4180Csv(rows, cols);
    const absOut = path.resolve(outFile);
    fs.mkdirSync(path.dirname(absOut), { recursive: true });
    fs.writeFileSync(absOut, csv, 'utf8');
    console.log(JSON.stringify({ ok: true, rows: Array.isArray(rows) ? rows.length : 0, outFile: absOut }, null, 2));
    return;
  }

  if (cmd === 'render-pdf') {
    const inFile = getArg(args, 'in');
    const outFile = getArg(args, 'out');
    const title = getArg(args, 'title', 'Workspace Report');
    if (!inFile || !outFile) throw new Error('--in=<report.md> and --out=<report.pdf> are required.');
    const absIn = path.resolve(inFile);
    const absOut = path.resolve(outFile);
    const raw = fs.readFileSync(absIn, 'utf8');
    const htmlDoc = /\.(md|markdown)$/i.test(absIn) ? wrapPrintableHtml(raw, true, title) : raw;
    fs.mkdirSync(path.dirname(absOut), { recursive: true });
    const tmpHtml = absOut.replace(/\.pdf$/i, '') + '.print.html';
    fs.writeFileSync(tmpHtml, htmlDoc, 'utf8');

    const chromeBins = [
      process.env.CHROME_BIN,
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      'google-chrome',
      'chromium',
      'chromium-browser',
    ].filter(Boolean);

    let rendered = false;
    for (const bin of chromeBins) {
      try {
        execFileSync(
          bin,
          [
            '--headless=new',
            '--disable-gpu',
            '--no-sandbox',
            '--no-pdf-header-footer',
            `--print-to-pdf=${absOut}`,
            `file://${tmpHtml}`,
          ],
          { stdio: 'ignore' }
        );
        if (fs.existsSync(absOut) && fs.statSync(absOut).size > 0) {
          rendered = true;
          break;
        }
      } catch (_) {}
    }
    if (rendered) {
      try { fs.unlinkSync(tmpHtml); } catch (_) {}
      console.log(JSON.stringify({ ok: true, format: 'pdf', outFile: absOut }, null, 2));
    } else {
      console.log(JSON.stringify({ ok: true, format: 'html-fallback', outFile: tmpHtml }, null, 2));
    }
    return;
  }

  if (cmd === 'workspace-api') {
    const method = getArg(args, 'method', 'GET');
    const apiPath = getArg(args, 'path');
    const rawBody = getArg(args, 'body');
    if (!apiPath) throw new Error('--path=/project-data-manager/... is required.');
    const resp = await callProxy('/task-proxy/workspace-api', {
      method: 'POST',
      body: {
        method,
        path: apiPath,
        ...(rawBody ? { body: JSON.parse(rawBody) } : {}),
      },
    });
    console.log(JSON.stringify(resp, null, 2));
    return;
  }

  throw new Error(`Unknown command "${cmd}".`);
}

main().catch((err) => {
  console.error(`[RapiderTaskCLI] Error: ${err.message}`);
  process.exit(1);
});

