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

### Advanced reasoning tools

These are composite tools: each one fans out across several of the primitive read-only tools above (describe calls, Tooling API queries, permission lookups, dependency search, log/job inspection, etc.) and returns one synthesized report, so the model can reason over a single coherent picture instead of stitching together many separate tool calls itself.

- **`salesforce_explain_object`** — full technical profile of an object: fields, child relationships, record types, validation rules, page layouts, Apex triggers, metadata dependencies, and object permissions, plus summary counts.
- **`salesforce_explain_field`** — full technical profile of a single field: schema details (type/formula/relationship info), field-level permissions, and metadata dependencies that reference it.
- **`salesforce_explain_record_access`** — explains one user's access to one specific record by combining effective record access, ownership, profile, permission sets/groups, object permissions, and sharing info.
- **`salesforce_compare_users`** — diffs two users side by side across profile, role, license, permission sets, permission set groups, and (optionally) object-level permissions on a given object.
- **`salesforce_find_every_reference`** — broad cross-metadata search for an API name or keyword across Apex classes/triggers, Flows, validation rules, custom fields, layouts, and custom metadata types, in one pass.
- **`salesforce_diagnose_error`** — takes a raw error message, exception, or component name and cross-references Apex logs, async jobs, Flows, Apex source, validation rules, and metadata dependencies, then heuristically classifies the likely root cause (e.g. `PERMISSIONS_OR_SHARING`, `VALIDATION_RULE`, `FLOW_OR_PROCESS_AUTOMATION`).

### Schema cache

Object `describe()` calls (full field lists, relationships, picklists, permissions) are one of the more expensive things this server asks Salesforce for, and they're also the ones most likely to be requested repeatedly for the same object in a single session — e.g. `salesforce_list_fields` on `Opportunity`, then `salesforce_explain_object` on `Opportunity`, then `salesforce_update_record` against `Opportunity`, all a few tool calls apart. Rather than re-fetching that describe from Salesforce every time, the server keeps an in-memory cache (keyed by object API name, 10-minute TTL) and reuses it across calls. `salesforce_describe_object`, `salesforce_list_fields`, `salesforce_query_custom_metadata`, `salesforce_list_custom_settings`, `salesforce_create_record`, `salesforce_update_record`, `salesforce_prepare_bulk_update`, `salesforce_explain_object`, `salesforce_explain_record_access`, and `salesforce_explain_field` all pull schema through this cache instead of describing independently.

The payoff is fewer round trips to Salesforce (and less exposure to the org's API call limits), not smaller tool responses — a cache hit still returns the same describe data, it just skips the network call to get it. That matters most for the composite "advanced reasoning" tools above, which can otherwise trigger several redundant describes of the same object while assembling one report, and for any multi-step conversation that keeps coming back to the same object.

You generally don't need to do anything for this to work — it's automatic. Three tools exist for when you want visibility or control over it:

- **`salesforce_schema_cache_status`** — read-only — lists what's currently cached, per object, with remaining TTL.
- **`salesforce_warm_schema_cache`** — read-only — preloads describes for a list of objects (useful before a batch of operations against objects you know you'll need, so the first real call doesn't pay the describe cost).
- **`salesforce_clear_schema_cache`** — read-only — evicts one object (pass `objectName`) or the whole cache; use this if you've just changed an object's schema in Salesforce (new/changed field, layout, etc.) and want the server to pick it up immediately instead of waiting out the TTL.

The cache lives in process memory only — it's empty on every server restart and isn't shared across separate server processes.

### Writing data

These require an explicit `confirm: true` argument — the model must state the write out loud, it won't happen implicitly.

- **`salesforce_create_record`** — insert one record.
- **`salesforce_update_record`** — update one record by ID.
- **`salesforce_preview_update`** — dry-run a bulk update: runs a `SELECT` and shows current vs. proposed field values for matched records, without writing anything.
- **`salesforce_prepare_bulk_update`** — validates a proposed bulk update (object writable, fields writable), runs the `SELECT`, and returns an `operationToken` plus a preview. No write happens here either.
- **`salesforce_execute_bulk_update`** — executes a bulk update previously prepared with `salesforce_prepare_bulk_update`, given its `operationToken` and `confirm: true`. Tokens expire after 15 minutes and are single-use. Before/after values are written to the audit log so the update can be rolled back.
- **`salesforce_rollback_bulk_update`** — given the `auditId` returned by `salesforce_execute_bulk_update` and `confirm: true`, restores the affected records to the field values captured before that update ran.

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

Give me a full technical profile of the Opportunity object.

Compare user 005XXXXXXXXXXXXAAA and 005YYYYYYYYYYYYAAA — why does one have access I'd expect and the other doesn't?

I'm seeing "INSUFFICIENT_ACCESS_ON_CROSS_REFERENCE_ENTITY" when saving an Opportunity — diagnose it.

Find every place Second_Signer__c is referenced across the org.

Warm the schema cache for Account, Contact, and Opportunity before we start.

Show me the current schema cache status.
```

For direct/manual tool calls (e.g. scripting or testing), invoke the tool by name with its documented input, for example:

```json
{
  "tool": "salesforce_query",
  "input": { "query": "SELECT Id, Name FROM Account LIMIT 10" }
}
```

### Bulk update flow

Bulk writes are intentionally a multi-step, token-gated process so nothing is modified without an explicit preview, and every executed change can be undone:

1. Call `salesforce_prepare_bulk_update` with the object, a `SELECT` query identifying target records, and the fields to change. It validates permissions, previews the affected records, and returns an `operationToken`.
2. Review the preview, then call `salesforce_execute_bulk_update` with that `operationToken` and `confirm: true` to actually apply the change. It returns an `auditId` and the pre-update field values are persisted to the audit log.
3. If needed, call `salesforce_rollback_bulk_update` with that `auditId` and `confirm: true` to restore the affected records to their prior values.

## Notes

- Only `SELECT` statements are accepted by the query tools — no DML can be smuggled in through `salesforce_query` or `salesforce_tooling_query`.
- `dist/`, `node_modules/`, `logs/`, and `.env` are gitignored; run `npm install` and `npx tsc` after cloning before the server will run.
- Bulk update audit records (used by `salesforce_rollback_bulk_update`) are appended to `logs/bulk-updates.jsonl`, created automatically on first execute.
- The schema cache (see [Schema cache](#schema-cache)) is in-memory only, TTLs after 10 minutes, and resets on restart — if you've just edited an object's schema in Salesforce, call `salesforce_clear_schema_cache` rather than waiting for it to expire.
