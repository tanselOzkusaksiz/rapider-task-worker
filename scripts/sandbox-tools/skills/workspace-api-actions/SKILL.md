---
name: workspace-api-actions
description: Executing safe, tenant-scoped Workspace API reads and updates through the capability proxy without direct credentials.
---

# Workspace API Actions Guide

1. **Scoped Proxy Access Only**:
   - All live Workspace API calls flow through `node ../tools/rapider-task-cli.js workspace-api --method=<GET|POST|PATCH> --path=<endpoint> [--body='<json>']`.
   - The host proxy automatically binds your request to this task's `projectId` and strips sensitive fields.
2. **Allowed Paths**:
   - `/project-data-manager/<dataTableName>` (GET, POST, PATCH)
   - `/project-models` (GET)
   - `/data-schemas` (GET)
   - `/message-templates` (GET, POST, PATCH)
   - `/template-definitions` (GET)
   - `/definitions` (GET)
3. **Destructive Action Ban**:
   - `DELETE` requests and cross-workspace endpoints (`/admin/*`, `/users/*`, `/projects*`) are blocked by policy. Never attempt to bypass the capability proxy.

