#!/usr/bin/env node

/**
 * rapider-task-cli.js
 *
 * Zero-secret sandbox tool CLI mounted read-only at `<sandbox>/tools/rapider-task-cli.js`.
 * Communicates strictly with `RAPIDER_TASK_PROXY_URL` using `RAPIDER_TASK_NONCE` for
 * Workspace Project Data Manager (`CRUD` + `bulk` + `count`), DataSource/MCP/Integration
 * tool execution (e.g. Jira, Slack, OpenAPI), and local CSV/Handlebars/PDF deliverables.
 *
 * Commands:
 *   node ../tools/rapider-task-cli.js context
 *   node ../tools/rapider-task-cli.js list-models
 *   node ../tools/rapider-task-cli.js query-data --table=<dataTableName> [--all] [--limit=200] [--filter='{...}'] [--out=../output/rows.json]
 *   node ../tools/rapider-task-cli.js count-data --table=<dataTableName> [--where='{...}']
 *   node ../tools/rapider-task-cli.js get-record --table=<dataTableName> --id=<uuid> [--filter='{...}']
 *   node ../tools/rapider-task-cli.js create-record --table=<dataTableName> (--data='{...}' | --file=payload.json)
 *   node ../tools/rapider-task-cli.js bulk-create-records --table=<dataTableName> (--data='[...]' | --file=rows.json)
 *   node ../tools/rapider-task-cli.js update-record --table=<dataTableName> --id=<uuid> (--data='{...}' | --file=patch.json) [--replace]
 *   node ../tools/rapider-task-cli.js delete-record --table=<dataTableName> --id=<uuid>
 *   node ../tools/rapider-task-cli.js list-datasources
 *   node ../tools/rapider-task-cli.js list-datasource-tools --datasource=<dataSourceId>
 *   node ../tools/rapider-task-cli.js run-datasource-tool --datasource=<dataSourceId> --tool=<toolName> [--input='{...}' | --file=input.json]
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

function readJsonArgOrFile(args, inlineArgName = 'data', fileArgName = 'file', defaultVal = undefined) {
  const rawInline = getArg(args, inlineArgName);
  if (rawInline !== null) {
    return JSON.parse(rawInline);
  }
  const fileArg = getArg(args, fileArgName);
  if (fileArg !== null) {
    return JSON.parse(fs.readFileSync(path.resolve(fileArg), 'utf8'));
  }
  return defaultVal;
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
      ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
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
    console.error(
      'Usage: rapider-task-cli.js <context|list-models|query-data|count-data|get-record|create-record|bulk-create-records|update-record|delete-record|list-datasources|list-datasource-tools|run-datasource-tool|verify-handlebars|save-message-template|export-csv|render-pdf|workspace-api> [flags]'
    );
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

  if (cmd === 'count-data') {
    const table = getArg(args, 'table');
    if (!table) throw new Error('--table=<dataTableName> is required.');
    const rawWhere = getArg(args, 'where');
    const qs = rawWhere ? `?where=${encodeURIComponent(rawWhere)}` : '';
    const resp = await callProxy(`/task-proxy/data/${encodeURIComponent(table)}/count${qs}`);
    console.log(JSON.stringify(resp, null, 2));
    return;
  }

  if (cmd === 'get-record') {
    const table = getArg(args, 'table');
    const id = getArg(args, 'id');
    if (!table || !id) throw new Error('--table=<dataTableName> and --id=<uuid> are required.');
    const rawFilter = getArg(args, 'filter');
    const qs = rawFilter ? `?filter=${encodeURIComponent(rawFilter)}` : '';
    const resp = await callProxy(
      `/task-proxy/data/${encodeURIComponent(table)}/${encodeURIComponent(id)}${qs}`
    );
    console.log(JSON.stringify(resp, null, 2));
    return;
  }

  if (cmd === 'create-record') {
    const table = getArg(args, 'table');
    if (!table) throw new Error('--table=<dataTableName> is required.');
    const payload = readJsonArgOrFile(args, 'data', 'file');
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error('--data=\'{...}\' or --file=payload.json (JSON object) is required.');
    }
    const resp = await callProxy(`/task-proxy/data/${encodeURIComponent(table)}`, {
      method: 'POST',
      body: payload,
    });
    console.log(JSON.stringify(resp, null, 2));
    return;
  }

  if (cmd === 'bulk-create-records') {
    const table = getArg(args, 'table');
    if (!table) throw new Error('--table=<dataTableName> is required.');
    const payload = readJsonArgOrFile(args, 'data', 'file');
    if (!Array.isArray(payload)) {
      throw new Error('--data=\'[...]\' or --file=rows.json (JSON array) is required.');
    }
    const resp = await callProxy(`/task-proxy/data/${encodeURIComponent(table)}/bulk`, {
      method: 'POST',
      body: payload,
    });
    console.log(JSON.stringify(resp, null, 2));
    return;
  }

  if (cmd === 'update-record') {
    const table = getArg(args, 'table');
    const id = getArg(args, 'id');
    if (!table || !id) throw new Error('--table=<dataTableName> and --id=<uuid> are required.');
    const payload = readJsonArgOrFile(args, 'data', 'file');
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error('--data=\'{...}\' or --file=patch.json (JSON object) is required.');
    }
    const suffix = hasFlag(args, 'replace') ? '/replace' : '';
    const resp = await callProxy(
      `/task-proxy/data/${encodeURIComponent(table)}/${encodeURIComponent(id)}${suffix}`,
      { method: 'PATCH', body: payload }
    );
    console.log(JSON.stringify(resp, null, 2));
    return;
  }

  if (cmd === 'delete-record') {
    const table = getArg(args, 'table');
    const id = getArg(args, 'id');
    if (!table || !id) throw new Error('--table=<dataTableName> and --id=<uuid> are required.');
    const resp = await callProxy(
      `/task-proxy/data/${encodeURIComponent(table)}/${encodeURIComponent(id)}`,
      { method: 'DELETE' }
    );
    console.log(JSON.stringify(resp, null, 2));
    return;
  }

  if (cmd === 'list-datasources') {
    console.log(JSON.stringify(await callProxy('/task-proxy/datasources'), null, 2));
    return;
  }

  if (cmd === 'list-datasource-tools') {
    const dsId = getArg(args, 'datasource') || getArg(args, 'id');
    if (!dsId) throw new Error('--datasource=<dataSourceId> is required.');
    const resp = await callProxy(`/task-proxy/datasources/${encodeURIComponent(dsId)}/tools`);
    console.log(JSON.stringify(resp, null, 2));
    return;
  }

  if (cmd === 'run-datasource-tool') {
    const dsId = getArg(args, 'datasource') || getArg(args, 'id');
    const toolName = getArg(args, 'tool');
    if (!dsId || !toolName) {
      throw new Error('--datasource=<dataSourceId> and --tool=<toolName> are required.');
    }
    const inputPayload = readJsonArgOrFile(args, 'input', 'file', {});
    const resp = await callProxy(
      `/task-proxy/datasources/${encodeURIComponent(dsId)}/tools/${encodeURIComponent(toolName)}/execute`,
      { method: 'POST', body: inputPayload }
    );
    console.log(JSON.stringify(resp, null, 2));
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

  if (cmd === 'verify-html') {
    const inFile = getArg(args, 'in') || getArg(args, 'file');
    if (!inFile) throw new Error('--in=<report.html> is required.');
    const absIn = path.resolve(inFile);
    if (!fs.existsSync(absIn)) {
      throw new Error(`HTML file does not exist: ${absIn}`);
    }
    const html = fs.readFileSync(absIn, 'utf8');
    const issues = [];
    if (html.trim().length < 200) issues.push('Document is shorter than 200 characters.');
    if (!/<html[\s>]/i.test(html) || !/<\/html>/i.test(html)) {
      issues.push('Missing <html>...</html> root element.');
    }
    if (!/<body[\s>]/i.test(html) || !/<\/body>/i.test(html)) {
      issues.push('Missing <body>...</body> element.');
    }
    if (html.includes('[object Object]')) {
      issues.push('Contains literal "[object Object]".');
    }
    if (/>\s*NaN\s*</.test(html) || /\$NaN\b/.test(html)) {
      issues.push('Contains rendered NaN value.');
    }
    if (/\/Users\/[A-Za-z0-9._-]+|_sandboxes\//.test(html)) {
      issues.push('Contains leaked internal host/sandbox filesystem path.');
    }
    const result = {
      ok: issues.length === 0,
      file: absIn,
      bytes: Buffer.byteLength(html, 'utf8'),
      hasPrintSupport: /window\.print|@media\s+print/i.test(html),
      hasSvgChart: /<svg[\s>]/i.test(html),
      issues,
    };
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) {
      process.exit(1);
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
