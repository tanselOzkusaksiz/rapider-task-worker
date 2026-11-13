#!/usr/bin/env node

/**
 * workspace-tools-cli.js
 *
 * Tenant-isolated Workspace helper utilities for ISOLATED-TASK-WORKER (Step 4):
 *   1. Data Reporting: Paginated, soft-delete safe `/project-data-manager/{table}` fetches
 *   2. Handlebars Templating: Local compile + sample render verification & `/message-templates` upsert
 *   3. File Preparation: RFC-4180 UTF-8 BOM `.csv` generation & print-styled `.pdf` rendering
 *   4. Allowed Workspace API Calls: Scoped JSON requests strictly bound to `projectId`
 *
 * Usage examples:
 *   node scripts/workspace-tools-cli.js list-models --project=<projectId>
 *   node scripts/workspace-tools-cli.js query-data --project=<projectId> --table=opportunities --all --out=_artifacts/<id>/opps.json
 *   node scripts/workspace-tools-cli.js verify-handlebars --template=_artifacts/<id>/summary.hbs --data=_artifacts/<id>/sample.json --out=_artifacts/<id>/preview.html
 *   node scripts/workspace-tools-cli.js save-message-template --project=<projectId> --key=monthly-income-summary --subject="Monthly Income Summary" --type=EMAIL --env=DEV --file=_artifacts/<id>/summary.hbs
 *   node scripts/workspace-tools-cli.js export-csv --in=_artifacts/<id>/rows.json --out=_artifacts/<id>/report.csv
 *   node scripts/workspace-tools-cli.js render-pdf --in=_artifacts/<id>/report.md --out=_artifacts/<id>/report.pdf --title="12-Month Income Report"
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const {
  authenticateBase,
  switchActiveProject,
  fetchWithRetry,
} = require('./rapider-api-auth');

/**
 * Pure RFC-4180 CSV serializer with UTF-8 BOM (`\uFEFF`) for spreadsheet compatibility.
 *
 * @param {Array<Record<string, any>>} rows Array of flat row objects
 * @param {string[]} [explicitColumns] Optional ordered column headers
 * @returns {string} UTF-8 BOM prefixed RFC-4180 CSV content
 */
function toRfc4180CsvPure(rows = [], explicitColumns) {
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

/**
 * Compiles and renders a Handlebars template against sample data and verifies
 * there are no unrendered `{{` expressions or accidental `[object Object]` outputs.
 *
 * @param {string} templateSource Raw `.hbs` Handlebars template string
 * @param {Record<string, any>} sampleData Data context object
 * @returns {{ valid: boolean, rendered: string, warnings: string[] }}
 */
function compileAndVerifyHandlebarsPure(templateSource, sampleData = {}) {
  const Handlebars = require('handlebars');
  const source = String(templateSource || '');
  if (!source.trim()) {
    throw new Error('Handlebars template source cannot be empty.');
  }

  // Register safe standard formatting helpers commonly needed in reports/emails
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

  const compiled = hb.compile(source, { noEscape: false });
  const rendered = compiled(sampleData || {});

  const warnings = [];
  if (/\{\{[^}]+\}\}/.test(rendered)) {
    warnings.push('Rendered output still contains uninterpolated `{{...}}` tokens.');
  }
  if (rendered.includes('[object Object]')) {
    warnings.push('Rendered output contains `[object Object]`; inspect nested object expressions.');
  }

  return {
    valid: warnings.length === 0,
    rendered,
    warnings,
  };
}

/**
 * Converts basic GitHub-Flavored Markdown (headings, tables, lists, bold/code) into
 * clean, print-styled HTML for PDF generation.
 */
