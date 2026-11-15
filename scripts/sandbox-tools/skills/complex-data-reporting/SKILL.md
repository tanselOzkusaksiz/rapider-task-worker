---
name: complex-data-reporting
description: Multi-model Workspace data aggregation, financial best/worst-case scenario modeling, soft-delete safe querying, cross-table reconciliation, and executive HTML + SVG chart + CSV generation. Activate when generating reports, projections, KPI summaries, or audits from Workspace tables.
---

# Complex Data Reporting Playbook

1. **Inspect Exact Field Schemas First**:
   - Read `.agents/project-data-manager-guide.md` and the relevant entities in `.agents/project-data-models.md` to confirm exact `dataTableName`, numeric/currency fields, date fields, status enums, and foreign keys (`accountId`, `opportunityId`, etc.).
2. **Fetch Complete Datasets Safely**:
   - Run `node ../tools/rapider-task-cli.js query-data --table=<dataTableName> --all --out=../output/raw-<table>.json` (or fetch via a single Node script in `../output/compute.js`) for every relevant model.
   - Verify `isDeleted !== true` on all records and handle `null`/missing numeric fields as `0` while noting incomplete or duplicate seed records explicitly.
3. **Scenario & Financial Modeling**:
   - Clearly define assumptions for **Worst Case** (e.g., closed-won + committed recurring contracts), **Expected Case** (probability-weighted pipeline + renewals), and **Best Case** (closed-won + full open pipeline + expansion/account income), showing both monthly/period breakdowns and grand totals.
4. **Deterministic Scripted Generation (`.html` + `.csv`)**:
   - Compute all aggregations via a deterministic Node script (`../output/compute.js`) rather than mental arithmetic so row counts, sums, and percentages are 100% exact.
   - Have `compute.js` emit:
     1. A polished, printable **Executive HTML Report** (`../output/deliverables/<slug>.html`) with Tailwind CSS (`@tailwindcss/browser@4`), KPI cards, inline `<svg>` scenario/monthly charts, formatted data tables, and a `window.print()` button.
     2. Companion RFC-4180 **CSV schedules** (`../output/deliverables/<slug>.csv`) for raw spreadsheet analysis.
   - Verify the HTML output with `node ../tools/rapider-task-cli.js verify-html --in=../output/deliverables/<slug>.html`.
