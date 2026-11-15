---
name: deliverable-files
description: Standards for producing executive, printable Tailwind HTML reports (.html) with inline SVG charts, RFC-4180 UTF-8 BOM spreadsheets (.csv), Markdown (.md), and PDFs (.pdf) in ../output/deliverables/.
---

# Deliverable Files Standard (Default: Executive Printable HTML + CSV)

1. **Directory & Ordering Convention**:
   - Save all final user deliverables inside `../output/deliverables/` using clean, descriptive filenames (e.g., `12-month-income-forecast.html`, `12-month-monthly-schedule.csv`, `opportunity-and-account-line-items.csv`).
   - List each filename (basename relative to `../output/deliverables/`) in `deliverableFiles` inside `../output/task-outcome.json`, placing the primary `.html` report **first** so Rapider UI Inbox auto-opens it in the embedded HTML Preview component.

2. **Default Primary Deliverable — Executive Printable `.html` Page**:
   - Unless the user explicitly asks *only* for `.csv`, `.md`, or `.pdf`, **always** produce a self-contained `.html` report in `../output/deliverables/`.
   - **Required Head & Print Setup**:
     - Include `<meta charset="utf-8" />`, `<meta name="viewport" content="width=device-width, initial-scale=1" />`, and `<script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4"></script>`.
     - Include `@media print` CSS:
       ```css
       @page { size: A4; margin: 12mm; }
       @media print {
         .no-print { display: none !important; }
         body { background: #ffffff !important; color: #0f172a !important; }
         * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
         .avoid-break, tr { break-inside: avoid; page-break-inside: avoid; }
       }
       ```
     - Include a `.no-print` action button (`onclick="window.print()"`) in the top header with explicit white text contrast (`class="no-print inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold !text-white text-white shadow-sm hover:bg-indigo-700 cursor-pointer" style="color: #ffffff !important;"`).
   - **Required Visual Sections**:
     1. **Executive Header**: Workspace name, report title, date/period horizon, and Print button.
     2. **Executive Summary & KPI Cards**: 3–5 high-signal metric cards (`tabular-nums`) + executive takeaway callout box.
     3. **Inline SVG Charts**: 1–2 clean, responsive `<svg viewBox="...">` charts (e.g., 12-month grouped bar/trend chart, Best-Case vs. Expected vs. Worst-Case comparison bars, or segment breakdown) with clear legends, gridlines, and value labels. Prefer inline SVG over external JS chart CDNs so charts render offline and print at vector sharpness.
     4. **Structured Data Tables**: Clean Tailwind tables with right-aligned currency/numeric columns (`text-right tabular-nums`), semantic status badges, and bold `<tfoot>` grand totals.
     5. **Methodology & Scope Footer**: Exact Workspace tables queried, record counts, and scenario assumptions.
   - Validate before finishing:
     ```bash
     node ../tools/rapider-task-cli.js verify-html --in=../output/deliverables/<name>.html
     ```

3. **Companion CSV Spreadsheets (`.csv`)**:
   - Whenever tabular schedules or line items are analyzed, also export companion `.csv` file(s) using `node ../tools/rapider-task-cli.js export-csv --in=<rows.json> --out=../output/deliverables/<name>.csv` so UTF-8 BOM (`\uFEFF`) and RFC-4180 escaping are guaranteed for Excel and Google Sheets.

4. **Optional PDF / Markdown (`.pdf`, `.md`)**:
   - Generate `.pdf` (`render-pdf`) or standalone `.md` files when explicitly requested by the user (Rapider UI opens `.pdf` attachments in a new browser tab and renders `.md` attachments with its Markdown Viewer).