function wrapPrintableHtmlDocument(inputContent, isMarkdown, title = 'Workspace Report') {
  const escapeHtml = (s) =>
    String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

  let bodyHtml = inputContent;
  if (isMarkdown) {
    const lines = String(inputContent || '').split('\n');
    const htmlBlocks = [];
    let inTable = false;
    let tableRows = [];

    const flushTable = () => {
      if (!inTable || tableRows.length === 0) return;
      const headerCells = tableRows[0]
        .split('|')
        .slice(1, -1)
        .map((c) => `<th>${escapeHtml(c.trim())}</th>`)
        .join('');
      const dataRows = tableRows
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
      htmlBlocks.push(`<table><thead><tr>${headerCells}</tr></thead><tbody>${dataRows}</tbody></table>`);
      inTable = false;
      tableRows = [];
    };

    for (const rawLine of lines) {
      const line = rawLine.trimEnd();
      if (/^\|.*\|$/.test(line.trim())) {
        inTable = true;
        tableRows.push(line.trim());
        continue;
      }
      flushTable();
      if (/^###\s+(.+)/.test(line)) {
        htmlBlocks.push(`<h3>${escapeHtml(line.replace(/^###\s+/, ''))}</h3>`);
      } else if (/^##\s+(.+)/.test(line)) {
        htmlBlocks.push(`<h2>${escapeHtml(line.replace(/^##\s+/, ''))}</h2>`);
      } else if (/^#\s+(.+)/.test(line)) {
        htmlBlocks.push(`<h1>${escapeHtml(line.replace(/^#\s+/, ''))}</h1>`);
      } else if (/^-\s+(.+)/.test(line)) {
        htmlBlocks.push(`<p class="bullet">&bull; ${escapeHtml(line.replace(/^-\s+/, ''))}</p>`);
      } else if (/^---+$/.test(line.trim())) {
        htmlBlocks.push('<hr/>');
      } else if (line.trim()) {
        const inline = escapeHtml(line)
          .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
          .replace(/`([^`]+)`/g, '<code>$1</code>');
        htmlBlocks.push(`<p>${inline}</p>`);
      }
    }
    flushTable();
    bodyHtml = htmlBlocks.join('\n');
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(title)}</title>
  <style>
    @page { size: A4; margin: 18mm 16mm; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #111827; font-size: 12px; line-height: 1.55; margin: 0; }
    h1 { font-size: 20px; border-bottom: 2px solid #e5e7eb; padding-bottom: 6px; margin-top: 0; }
    h2 { font-size: 15px; color: #1f2937; margin-top: 18px; }
    h3 { font-size: 13px; color: #374151; margin-top: 14px; }
    table { width: 100%; border-collapse: collapse; margin: 12px 0; font-size: 11px; }
    thead { display: table-header-group; }
    tr { page-break-inside: avoid; }
    th, td { border: 1px solid #d1d5db; padding: 6px 8px; text-align: left; vertical-align: top; }
    th { background: #f3f4f6; font-weight: 600; color: #111827; }
    code { background: #f3f4f6; padding: 1px 4px; border-radius: 3px; font-size: 11px; }
    hr { border: none; border-top: 1px solid #e5e7eb; margin: 16px 0; }
    .bullet { margin: 3px 0 3px 12px; }
  </style>
</head>
<body>
${bodyHtml}
</body>
</html>`;
}

/**
 * Renders a Markdown or HTML file into a print-ready PDF using a local Chromium/Chrome binary.
 */
function renderPdfFromFile(inputPath, outputPath, title = 'Workspace Report') {
  const absIn = path.resolve(inputPath);
  const absOut = path.resolve(outputPath);
  if (!fs.existsSync(absIn)) throw new Error(`Input file not found: ${absIn}`);

  const raw = fs.readFileSync(absIn, 'utf8');
  const isMd = /\.(md|markdown)$/i.test(absIn);
  const htmlDoc = isMd ? wrapPrintableHtmlDocument(raw, true, title) : raw;

  fs.mkdirSync(path.dirname(absOut), { recursive: true });
  const tempHtmlPath = absOut.replace(/\.pdf$/i, '') + '.tmp-print.html';
  fs.writeFileSync(tempHtmlPath, htmlDoc, 'utf8');

  const chromeCandidates = [
    process.env.CHROME_BIN,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    'google-chrome',
    'chromium',
    'chromium-browser',
  ].filter(Boolean);

  let rendered = false;
  let lastErr = null;
  for (const bin of chromeCandidates) {
    try {
      execFileSync(
        bin,
        [
          '--headless=new',
          '--disable-gpu',
          '--no-sandbox',
          '--no-pdf-header-footer',
          `--print-to-pdf=${absOut}`,
          `file://${tempHtmlPath}`,
        ],
        { stdio: 'ignore' }
      );
      if (fs.existsSync(absOut) && fs.statSync(absOut).size > 0) {
        rendered = true;
        break;
      }
    } catch (err) {
      lastErr = err;
    }
  }

  try {
    fs.unlinkSync(tempHtmlPath);
  } catch (_) {}

  if (!rendered) {
    throw new Error(
      `Could not render PDF via headless Chrome/Chromium (${lastErr ? lastErr.message : 'binary not found'}). Set CHROME_BIN or install Chromium.`
    );
  }

  return absOut;
}

/**
 * Fetches records from `/project-data-manager/{tableName}` with automatic pagination
 * (`limit: 200` loop when `fetchAll === true`) and defensive soft-delete filtering.
 */
async function queryWorkspaceTable({
  projectId,
  tableName,
  where = undefined,
  order = ['createdDate ASC'],
  limit = 200,
  fetchAll = true,
}) {
  if (!projectId || !tableName) {
    throw new Error('queryWorkspaceTable requires both projectId and tableName.');
  }

  const { token: baseToken, creds } = await authenticateBase();
  const projectToken = await switchActiveProject(creds, baseToken, projectId);

  const pageSize = Math.min(Math.max(Number(limit) || 200, 1), 500);
  let skip = 0;
  const collected = [];

  while (true) {
    const filterObj = {
      ...(where ? { where } : {}),
      order,
      limit: pageSize,
      skip,
    };
    const url = `${creds.backendUrl}/project-data-manager/${encodeURIComponent(tableName)}?filter=${encodeURIComponent(JSON.stringify(filterObj))}`;
    const res = await fetchWithRetry(url, {
      headers: { Authorization: projectToken },
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new Error(`Query failed on table "${tableName}" (HTTP ${res.status}): ${errBody}`);
    }
    const rows = await res.json().catch(() => []);
    const arr = Array.isArray(rows) ? rows : [];
    for (const r of arr) {
      if (r && r.isDeleted !== true) collected.push(r);
    }
    if (!fetchAll || arr.length < pageSize) break;
    skip += pageSize;
  }

  return collected;
}

/**
 * Upserts a Handlebars `MessageTemplate` in the target Workspace (`/message-templates`).
 */
async function upsertWorkspaceMessageTemplate({
  projectId,
  key,
  subject,
  template,
  type = 'EMAIL',
  environmentKey = 'DEV',
  dataSchemaId = undefined,
}) {
  const verify = compileAndVerifyHandlebarsPure(template, {});
  const { token: baseToken, creds } = await authenticateBase();
  const projectToken = await switchActiveProject(creds, baseToken, projectId);

  const existingFilter = encodeURIComponent(
    JSON.stringify({ where: { key, environmentKey, projectId } })
  );
  const findRes = await fetchWithRetry(`${creds.backendUrl}/message-templates?filter=${existingFilter}`, {
    headers: { Authorization: projectToken },
  });
  const found = await findRes.json().catch(() => []);
  const existing = Array.isArray(found) && found[0] ? found[0] : null;

  if (existing && existing.id) {
    const patchRes = await fetchWithRetry(
      `${creds.backendUrl}/message-templates/${encodeURIComponent(existing.id)}`,
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: projectToken,
        },
        body: JSON.stringify({
          subject,
          template,
          type,
          ...(dataSchemaId ? { dataSchemaId } : {}),
        }),
      }
    );
    if (!patchRes.ok) {
      throw new Error(`Failed to update MessageTemplate "${key}" (HTTP ${patchRes.status}).`);
    }
    return { id: existing.id, key, environmentKey, action: 'updated', compileCheck: verify.valid };
  }

  const createRes = await fetchWithRetry(`${creds.backendUrl}/message-templates`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: projectToken,
    },
    body: JSON.stringify({
      key,
      environmentKey,
      type,
      subject,
      template,
      projectId,
      ...(dataSchemaId ? { dataSchemaId } : {}),
    }),
  });
  const created = await createRes.json().catch(() => ({}));
  if (!createRes.ok) {
    throw new Error(`Failed to create MessageTemplate "${key}" (HTTP ${createRes.status}): ${JSON.stringify(created)}`);
  }
  return { id: created.id, key, environmentKey, action: 'created', compileCheck: verify.valid };
}

