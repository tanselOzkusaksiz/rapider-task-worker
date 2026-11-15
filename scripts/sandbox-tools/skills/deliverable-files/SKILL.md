---
name: deliverable-files
description: Standards for producing clean Markdown (.md), RFC-4180 UTF-8 BOM spreadsheets (.csv), and print-ready executive documents (.pdf) in ../output/deliverables/.
---

# Deliverable Files Standard

1. **Directory Convention**:
   - Save all final user deliverables inside `../output/deliverables/` using clean, descriptive filenames (e.g., `12-month-income-projection.md`, `12-month-income-projection.csv`, `12-month-income-projection.pdf`).
   - List each filename (basename relative to `../output/deliverables/`) in `deliverableFiles` inside `../output/task-outcome.json`.
2. **CSV Exports**:
   - Always generate `.csv` files using `node ../tools/rapider-task-cli.js export-csv --in=<rows.json> --out=../output/deliverables/<name>.csv` so UTF-8 BOM (`\uFEFF`) and RFC-4180 escaping are guaranteed for Excel and Google Sheets.
3. **Executive Markdown & PDF**:
   - Include an Executive Summary, Methodology/Data Sources section, Markdown summary tables, and clear caveats.
   - When a PDF or formal report is helpful or requested, run `node ../tools/rapider-task-cli.js render-pdf --in=../output/deliverables/<name>.md --out=../output/deliverables/<name>.pdf --title="<Report Title>"`.

