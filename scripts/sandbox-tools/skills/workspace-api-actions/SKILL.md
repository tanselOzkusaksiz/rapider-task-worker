---
name: workspace-api-actions
description: Executing safe, tenant-scoped Workspace Project Data Manager CRUD and DataSource/MCP/Integration tool calls through the capability proxy.
---

# Workspace API & DataSource Actions Guide

1. **Read Prepared Schemas First**:
   - Check `.agents/project-data-models.md` for entity fields & relations, and `.agents/project-data-manager-guide.md` for the exact `Entity -> dataTableName` lookup table.
   - Check `.agents/workspace-datasources-and-integrations.md` for configured external integrations (Jira, Slack, Google Drive, OpenAPI, MCP servers) and their tool input schemas.
2. **Project Data Manager Commands (`rapider-task-cli.js`)**:
   - `query-data --table=<dataTableName> [--all] [--filter='{...}']`
   - `count-data --table=<dataTableName> [--where='{...}']`
   - `get-record --table=<dataTableName> --id=<uuid> [--filter='{...}']`
   - `create-record --table=<dataTableName> --data='{...}' | --file=payload.json`
   - `bulk-create-records --table=<dataTableName> --file=rows.json`
   - `update-record --table=<dataTableName> --id=<uuid> --data='{...}' [--replace]`
   - `delete-record --table=<dataTableName> --id=<uuid>` _(only when explicitly requested by the user task)_
3. **DataSource & MCP / Integration Commands**:
   - `list-datasources`
   - `list-datasource-tools --datasource=<dataSourceId>`
   - `run-datasource-tool --datasource=<dataSourceId> --tool=<toolName> --input='{...}'`
4. **Allowed Raw Proxy Paths (`workspace-api`)**:
   - `/project-data-manager/<dataTableName>` (`GET`, `POST`, `PATCH`, single-record soft `DELETE`)
   - `/data-sources`, `/data-sources/<id>/tools`, `/data-sources/<id>/tools/<toolName>/execute`
   - `/project-models` (`GET`), `/data-schemas` (`GET`), `/message-templates` (`GET`, `POST`, `PATCH`), `/template-definitions` (`GET`), `/definitions` (`GET`)
   - Cross-workspace and administrative endpoints (`/admin/*`, `/users*`, `/projects*`) are hard-blocked at the host proxy.