if (require.main === module) {
  const [subcmd, ...rest] = process.argv.slice(2);
  const getArg = (name) => {
    const prefix = `--${name}=`;
    const hit = rest.find((a) => a.startsWith(prefix));
    return hit ? hit.slice(prefix.length) : null;
  };
  const hasFlag = (flag) => rest.includes(`--${flag}`);

  (async () => {
    if (subcmd === 'list-models') {
      const projectId = getArg('project');
      if (!projectId) throw new Error('Missing --project=<projectId>');
      const { token: baseToken, creds } = await authenticateBase();
      const pTok = await switchActiveProject(creds, baseToken, projectId);
      const res = await fetchWithRetry(`${creds.backendUrl}/project-models`, {
        headers: { Authorization: pTok },
      });
      const models = await res.json().catch(() => []);
      for (const m of Array.isArray(models) ? models : []) {
        console.log(`- ${m.name} -> dataTableName: "${m.dataTableName}" (id: ${m.id})`);
      }
      return;
    }

    if (subcmd === 'query-data') {
      const projectId = getArg('project');
      const tableName = getArg('table');
      const whereRaw = getArg('where');
      const orderRaw = getArg('order');
      const outPath = getArg('out');
      const rows = await queryWorkspaceTable({
        projectId,
        tableName,
        where: whereRaw ? JSON.parse(whereRaw) : undefined,
        order: orderRaw ? JSON.parse(orderRaw) : ['createdDate ASC'],
        limit: parseInt(getArg('limit') || '200', 10),
        fetchAll: hasFlag('all') || !getArg('limit'),
      });
      if (outPath) {
        const absOut = path.resolve(outPath);
        fs.mkdirSync(path.dirname(absOut), { recursive: true });
        fs.writeFileSync(absOut, JSON.stringify(rows, null, 2), 'utf8');
        console.log(`[WorkspaceTools] Wrote ${rows.length} record(s) from "${tableName}" to ${absOut}`);
      } else {
        console.log(JSON.stringify(rows, null, 2));
      }
      return;
    }

    if (subcmd === 'verify-handlebars') {
      const tplFile = getArg('template');
      const dataFile = getArg('data');
      const outPath = getArg('out');
      if (!tplFile) throw new Error('Missing --template=<path.hbs>');
      const tplSource = fs.readFileSync(path.resolve(tplFile), 'utf8');
      const sampleData = dataFile ? JSON.parse(fs.readFileSync(path.resolve(dataFile), 'utf8')) : {};
      const result = compileAndVerifyHandlebarsPure(tplSource, sampleData);
      if (outPath) {
        const absOut = path.resolve(outPath);
        fs.mkdirSync(path.dirname(absOut), { recursive: true });
        fs.writeFileSync(absOut, result.rendered, 'utf8');
      }
      console.log(
        `[Handlebars] Compiled successfully (valid=${result.valid}, warnings=${result.warnings.length})`
      );
      if (result.warnings.length > 0) {
        for (const w of result.warnings) console.warn(`  Warning: ${w}`);
        process.exit(1);
      }
      return;
    }

    if (subcmd === 'save-message-template') {
      const projectId = getArg('project');
      const key = getArg('key');
      const subject = getArg('subject') || key;
      const type = getArg('type') || 'EMAIL';
      const environmentKey = getArg('env') || 'DEV';
      const file = getArg('file');
      const schemaId = getArg('schema-id') || undefined;
      if (!projectId || !key || !file) {
        throw new Error('Required: --project=<id> --key=<kebab-key> --file=<template.hbs>');
      }
      const template = fs.readFileSync(path.resolve(file), 'utf8');
      const saved = await upsertWorkspaceMessageTemplate({
        projectId,
        key,
        subject,
        template,
        type,
        environmentKey,
        dataSchemaId: schemaId,
      });
      console.log(`[Handlebars] ${saved.action} MessageTemplate "${saved.key}" (id: ${saved.id})`);
      return;
    }

    if (subcmd === 'export-csv') {
      const inFile = getArg('in');
      const outFile = getArg('out');
      const colsRaw = getArg('columns');
      if (!inFile || !outFile) throw new Error('Required: --in=<rows.json> --out=<file.csv>');
      const rows = JSON.parse(fs.readFileSync(path.resolve(inFile), 'utf8'));
      const columns = colsRaw ? colsRaw.split(',').map((c) => c.trim()).filter(Boolean) : undefined;
      const csv = toRfc4180CsvPure(rows, columns);
      const absOut = path.resolve(outFile);
      fs.mkdirSync(path.dirname(absOut), { recursive: true });
      fs.writeFileSync(absOut, csv, 'utf8');
      console.log(`[CSV] Wrote ${Array.isArray(rows) ? rows.length : 0} row(s) to ${absOut}`);
      return;
    }

    if (subcmd === 'render-pdf') {
      const inFile = getArg('in');
      const outFile = getArg('out');
      const title = getArg('title') || 'Workspace Report';
      if (!inFile || !outFile) throw new Error('Required: --in=<report.md|html> --out=<report.pdf>');
      const pdfPath = renderPdfFromFile(inFile, outFile, title);
      console.log(`[PDF] Rendered printable PDF: ${pdfPath}`);
      return;
    }

    console.error(
      'Commands: list-models | query-data | verify-handlebars | save-message-template | export-csv | render-pdf'
    );
    process.exit(1);
  })().catch((err) => {
    console.error(`[WorkspaceTools] Error: ${err.message}`);
    process.exit(1);
  });
}

module.exports = {
  toRfc4180CsvPure,
  compileAndVerifyHandlebarsPure,
  wrapPrintableHtmlDocument,
  renderPdfFromFile,
  queryWorkspaceTable,
  upsertWorkspaceMessageTemplate,
};

