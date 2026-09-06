# Salesforce MCP Server

A local [Model Context Protocol](https://modelcontextprotocol.io) server that gives an MCP-compatible client (e.g. Claude Code) read and write access to a Salesforce org — SOQL queries, metadata/Apex/Flow inspection, permissions analysis, and guarded record writes.

## Cloning the repository

```bash
git clone https://github.com/anthony-cardiff/salesforce-MCP-server-sandbox.git
cd salesforce-MCP-server-sandbox
npm install
```

## Configuration

The server authenticates to Salesforce using the OAuth 2.0 **client credentials** flow, configured via a connected app in your org.

Copy the example env file and fill in your values:

```bash
cp .env.example .env
```

`.env` needs:

| Variable | Description |
|---|---|
| `SALESFORCE_INSTANCE_URL` | Base URL of your Salesforce org (e.g. `https://your-domain.my.salesforce.com`) |
| `SALESFORCE_CLIENT_ID` | Connected app consumer key |
| `SALESFORCE_CLIENT_SECRET` | Connected app consumer secret |

`.env` is gitignored and never committed.

## Building

```bash
npx tsc
```

This compiles `src/` into `dist/index.js`, which is what the MCP client actually launches.

## Registering the server with an MCP client

`.mcp.json` in this directory already declares the server for Claude Code:

```json
{
  "mcpServers": {
    "salesforce-sandbox": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/salesforce-MCP-server-sandbox/dist/index.js"],
      "env": {}
    }
  }
}
```

If you clone this to a different path, update the `args` path accordingly. Once registered, restart Claude Code (or run `/mcp` to reconnect) and the `salesforce-sandbox` tools become available.

## Tools

All tools are prefixed `salesforce_` (plus a `ping` health check). Tools marked **read-only** never modify data.

### Connectivity

- **`ping`** — confirms the server is running.

### Querying data

- **`salesforce_query`** — run a read-only SOQL `SELECT` against standard/custom objects.
- **`salesforce_tooling_query`** — run a read-only SOQL `SELECT` against the Tooling API (Apex, Flows, validation rules, metadata).
- **`salesforce_get_record`** — fetch a single record by object name + ID.

### Object & field metadata

- **`salesforce_list_objects`** — list all objects available to the authenticated user.
- **`salesforce_describe_object`** — full describe (fields, relationships, permissions) for one object.
- **`salesforce_list_fields`** — field list for an object (name, type, updateability, relationships, etc.).
- **`salesforce_get_record_types`** — record types defined on an object.
- **`salesforce_get_validation_rules`** — validation rules for an object.
- **`salesforce_get_layouts`** — page layouts for an object.
- **`salesforce_list_custom_metadata_types`** — list custom metadata types (`__mdt`).
- **`salesforce_query_custom_metadata`** — query records of a specific custom metadata type.
- **`salesforce_list_custom_settings`** — list custom setting objects.
- **`salesforce_get_dependencies`** — metadata dependencies for a named component.
- **`salesforce_find_field_references`** — components that reference a given field.
- **`salesforce_search_metadata`** — search across Apex classes/triggers, Flows, and layouts by name.

### Apex & Flows

- **`salesforce_get_apex_classes`** — list Apex classes, optionally filtered by name.
- **`salesforce_get_apex_source`** — full source code + metadata for one Apex class.
- **`salesforce_search_apex`** — full-text search across Apex class/trigger bodies.
- **`salesforce_get_apex_triggers`** — list Apex triggers.
- **`salesforce_get_apex_logs`** — recent Apex debug logs.
- **`salesforce_get_async_jobs`** — recent async Apex job status (batch, queueable, scheduled).
- **`salesforce_get_flows`** / **`salesforce_find_flow`** — list/search Flow definitions and their active/latest version IDs.
- **`salesforce_get_flow_details`** — raw metadata for a specific Flow version ID.
- **`salesforce_explain_flow`** — fetches a Flow by developer name and parses its metadata into a readable structure (variables, decisions, record operations, screens, subflows, etc.).

### Users & permissions

- **`salesforce_find_user`** — search users by name, username, email, or ID.
- **`salesforce_get_profiles`** — list profiles.
- **`salesforce_get_permission_sets`** / **`salesforce_get_permission_set_groups`** — list permission sets/groups.
- **`salesforce_get_object_permissions`** — which profiles/permission sets grant access to an object.
- **`salesforce_get_field_permissions`** — which profiles/permission sets grant access to a field.
- **`salesforce_get_user_permission_assignments`** — permission sets/groups assigned to a user.
- **`salesforce_explain_user_access`** — combines the above to explain *why* a specific user can (or can't) access a given object.

### Writing data

These require an explicit `confirm: true` argument — the model must state the write out loud, it won't happen implicitly.

- **`salesforce_create_record`** — insert one record.
- **`salesforce_update_record`** — update one record by ID.
- **`salesforce_preview_update`** — dry-run a bulk update: runs a `SELECT` and shows current vs. proposed field values for matched records, without writing anything.
- **`salesforce_prepare_bulk_update`** — validates a proposed bulk update (object writable, fields writable), runs the `SELECT`, and returns an `operationToken` plus a preview. No write happens here either.
- **`salesforce_execute_bulk_update`** — executes a bulk update previously prepared with `salesforce_prepare_bulk_update`, given its `operationToken` and `confirm: true`. Tokens expire after 15 minutes and are single-use.

## Usage

Once the server is connected, just ask the client to use it in natural language — it will pick the right tool(s) automatically. Examples:

```
Ping the salesforce sandbox to confirm it's connected.

List the fields on the Opportunity object.

Show me the last 20 Apex debug logs.

Find the user jane.doe@example.com and explain why she can't edit Contract_Details__c.

Search Apex code for any reference to Federal_Tax_ID_No__c.

Explain the Lender_Decision_Screen flow.

Preview setting Status__c = 'Closed' on all Contract_Details__c records where Stage__c = 'Expired', then run the bulk update if it looks right.
```

For direct/manual tool calls (e.g. scripting or testing), invoke the tool by name with its documented input, for example:

```json
{
  "tool": "salesforce_query",
  "input": { "query": "SELECT Id, Name FROM Account LIMIT 10" }
}
```

### Bulk update flow

Bulk writes are intentionally a two-step, token-gated process so nothing is modified without an explicit preview:

1. Call `salesforce_prepare_bulk_update` with the object, a `SELECT` query identifying target records, and the fields to change. It validates permissions, previews the affected records, and returns an `operationToken`.
2. Review the preview, then call `salesforce_execute_bulk_update` with that `operationToken` and `confirm: true` to actually apply the change.

## Notes

- Only `SELECT` statements are accepted by the query tools — no DML can be smuggled in through `salesforce_query` or `salesforce_tooling_query`.
- `dist/`, `node_modules/`, `logs/`, and `.env` are gitignored; run `npm install` and `npx tsc` after cloning before the server will run.
