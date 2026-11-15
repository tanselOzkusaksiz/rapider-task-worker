---
name: complex-data-reporting
description: Multi-model Workspace data aggregation, financial best/worst-case scenario modeling, soft-delete safe querying, and cross-table reconciliation. Activate when generating reports, projections, KPI summaries, or audits from Workspace tables.
---

# Complex Data Reporting Playbook

1. **Inspect Exact Field Schemas First**:
   - Read `workspace-context/WORKSPACE_CONTEXT.md` and `workspace-context/models/*.model.json` to confirm exact `dataTableName`, numeric/currency fields, date fields, status enums, and foreign keys (`accountId`, `opportunityId`, etc.).
2. **Fetch Complete Datasets Safely**:
   - Run `node ../tools/rapider-task-cli.js query-data --table=<dataTableName> --all --out=../output/raw-<table>.json` for every relevant model.
   - Verify `isDeleted !== true` on all records and handle `null`/missing numeric fields as `0` while noting incomplete records explicitly.
3. **Scenario & Financial Modeling**:
   - Clearly define assumptions for **Worst Case** (e.g., closed-won + committed recurring contracts) vs **Best Case** (e.g., closed-won + open pipeline weighted or unweighted + expansion/account income), showing both monthly/period breakdowns and grand totals.
4. **Reconcile Totals**:
   - Compute aggregations via a deterministic Node script (`../output/compute.js`) rather than mental arithmetic so row counts, sums, and percentages are 100% exact.
