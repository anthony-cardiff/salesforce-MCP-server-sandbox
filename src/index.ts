import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import * as z from 'zod/v4';
import { getSalesforceConnection } from './salesforce.js';
import type { 
  DescribeSObjectResult, 
  Connection, 
} from 'jsforce';

/**********************    < HELPER FUNCTIONS >    **********************/ 

function jsonResult(value: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

function escapeSoql(value: string) {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function normalizeSalesforceError(error: unknown) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }

  return {
    message: String(error),
  };
}

/**
 * Query MetadataComponentDependency by component name.
 *
 * The Tooling API only accepts the Id columns in a WHERE clause on this
 * object (filtering on the *Name columns fails with "... is unknown"), so
 * names are resolved to Ids first. Standard objects use their own name as
 * the Id, flows use version Ids (301...), and everything else uses the
 * normal record Id. Dependencies are fetched in both directions: components
 * that use the match, and components the match uses.
 */
async function queryDependenciesByName(
  conn: Connection,
  name: string,
  match: 'exact' | 'contains'
) {
  const safe = escapeSoql(name);
  const developerName = escapeSoql(name.replace(/__(c|mdt|e|x)$/i, ''));
  const likeValue = (value: string) =>
    match === 'exact' ? value : `%${value.replace(/([%_])/g, '\\$1')}%`;
  const operator = match === 'exact' ? '=' : 'LIKE';

  const lookups: Array<[string, string]> = [
    ['CustomField', `SELECT Id FROM CustomField WHERE DeveloperName ${operator} '${likeValue(developerName)}' LIMIT 200`],
    ['CustomObject', `SELECT Id FROM CustomObject WHERE DeveloperName ${operator} '${likeValue(developerName)}' LIMIT 200`],
    ['ApexClass', `SELECT Id FROM ApexClass WHERE Name ${operator} '${likeValue(safe)}' LIMIT 200`],
    ['ApexTrigger', `SELECT Id FROM ApexTrigger WHERE Name ${operator} '${likeValue(safe)}' LIMIT 200`],
    ['ApexPage', `SELECT Id FROM ApexPage WHERE Name ${operator} '${likeValue(safe)}' LIMIT 200`],
    ['Flow', `SELECT Id FROM Flow WHERE Definition.DeveloperName ${operator} '${likeValue(safe)}' LIMIT 200`],
  ];

  // Standard objects are keyed by name, so the name itself is a candidate Id.
  const ids = new Set<string>([name]);
  const lookupErrors: Record<string, unknown> = {};

  const settled = await Promise.allSettled(
    lookups.map(([, soql]) => conn.tooling.query(soql))
  );

  settled.forEach((outcome, index) => {
    const label = lookups[index][0];

    if (outcome.status === 'fulfilled') {
      for (const record of outcome.value.records as any[]) {
        ids.add(record.Id);
      }
    } else {
      lookupErrors[label] = normalizeSalesforceError(outcome.reason);
    }
  });

  const columns = `MetadataComponentId,
               MetadataComponentName,
               MetadataComponentType,
               RefMetadataComponentId,
               RefMetadataComponentName,
               RefMetadataComponentType`;

  const idList = [...ids];
  const chunkSize = 100;
  const rows = new Map<string, any>();

  for (let i = 0; i < idList.length; i += chunkSize) {
    const inList = idList
      .slice(i, i + chunkSize)
      .map((id) => `'${escapeSoql(id)}'`)
      .join(', ');

    for (const column of ['RefMetadataComponentId', 'MetadataComponentId']) {
      const result = await conn.tooling.query(`
        SELECT ${columns}
        FROM MetadataComponentDependency
        WHERE ${column} IN (${inList})
        LIMIT 2000
      `);

      for (const record of result.records as any[]) {
        rows.set(
          `${record.MetadataComponentId}|${record.RefMetadataComponentId}`,
          record
        );
      }
    }
  }

  const records = [...rows.values()];

  return {
    totalSize: records.length,
    done: true,
    records,
    ...(Object.keys(lookupErrors).length > 0 ? { lookupErrors } : {}),
  };
}

function summarizeFlowMetadata(metadata: any) {
  return {
    label: metadata?.label,
    description: metadata?.description,
    processType: metadata?.processType,
    status: metadata?.status,
    start: metadata?.start ?? null,

    variables: metadata?.variables ?? [],
    formulas: metadata?.formulas ?? [],
    constants: metadata?.constants ?? [],

    recordLookups: metadata?.recordLookups ?? [],
    recordCreates: metadata?.recordCreates ?? [],
    recordUpdates: metadata?.recordUpdates ?? [],
    recordDeletes: metadata?.recordDeletes ?? [],

    decisions: metadata?.decisions ?? [],
    assignments: metadata?.assignments ?? [],
    loops: metadata?.loops ?? [],
    screens: metadata?.screens ?? [],
    subflows: metadata?.subflows ?? [],
    actionCalls: metadata?.actionCalls ?? [],

    collectionProcessors: metadata?.collectionProcessors ?? [],
    waits: metadata?.waits ?? [],
  };
}


/***** Salesforce Get Flow Graph *****/ 

function flowElementName(element: any): string | null {
  return element?.name ?? null;
}

function getConnectorTarget(connector: any): string | null {
  if (!connector) {
    return null;
  }

  return (
    connector.targetReference ??
    connector.targetElementReference ??
    null
  );
}

function collectFlowGraph(metadata: any) {
  const nodes: any[] = [];
  const edges: any[] = [];

  const addNode = (
    type: string,
    element: any,
    extra: Record<string, unknown> = {}
  ) => {
    const name = flowElementName(element);

    if (!name) {
      return;
    }

    nodes.push({
      id: name,
      type,
      label: element.label ?? name,
      ...extra,
    });

    const connectorTarget = getConnectorTarget(
      element.connector
    );

    if (connectorTarget) {
      edges.push({
        from: name,
        to: connectorTarget,
        type: 'connector',
      });
    }

    const faultTarget = getConnectorTarget(
      element.faultConnector
    );

    if (faultTarget) {
      edges.push({
        from: name,
        to: faultTarget,
        type: 'fault',
      });
    }
  };

  // ------------------------------------------------------------
  // START
  // ------------------------------------------------------------

  if (metadata?.start) {
    nodes.push({
      id: '__START__',
      type: 'start',
      label: 'Start',
      object: metadata.start.object ?? null,
      triggerType: metadata.start.triggerType ?? null,
      recordTriggerType:
        metadata.start.recordTriggerType ?? null,
    });

    const target = getConnectorTarget(
      metadata.start.connector
    );

    if (target) {
      edges.push({
        from: '__START__',
        to: target,
        type: 'start',
      });
    }
  }

  // ------------------------------------------------------------
  // SCREENS
  // ------------------------------------------------------------

  for (const element of metadata?.screens ?? []) {
    addNode('screen', element, {
      allowBack: element.allowBack,
      allowFinish: element.allowFinish,
      allowPause: element.allowPause,
      fields:
        element.fields?.map((field: any) => ({
          name: field.name,
          fieldType: field.fieldType,
          dataType: field.dataType,
        })) ?? [],
    });
  }

  // ------------------------------------------------------------
  // ASSIGNMENTS
  // ------------------------------------------------------------

  for (const element of metadata?.assignments ?? []) {
    addNode('assignment', element, {
      assignments:
        element.assignmentItems?.map((item: any) => ({
          assignToReference:
            item.assignToReference,
          operator: item.operator,
          value: item.value,
        })) ?? [],
    });
  }

  // ------------------------------------------------------------
  // RECORD LOOKUPS
  // ------------------------------------------------------------

  for (const element of metadata?.recordLookups ?? []) {
    addNode('recordLookup', element, {
      object: element.object,
      assignNullValuesIfNoRecordsFound:
        element.assignNullValuesIfNoRecordsFound,
      getFirstRecordOnly:
        element.getFirstRecordOnly,
      filters: element.filters ?? [],
      outputAssignments:
        element.outputAssignments ?? [],
    });
  }

  // ------------------------------------------------------------
  // RECORD CREATES
  // ------------------------------------------------------------

  for (const element of metadata?.recordCreates ?? []) {
    addNode('recordCreate', element, {
      object: element.object,
      inputAssignments:
        element.inputAssignments ?? [],
      inputReference:
        element.inputReference ?? null,
    });
  }

  // ------------------------------------------------------------
  // RECORD UPDATES
  // ------------------------------------------------------------

  for (const element of metadata?.recordUpdates ?? []) {
    addNode('recordUpdate', element, {
      object: element.object,
      filters: element.filters ?? [],
      inputAssignments:
        element.inputAssignments ?? [],
      inputReference:
        element.inputReference ?? null,
    });
  }

  // ------------------------------------------------------------
  // RECORD DELETES
  // ------------------------------------------------------------

  for (const element of metadata?.recordDeletes ?? []) {
    addNode('recordDelete', element, {
      object: element.object,
      filters: element.filters ?? [],
      inputReference:
        element.inputReference ?? null,
    });
  }

  // ------------------------------------------------------------
  // DECISIONS
  // ------------------------------------------------------------

  for (const element of metadata?.decisions ?? []) {
    const name = flowElementName(element);

    if (!name) {
      continue;
    }

    nodes.push({
      id: name,
      type: 'decision',
      label: element.label ?? name,
      defaultConnectorLabel:
        element.defaultConnectorLabel ?? null,
    });

    for (const rule of element.rules ?? []) {
      const target = getConnectorTarget(
        rule.connector
      );

      if (target) {
        edges.push({
          from: name,
          to: target,
          type: 'decisionRule',
          label: rule.label ?? rule.name,
          ruleName: rule.name,
          conditionLogic:
            rule.conditionLogic ?? null,
          conditions:
            rule.conditions ?? [],
        });
      }
    }

    const defaultTarget = getConnectorTarget(
      element.defaultConnector
    );

    if (defaultTarget) {
      edges.push({
        from: name,
        to: defaultTarget,
        type: 'decisionDefault',
        label:
          element.defaultConnectorLabel ??
          'Default',
      });
    }
  }

  // ------------------------------------------------------------
  // LOOPS
  // ------------------------------------------------------------

  for (const element of metadata?.loops ?? []) {
    const name = flowElementName(element);

    if (!name) {
      continue;
    }

    nodes.push({
      id: name,
      type: 'loop',
      label: element.label ?? name,
      collectionReference:
        element.collectionReference ?? null,
      iterationOrder:
        element.iterationOrder ?? null,
    });

    const nextTarget = getConnectorTarget(
      element.nextValueConnector
    );

    if (nextTarget) {
      edges.push({
        from: name,
        to: nextTarget,
        type: 'loopNext',
      });
    }

    const noMoreTarget = getConnectorTarget(
      element.noMoreValuesConnector
    );

    if (noMoreTarget) {
      edges.push({
        from: name,
        to: noMoreTarget,
        type: 'loopDone',
      });
    }
  }

  // ------------------------------------------------------------
  // SUBFLOWS
  // ------------------------------------------------------------

  for (const element of metadata?.subflows ?? []) {
    addNode('subflow', element, {
      flowName:
        element.flowName ?? null,
      inputAssignments:
        element.inputAssignments ?? [],
      outputAssignments:
        element.outputAssignments ?? [],
    });
  }

  // ------------------------------------------------------------
  // ACTION CALLS
  // ------------------------------------------------------------

  for (const element of metadata?.actionCalls ?? []) {
    addNode('actionCall', element, {
      actionName:
        element.actionName ?? null,
      actionType:
        element.actionType ?? null,
      inputParameters:
        element.inputParameters ?? [],
      outputParameters:
        element.outputParameters ?? [],
    });
  }

  // ------------------------------------------------------------
  // COLLECTION PROCESSORS
  // ------------------------------------------------------------

  for (
    const element of
    metadata?.collectionProcessors ?? []
  ) {
    addNode('collectionProcessor', element, {
      collectionProcessorType:
        element.collectionProcessorType ?? null,
      collectionReference:
        element.collectionReference ?? null,
    });
  }

  // ------------------------------------------------------------
  // WAITS / PAUSES
  // ------------------------------------------------------------

  for (const element of metadata?.waits ?? []) {
    addNode('wait', element, {
      waitEvents:
        element.waitEvents ?? [],
    });
  }

  return {
    nodes,
    edges,
    summary: {
      nodeCount: nodes.length,
      edgeCount: edges.length,
      nodeTypes: nodes.reduce(
        (
          acc: Record<string, number>,
          node: any
        ) => {
          acc[node.type] =
            (acc[node.type] ?? 0) + 1;

          return acc;
        },
        {}
      ),
    },
  };
}


const pendingBulkUpdates = new Map<
  string,
  {
    objectName: string;
    recordIds: string[];
    proposedFields: Record<string, unknown>;
    createdAt: number;
  }
>();

const auditLogPath = path.resolve('logs', 'bulk-updates.jsonl');

async function appendAuditLog(entry: unknown) {
  await fs.mkdir(path.dirname(auditLogPath), { recursive: true });
  await fs.appendFile(
    auditLogPath,
    JSON.stringify(entry) + '\n',
    'utf8'
  );
}


/***** Schema Cache *****/

const schemaCache = new Map<
  string,
  {
    value: DescribeSObjectResult;
    expiresAt: number;
  }
>();

const SCHEMA_CACHE_TTL_MS = 10 * 60 * 1000;

async function getCachedDescribe(
  conn: Connection,
  objectName: string
): Promise<{
  source: 'cache' | 'salesforce';
  description: DescribeSObjectResult;
}> {
  const key = objectName.toLowerCase();
  const now = Date.now();

  const cached = schemaCache.get(key);

  if (cached && cached.expiresAt > now) {
    return {
      source: 'cache',
      description: cached.value,
    };
  }

  const description = await conn
    .sobject(objectName)
    .describe();

  schemaCache.set(key, {
    value: description,
    expiresAt: now + SCHEMA_CACHE_TTL_MS,
  });

  return {
    source: 'salesforce',
    description,
  };
}

function clearSchemaCache(
  objectName?: string
) {
  if (objectName) {
    schemaCache.delete(
      objectName.toLowerCase()
    );

    return;
  }

  schemaCache.clear();
}

function createOperationToken() {
  return crypto.randomUUID();
}

/**********************    </ HELPER FUNCTIONS >   **********************/ 


function createServer() {
  const server = new McpServer({
    name: 'salesforce-mcp',
    version: '1.1.0',
  });

  server.registerTool(
    'ping',
    {
      description: 'Test that the Salesforce MCP server is running.',
      annotations: {
        readOnlyHint: true,
      },
    },
    async () =>
      jsonResult({
        status: 'ok',
        message: 'Salesforce MCP server is running.',
      })
  );

  server.registerTool(
    'salesforce_query',
    {
      description:
        'Run a read-only SOQL SELECT query against Salesforce.',
      inputSchema: z.object({
        query: z.string().describe('SOQL SELECT query'),
      }),
      annotations: {
        readOnlyHint: true,
      },
    },
    async ({ query }) => {
      const trimmed = query.trim();

      if (!/^SELECT\b/i.test(trimmed)) {
        throw new Error('Only SELECT SOQL queries are allowed.');
      }

      const conn = await getSalesforceConnection();
      const result = await conn.query(trimmed);

      return jsonResult(result);
    }
  );

  server.registerTool(
    'salesforce_tooling_query',
    {
      description:
        'Run a read-only SOQL SELECT query against the Salesforce Tooling API. Useful for Apex, Flows, validation rules, metadata, and configuration inspection.',
      inputSchema: z.object({
        query: z.string().describe('Tooling API SOQL SELECT query'),
      }),
      annotations: {
        readOnlyHint: true,
      },
    },
    async ({ query }) => {
      const trimmed = query.trim();

      if (!/^SELECT\b/i.test(trimmed)) {
        throw new Error('Only SELECT Tooling API queries are allowed.');
      }

      const conn = await getSalesforceConnection();
      const result = await conn.tooling.query(trimmed);

      return jsonResult(result);
    }
  );

  server.registerTool(
    'salesforce_describe_object',
    {
      description:
        'Describe a Salesforce object including its fields, relationships, permissions, and metadata.',
      inputSchema: z.object({
        objectName: z
          .string()
          .describe('Object API name such as Account or Opportunity'),
      }),
      annotations: {
        readOnlyHint: true,
      },
    },
    async ({ objectName }) => {
      const conn = await getSalesforceConnection();
     // const result = await conn.sobject(objectName).describe();
     // return jsonResult(result);

     const cached = await getCachedDescribe(conn, objectName);
     return jsonResult({ 
      cacheSource: cached.source,
      description: cached.description,
      });
    }
  );

  server.registerTool(
    'salesforce_list_objects',
    {
      description:
        'List Salesforce objects available to the authenticated execution user.',
      annotations: {
        readOnlyHint: true,
      },
    },
    async () => {
      const conn = await getSalesforceConnection();
      const result = await conn.describeGlobal();

      return jsonResult(result);
    }
  );

  server.registerTool(
    'salesforce_list_fields',
    {
      description:
        'List the fields for a Salesforce object with API names, labels, data types, updateability, and relationship information.',
      inputSchema: z.object({
        objectName: z.string().describe('Salesforce object API name'),
      }),
      annotations: {
        readOnlyHint: true,
      },
    },
    async ({ objectName }) => {
      const conn = await getSalesforceConnection();
      // const description = await conn.sobject(objectName).describe();
      const cached =
        await getCachedDescribe(
          conn,
          objectName
        );

      const description = cached.description;

      const fields = description.fields.map((field) => ({
        name: field.name,
        label: field.label,
        type: field.type,
        length: field.length,
        custom: field.custom,
        nillable: field.nillable,
        createable: field.createable,
        updateable: field.updateable,
        calculated: field.calculated,
        referenceTo: field.referenceTo,
        relationshipName: field.relationshipName,
      }));

      return jsonResult(fields);
    }
  );

  server.registerTool(
    'salesforce_get_record',
    {
      description:
        'Retrieve a Salesforce record by object API name and record ID.',
      inputSchema: z.object({
        objectName: z.string().describe('Salesforce object API name'),
        recordId: z.string().describe('15 or 18 character Salesforce record ID'),
      }),
      annotations: {
        readOnlyHint: true,
      },
    },
    async ({ objectName, recordId }) => {
      const conn = await getSalesforceConnection();
      const result = await conn.sobject(objectName).retrieve(recordId);

      return jsonResult(result);
    }
  );

  server.registerTool(
    'salesforce_get_record_types',
    {
      description:
        'List record types available for a Salesforce object.',
      inputSchema: z.object({
        objectName: z.string().describe('Salesforce object API name'),
      }),
      annotations: {
        readOnlyHint: true,
      },
    },
    async ({ objectName }) => {
      const conn = await getSalesforceConnection();

      const query = `
        SELECT Id, Name, DeveloperName, SobjectType, IsActive
        FROM RecordType
        WHERE SobjectType = '${objectName.replace(/'/g, "\\'")}'
        ORDER BY Name
      `;

      const result = await conn.query(query);

      return jsonResult(result);
    }
  );

  server.registerTool(
    'salesforce_get_validation_rules',
    {
      description:
        'List validation rules for a Salesforce object using the Tooling API.',
      inputSchema: z.object({
        objectName: z.string().describe('Salesforce object API name'),
      }),
      annotations: {
        readOnlyHint: true,
      },
    },
    async ({ objectName }) => {
      const conn = await getSalesforceConnection();

      const entityResult = await conn.tooling.query<{
        Id: string;
        QualifiedApiName: string;
      }>(
        `SELECT Id, QualifiedApiName
         FROM EntityDefinition
         WHERE QualifiedApiName = '${objectName.replace(/'/g, "\\'")}'
         LIMIT 1`
      );

      if (entityResult.records.length === 0) {
        throw new Error(`Object not found: ${objectName}`);
      }

      const entityId = entityResult.records[0].Id;

      const result = await conn.tooling.query(
        `SELECT Id, ValidationName, Active, Description, ErrorMessage
         FROM ValidationRule
         WHERE EntityDefinitionId = '${entityId}'`
      );

      return jsonResult(result);
    }
  );

  server.registerTool(
    'salesforce_get_flows',
    {
      description:
        'List Salesforce Flow definitions and active versions using the Tooling API.',
      inputSchema: z.object({
        nameContains: z
          .string()
          .optional()
          .describe('Optional text to filter Flow developer names'),
      }),
      annotations: {
        readOnlyHint: true,
      },
    },
    async ({ nameContains }) => {
      const conn = await getSalesforceConnection();

      let query = `
        SELECT Id, DeveloperName, MasterLabel, ActiveVersionId,
               LatestVersionId, ProcessType
        FROM FlowDefinitionView
      `;

      if (nameContains) {
        const escaped = nameContains.replace(/'/g, "\\'");
        query += ` WHERE DeveloperName LIKE '%${escaped}%'`;
      }

      query += ' ORDER BY DeveloperName';

      const result = await conn.tooling.query(query);

      return jsonResult(result);
    }
  );

  server.registerTool(
    'salesforce_get_apex_classes',
    {
      description:
        'List Apex classes and basic metadata using the Tooling API.',
      inputSchema: z.object({
        nameContains: z
          .string()
          .optional()
          .describe('Optional text to filter Apex class names'),
      }),
      annotations: {
        readOnlyHint: true,
      },
    },
    async ({ nameContains }) => {
      const conn = await getSalesforceConnection();

      let query = `
        SELECT Id, Name, ApiVersion, Status, NamespacePrefix,
               LengthWithoutComments
        FROM ApexClass
      `;

      if (nameContains) {
        const escaped = nameContains.replace(/'/g, "\\'");
        query += ` WHERE Name LIKE '%${escaped}%'`;
      }

      query += ' ORDER BY Name';

      const result = await conn.tooling.query(query);

      return jsonResult(result);
    }
  );

  server.registerTool(
    'salesforce_get_apex_triggers',
    {
      description:
        'List Apex triggers using the Salesforce Tooling API.',
      inputSchema: z.object({
        nameContains: z.string().optional(),
      }),
      annotations: {
        readOnlyHint: true,
      },
    },
    async ({ nameContains }) => {
      const conn = await getSalesforceConnection();

      let query = `
        SELECT Id, Name, TableEnumOrId, ApiVersion, Status
        FROM ApexTrigger
      `;

      if (nameContains) {
        const escaped = nameContains.replace(/'/g, "\\'");
        query += ` WHERE Name LIKE '%${escaped}%'`;
      }

      query += ' ORDER BY Name';

      const result = await conn.tooling.query(query);

      return jsonResult(result);
    }
  );

  server.registerTool(
    'salesforce_get_permission_sets',
    {
      description:
        'List permission sets in the Salesforce org.',
      inputSchema: z.object({
        nameContains: z.string().optional(),
      }),
      annotations: {
        readOnlyHint: true,
      },
    },
    async ({ nameContains }) => {
      const conn = await getSalesforceConnection();

      let query = `
        SELECT Id, Name, Label, IsOwnedByProfile, ProfileId
        FROM PermissionSet
      `;

      if (nameContains) {
        const escaped = nameContains.replace(/'/g, "\\'");
        query += ` WHERE Name LIKE '%${escaped}%' OR Label LIKE '%${escaped}%'`;
      }

      query += ' ORDER BY Label';

      const result = await conn.query(query);

      return jsonResult(result);
    }
  );

  server.registerTool(
    'salesforce_get_object_permissions',
    {
      description:
        'Inspect which profiles and permission sets grant object-level access to a Salesforce object.',
      inputSchema: z.object({
        objectName: z
          .string()
          .describe('Object API name such as Opportunity or Contract_Details__c'),
      }),
      annotations: {
        readOnlyHint: true,
      },
    },
    async ({ objectName }) => {
      const conn = await getSalesforceConnection();
      const escaped = objectName.replace(/'/g, "\\'");

      const result = await conn.query(`
        SELECT
          Id,
          ParentId,
          Parent.Name,
          Parent.Label,
          Parent.IsOwnedByProfile,
          SObjectType,
          PermissionsRead,
          PermissionsCreate,
          PermissionsEdit,
          PermissionsDelete,
          PermissionsViewAllRecords,
          PermissionsModifyAllRecords
        FROM ObjectPermissions
        WHERE SObjectType = '${escaped}'
        ORDER BY Parent.Label
      `);

      return jsonResult(result);
    }
  );

  server.registerTool(
    'salesforce_get_field_permissions',
    {
      description:
        'Inspect which profiles and permission sets grant read/edit access to a specific Salesforce field.',
      inputSchema: z.object({
        objectName: z.string(),
        fieldName: z
          .string()
          .describe('Field API name, for example Opportunity.Amount'),
      }),
      annotations: {
        readOnlyHint: true,
      },
    },
    async ({ objectName, fieldName }) => {
      const conn = await getSalesforceConnection();

      const fullFieldName = fieldName.includes('.')
        ? fieldName
        : `${objectName}.${fieldName}`;

      const escaped = fullFieldName.replace(/'/g, "\\'");

      const result = await conn.query(`
        SELECT
          Id,
          ParentId,
          Parent.Name,
          Parent.Label,
          Parent.IsOwnedByProfile,
          SObjectType,
          Field,
          PermissionsRead,
          PermissionsEdit
        FROM FieldPermissions
        WHERE Field = '${escaped}'
        ORDER BY Parent.Label
      `);

      return jsonResult(result);
    }
  );

  server.registerTool(
    'salesforce_get_user_permission_assignments',
    {
      description:
        'List permission sets and permission set groups assigned to a Salesforce user.',
      inputSchema: z.object({
        userId: z.string().describe('Salesforce User ID'),
      }),
      annotations: {
        readOnlyHint: true,
      },
    },
    async ({ userId }) => {
      const conn = await getSalesforceConnection();
      const escaped = userId.replace(/'/g, "\\'");

      const permissionSets = await conn.query(`
        SELECT
          Id,
          AssigneeId,
          PermissionSetId,
          PermissionSet.Name,
          PermissionSet.Label,
          PermissionSet.IsOwnedByProfile
        FROM PermissionSetAssignment
        WHERE AssigneeId = '${escaped}'
      `);

      const groups = await conn.query(`
        SELECT
          Id,
          AssigneeId,
          PermissionSetGroupId,
          PermissionSetGroup.DeveloperName,
          PermissionSetGroup.MasterLabel
        FROM PermissionSetAssignment
        WHERE AssigneeId = '${escaped}'
        AND PermissionSetGroupId != null
      `);

      return jsonResult({
        permissionSets,
        permissionSetGroups: groups,
      });
    }
  );
  server.registerTool(
    'salesforce_get_flow_details',
    {
      description:
        'Retrieve detailed metadata for a specific Salesforce Flow version using the Tooling API.',
      inputSchema: z.object({
        flowId: z
          .string()
          .describe('Salesforce Flow version ID, usually beginning with 301'),
      }),
      annotations: {
        readOnlyHint: true,
      },
    },
    async ({ flowId }) => {
      const conn = await getSalesforceConnection();

      const safeId = flowId.replace(/'/g, "\\'");

      const result = await conn.tooling.query(`
        SELECT Id,
               DefinitionId,
               VersionNumber,
               Status,
               MasterLabel,
               ProcessType,
               ApiVersion,
               Description,
               Metadata
        FROM Flow
        WHERE Id = '${safeId}'
        LIMIT 1
      `);

      if (result.records.length === 0) {
        throw new Error(`Flow not found: ${flowId}`);
      }

      return jsonResult(result.records[0]);
    }
  );

  server.registerTool(
    'salesforce_get_apex_source',
    {
      description:
        'Retrieve the source code and metadata for a Salesforce Apex class.',
      inputSchema: z.object({
        className: z
          .string()
          .describe('Apex class name, for example LeadTriggerHandler'),
      }),
      annotations: {
        readOnlyHint: true,
      },
    },
    async ({ className }) => {
      const conn = await getSalesforceConnection();
      const safeName = className.replace(/'/g, "\\'");

      const result = await conn.tooling.query(`
        SELECT Id,
               Name,
               Body,
               ApiVersion,
               Status,
               NamespacePrefix,
               LengthWithoutComments
        FROM ApexClass
        WHERE Name = '${safeName}'
        LIMIT 1
      `);

      if (result.records.length === 0) {
        throw new Error(`Apex class not found: ${className}`);
      }

      return jsonResult(result.records[0]);
    }
  );

  server.registerTool(
    'salesforce_list_custom_metadata_types',
    {
      description:
        'List custom metadata types in the Salesforce org.',
      annotations: {
        readOnlyHint: true,
      },
    },
    async () => {
      const conn = await getSalesforceConnection();
      const global = await conn.describeGlobal();

      const types = global.sobjects
        .filter((obj) => obj.name.endsWith('__mdt'))
        .map((obj) => ({
          name: obj.name,
          label: obj.label,
          labelPlural: obj.labelPlural,
          queryable: obj.queryable,
        }));

      return jsonResult(types);
    }
  );

  server.registerTool(
    'salesforce_query_custom_metadata',
    {
      description:
        'Query records from a Salesforce custom metadata type.',
      inputSchema: z.object({
        metadataType: z
          .string()
          .describe('Custom metadata API name ending in __mdt'),
        limit: z.number().int().min(1).max(200).default(100),
      }),
      annotations: {
        readOnlyHint: true,
      },
    },
    async ({ metadataType, limit }) => {
      if (!/^[A-Za-z0-9_]+__mdt$/.test(metadataType)) {
        throw new Error(
          'metadataType must be a valid custom metadata API name ending in __mdt'
        );
      }

      const conn = await getSalesforceConnection();

      // const description = await conn.sobject(metadataType).describe();
      const cached = await getCachedDescribe(
        conn,
        metadataType
      );

      const description = cached.description;

      const fieldNames = description.fields
        .map((field) => field.name)
        .filter((name) => !name.includes('.'));

      const query = `
        SELECT ${fieldNames.join(', ')}
        FROM ${metadataType}
        LIMIT ${limit}
      `;

      const result = await conn.query(query);

      return jsonResult(result);
    }
  );

  server.registerTool(
    'salesforce_list_custom_settings',
    {
      description:
        'List Salesforce custom setting objects.',
      annotations: {
        readOnlyHint: true,
      },
    },
    async () => {
      const conn = await getSalesforceConnection();
      const global = await conn.describeGlobal();

      const candidates = [];

      /** for (const obj of global.sobjects.filter((o) => o.custom && o.queryable)) {
           try {
             const description = await conn.sobject(obj.name).describe(); **/
      for (
        const obj of global.sobjects.filter(
          (o) => o.custom && o.queryable
        )
) {
  try {
    const cached = await getCachedDescribe(
      conn,
      obj.name
    );

    const description = cached.description;

          if ((description as any).customSetting) {
            candidates.push({
              name: obj.name,
              label: obj.label,
              labelPlural: obj.labelPlural,
            });
          }
        } catch {
          // Ignore objects that cannot be described by this user.
        }
      }

      return jsonResult(candidates);
    }
  );

  server.registerTool(
    'salesforce_get_layouts',
    {
      description:
        'List page layouts for a Salesforce object using the Tooling API.',
      inputSchema: z.object({
        objectName: z.string().describe('Salesforce object API name'),
      }),
      annotations: {
        readOnlyHint: true,
      },
    },
    async ({ objectName }) => {
      const conn = await getSalesforceConnection();
      const safeObject = objectName.replace(/'/g, "\\'");

      const entityResult = await conn.tooling.query(`
        SELECT Id, QualifiedApiName
        FROM EntityDefinition
        WHERE QualifiedApiName = '${safeObject}'
        LIMIT 1
      `);

      if (entityResult.records.length === 0) {
        throw new Error(`Object not found: ${objectName}`);
      }

      const entityId = (entityResult.records[0] as any).Id;

      const result = await conn.tooling.query(`
        SELECT Id, Name, TableEnumOrId
        FROM Layout
        WHERE TableEnumOrId = '${entityId}'
        ORDER BY Name
      `);

      return jsonResult(result);
    }
  );

  server.registerTool(
    'salesforce_get_profiles',
    {
      description:
        'List Salesforce profiles.',
      inputSchema: z.object({
        nameContains: z.string().optional(),
      }),
      annotations: {
        readOnlyHint: true,
      },
    },
    async ({ nameContains }) => {
      const conn = await getSalesforceConnection();

      let query = `
        SELECT Id, Name, UserLicenseId
        FROM Profile
      `;

      if (nameContains) {
        const safeName = nameContains.replace(/'/g, "\\'");
        query += ` WHERE Name LIKE '%${safeName}%'`;
      }

      query += ' ORDER BY Name';

      return jsonResult(await conn.query(query));
    }
  );

  server.registerTool(
    'salesforce_get_permission_set_groups',
    {
      description:
        'List permission set groups and their statuses.',
      inputSchema: z.object({
        nameContains: z.string().optional(),
      }),
      annotations: {
        readOnlyHint: true,
      },
    },
    async ({ nameContains }) => {
      const conn = await getSalesforceConnection();

      let query = `
        SELECT Id,
               DeveloperName,
               MasterLabel,
               Status,
               Description
        FROM PermissionSetGroup
      `;

      if (nameContains) {
        const safeName = nameContains.replace(/'/g, "\\'");
        query += `
          WHERE DeveloperName LIKE '%${safeName}%'
          OR MasterLabel LIKE '%${safeName}%'
        `;
      }

      query += ' ORDER BY MasterLabel';

      return jsonResult(await conn.query(query));
    }
  );

  server.registerTool(
    'salesforce_find_user',
    {
      description:
        'Find Salesforce users by name, username, email, or user ID.',
      inputSchema: z.object({
        search: z.string().describe('Name, username, email, or Salesforce User ID'),
      }),
      annotations: {
        readOnlyHint: true,
      },
    },
    async ({ search }) => {
      const conn = await getSalesforceConnection();
      const safe = search.replace(/'/g, "\\'");

      const result = await conn.query(`
        SELECT Id,
               Name,
               Username,
               Email,
               IsActive,
               ProfileId,
               Profile.Name,
               UserRoleId,
               UserRole.Name
        FROM User
        WHERE Id = '${safe}'
           OR Name LIKE '%${safe}%'
           OR Username LIKE '%${safe}%'
           OR Email LIKE '%${safe}%'
        ORDER BY IsActive DESC, Name
        LIMIT 50
      `);

      return jsonResult(result);
    }
  );

  server.registerTool(
    'salesforce_get_dependencies',
    {
      description:
        'Inspect metadata dependencies using Salesforce MetadataComponentDependency.',
      inputSchema: z.object({
        componentName: z
          .string()
          .describe('Metadata component name to search for'),
      }),
      annotations: {
        readOnlyHint: true,
      },
    },
    async ({ componentName }) => {
      const conn = await getSalesforceConnection();

      const result = await queryDependenciesByName(
        conn,
        componentName,
        'contains'
      );

      return jsonResult(result);
    }
  );

  server.registerTool(
    'salesforce_create_record',
    {
      description:
        'Create one Salesforce data record. This performs a write operation.',
      inputSchema: z.object({
        objectName: z
          .string()
          .describe('Salesforce object API name'),
        fields: z
          .record(z.string(), z.any())
          .describe('Field API names and values for the new record'),
        confirm: z
          .literal(true)
          .describe('Must be true to explicitly confirm the write operation'),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
      },
    },
    async ({ objectName, fields, confirm }) => {
      if (confirm !== true) {
        throw new Error('Write operation was not explicitly confirmed.');
      }

      const conn = await getSalesforceConnection();
      // const description = await conn.sobject(objectName).describe();
      const cached = await getCachedDescribe(
        conn,
        objectName
      );

      const description = cached.description;

      if (!description.createable) {

        throw new Error(
          `Execution user does not have create access to ${objectName}`
        );
      }

      const result = await conn.sobject(objectName).create(fields);

      return jsonResult(result);
    }
  );

  server.registerTool(
    'salesforce_update_record',
    {
      description:
        'Update one Salesforce data record by ID. This performs a write operation.',
      inputSchema: z.object({
        objectName: z.string().describe('Salesforce object API name'),
        recordId: z.string().describe('Salesforce record ID'),
        fields: z
          .record(z.string(), z.any())
          .describe('Fields and values to update'),
        confirm: z
          .literal(true)
          .describe('Must be true to explicitly confirm the write operation'),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
      },
    },
    async ({ objectName, recordId, fields, confirm }) => {
      if (confirm !== true) {
        throw new Error('Write operation was not explicitly confirmed.');
      }

      if ('Id' in fields) {
        throw new Error(
          'Do not include Id inside fields. Use the recordId parameter.'
        );
      }

      const conn = await getSalesforceConnection();
      // const description = await conn.sobject(objectName).describe();
      const cached = await getCachedDescribe(
        conn,
        objectName
      );

     const description = cached.description;

      if (!description.updateable) {
        throw new Error(
          `Execution user does not have update access to ${objectName}`
        );
      }

      const result = await conn.sobject(objectName).update({
        Id: recordId,
        ...fields,
      });

      return jsonResult(result);
    }
  );
    server.registerTool(
    'salesforce_find_flow',
    {
      description:
        'Find Salesforce Flows by developer name or label and return active/latest version IDs.',
      inputSchema: z.object({
        search: z.string().describe('Flow developer name or label'),
      }),
      annotations: {
        readOnlyHint: true,
      },
    },
    async ({ search }) => {
      const conn = await getSalesforceConnection();
      const safe = escapeSoql(search);

      const result = await conn.tooling.query(`
        SELECT Id,
               DeveloperName,
               MasterLabel,
               ProcessType,
               ActiveVersionId,
               LatestVersionId
        FROM FlowDefinitionView
        WHERE DeveloperName LIKE '%${safe}%'
           OR MasterLabel LIKE '%${safe}%'
        ORDER BY DeveloperName
        LIMIT 100
      `);

      return jsonResult(result);
    }
  );

  server.registerTool(
    'salesforce_explain_flow',
    {
      description:
        'Retrieve and parse the active or latest version of a Salesforce Flow into its important logical components.',
      inputSchema: z.object({
        developerName: z
          .string()
          .describe('Flow DeveloperName, for example Lender_Decision_Screen'),
      }),
      annotations: {
        readOnlyHint: true,
      },
    },
    async ({ developerName }) => {
      const conn = await getSalesforceConnection();
      const safeName = escapeSoql(developerName);

      const definitions = await conn.tooling.query(`
        SELECT Id,
               DeveloperName,
               MasterLabel,
               ProcessType,
               ActiveVersionId,
               LatestVersionId
        FROM FlowDefinitionView
        WHERE DeveloperName = '${safeName}'
        LIMIT 1
      `);

      if (definitions.records.length === 0) {
        throw new Error(`Flow not found: ${developerName}`);
      }

      const definition: any = definitions.records[0];

      const versionId =
        definition.ActiveVersionId ?? definition.LatestVersionId;

      if (!versionId) {
        throw new Error(
          `Flow ${developerName} does not have an active or latest version.`
        );
      }

      const flows = await conn.tooling.query(`
        SELECT Id,
               DefinitionId,
               VersionNumber,
               Status,
               MasterLabel,
               ProcessType,
               ApiVersion,
               Description,
               Metadata
        FROM Flow
        WHERE Id = '${escapeSoql(versionId)}'
        LIMIT 1
      `);

      if (flows.records.length === 0) {
        throw new Error(`Flow version not found: ${versionId}`);
      }

      const flow: any = flows.records[0];

      return jsonResult({
        definition: {
          id: definition.Id,
          developerName: definition.DeveloperName,
          masterLabel: definition.MasterLabel,
          processType: definition.ProcessType,
          activeVersionId: definition.ActiveVersionId,
          latestVersionId: definition.LatestVersionId,
        },
        version: {
          id: flow.Id,
          versionNumber: flow.VersionNumber,
          status: flow.Status,
          apiVersion: flow.ApiVersion,
          description: flow.Description,
        },
        structure: summarizeFlowMetadata(flow.Metadata),
        rawMetadata: flow.Metadata,
      });
    }
  );

  server.registerTool(
    'salesforce_search_metadata',
    {
      description:
        'Search common Salesforce metadata such as Apex classes, Apex triggers, Flows, validation rules, layouts, and custom objects.',
      inputSchema: z.object({
        search: z.string(),
      }),
      annotations: {
        readOnlyHint: true,
      },
    },
    async ({ search }) => {
      const conn = await getSalesforceConnection();
      const safe = escapeSoql(search);

      const results: Record<string, unknown> = {};

      try {
        results.apexClasses = await conn.tooling.query(`
          SELECT Id, Name, ApiVersion, Status
          FROM ApexClass
          WHERE Name LIKE '%${safe}%'
          ORDER BY Name
          LIMIT 100
        `);
      } catch (error) {
        results.apexClassesError = normalizeSalesforceError(error);
      }

      try {
        results.apexTriggers = await conn.tooling.query(`
          SELECT Id, Name, TableEnumOrId, ApiVersion, Status
          FROM ApexTrigger
          WHERE Name LIKE '%${safe}%'
          ORDER BY Name
          LIMIT 100
        `);
      } catch (error) {
        results.apexTriggersError = normalizeSalesforceError(error);
      }

      try {
        results.flows = await conn.tooling.query(`
          SELECT Id,
                 DeveloperName,
                 MasterLabel,
                 ProcessType,
                 ActiveVersionId,
                 LatestVersionId
          FROM FlowDefinitionView
          WHERE DeveloperName LIKE '%${safe}%'
             OR MasterLabel LIKE '%${safe}%'
          ORDER BY DeveloperName
          LIMIT 100
        `);
      } catch (error) {
        results.flowsError = normalizeSalesforceError(error);
      }

      try {
        results.layouts = await conn.tooling.query(`
          SELECT Id, Name, TableEnumOrId
          FROM Layout
          WHERE Name LIKE '%${safe}%'
          ORDER BY Name
          LIMIT 100
        `);
      } catch (error) {
        results.layoutsError = normalizeSalesforceError(error);
      }

      return jsonResult(results);
    }
  );

  server.registerTool(
    'salesforce_search_apex',
    {
      description:
        'Search Apex class and trigger source code for a string such as a field API name, object name, method, or error text.',
      inputSchema: z.object({
        search: z.string(),
      }),
      annotations: {
        readOnlyHint: true,
      },
    },
    async ({ search }) => {
      const conn = await getSalesforceConnection();

      const classes = await conn.tooling.query(`
        SELECT Id, Name, Body
        FROM ApexClass
        ORDER BY Name
      `);

      const triggers = await conn.tooling.query(`
        SELECT Id, Name, Body, TableEnumOrId
        FROM ApexTrigger
        ORDER BY Name
      `);

      const needle = search.toLowerCase();

      const matchingClasses = (classes.records as any[])
        .filter((item) =>
          String(item.Body ?? '').toLowerCase().includes(needle)
        )
        .map((item) => ({
          id: item.Id,
          name: item.Name,
        }));

      const matchingTriggers = (triggers.records as any[])
        .filter((item) =>
          String(item.Body ?? '').toLowerCase().includes(needle)
        )
        .map((item) => ({
          id: item.Id,
          name: item.Name,
          object: item.TableEnumOrId,
        }));

      return jsonResult({
        search,
        classes: matchingClasses,
        triggers: matchingTriggers,
      });
    }
  );

  server.registerTool(
    'salesforce_find_field_references',
    {
      description:
        'Find Salesforce metadata components that depend on or reference a field using MetadataComponentDependency.',
      inputSchema: z.object({
        fieldName: z
          .string()
          .describe('Field API name, for example Federal_Tax_ID_No__c'),
        objectName: z
          .string()
          .optional()
          .describe(
            'Object API name that owns the field, for example Opportunity. Recommended: the same field name can exist on several objects.'
          ),
      }),
      annotations: {
        readOnlyHint: true,
      },
    },
    async ({ fieldName, objectName }) => {
      const conn = await getSalesforceConnection();

      // MetadataComponentDependency only accepts Id columns in WHERE
      // (filtering on the *Name columns fails with "... is unknown"), so
      // resolve the custom field Id first.
      const developerName = escapeSoql(fieldName.replace(/__c$/i, ''));
      const objectFilter = objectName
        ? ` AND EntityDefinition.QualifiedApiName = '${escapeSoql(objectName)}'`
        : '';

      const fields = await conn.tooling.query(`
        SELECT Id,
               DeveloperName,
               EntityDefinition.QualifiedApiName
        FROM CustomField
        WHERE DeveloperName = '${developerName}'${objectFilter}
      `);

      const fieldRecords = fields.records as any[];

      if (fieldRecords.length === 0) {
        return jsonResult({
          fieldName,
          objectName,
          error:
            'No custom field found. Standard fields cannot be looked up through MetadataComponentDependency here; check the spelling or pass objectName.',
        });
      }

      const ids = fieldRecords.map((record) => `'${record.Id}'`).join(', ');

      const result = await conn.tooling.query(`
        SELECT MetadataComponentId,
               MetadataComponentName,
               MetadataComponentType,
               RefMetadataComponentId,
               RefMetadataComponentName,
               RefMetadataComponentType
        FROM MetadataComponentDependency
        WHERE RefMetadataComponentId IN (${ids})
        LIMIT 2000
      `);

      return jsonResult({
        fields: fieldRecords.map((record) => ({
          id: record.Id,
          developerName: record.DeveloperName,
          object: record.EntityDefinition?.QualifiedApiName,
        })),
        references: result,
      });
    }
  );

  server.registerTool(
    'salesforce_explain_user_access',
    {
      description:
        'Explain how a Salesforce user receives access to an object, including profile, permission sets, permission set groups, and object permissions.',
      inputSchema: z.object({
        userId: z.string(),
        objectName: z.string(),
      }),
      annotations: {
        readOnlyHint: true,
      },
    },
    async ({ userId, objectName }) => {
      const conn = await getSalesforceConnection();

      const safeUser = escapeSoql(userId);
      const safeObject = escapeSoql(objectName);

      const userResult = await conn.query(`
        SELECT Id,
               Name,
               Username,
               ProfileId,
               Profile.Name
        FROM User
        WHERE Id = '${safeUser}'
        LIMIT 1
      `);

      if (userResult.records.length === 0) {
        throw new Error(`User not found: ${userId}`);
      }

      const assignments = await conn.query(`
        SELECT Id,
               PermissionSetId,
               PermissionSet.Name,
               PermissionSet.Label,
               PermissionSet.IsOwnedByProfile,
               PermissionSetGroupId,
               PermissionSetGroup.DeveloperName,
               PermissionSetGroup.MasterLabel
        FROM PermissionSetAssignment
        WHERE AssigneeId = '${safeUser}'
      `);

      const permissionSetIds = (assignments.records as any[])
        .map((assignment) => assignment.PermissionSetId)
        .filter(Boolean);

      const profileId = (userResult.records[0] as any).ProfileId;

      const profilePermissionSets = await conn.query(`
        SELECT Id, Name, Label, ProfileId
        FROM PermissionSet
        WHERE ProfileId = '${escapeSoql(profileId)}'
      `);

      const relevantParentIds = [
        ...permissionSetIds,
        ...(profilePermissionSets.records as any[]).map((ps) => ps.Id),
      ];

      let objectPermissions: unknown = {
        totalSize: 0,
        records: [],
      };

      if (relevantParentIds.length > 0) {
        const ids = relevantParentIds
          .map((id) => `'${escapeSoql(id)}'`)
          .join(',');

        objectPermissions = await conn.query(`
          SELECT Id,
                 ParentId,
                 Parent.Name,
                 Parent.Label,
                 Parent.IsOwnedByProfile,
                 SObjectType,
                 PermissionsRead,
                 PermissionsCreate,
                 PermissionsEdit,
                 PermissionsDelete,
                 PermissionsViewAllRecords,
                 PermissionsModifyAllRecords
          FROM ObjectPermissions
          WHERE SObjectType = '${safeObject}'
          AND ParentId IN (${ids})
        `);
      }

      return jsonResult({
        user: userResult.records[0],
        assignments: assignments.records,
        profilePermissionSets: profilePermissionSets.records,
        objectPermissions,
      });
    }
  );

  server.registerTool(
    'salesforce_get_async_jobs',
    {
      description:
        'Inspect recent Salesforce asynchronous Apex jobs and their status.',
      inputSchema: z.object({
        limit: z.number().int().min(1).max(200).default(50),
      }),
      annotations: {
        readOnlyHint: true,
      },
    },
    async ({ limit }) => {
      const conn = await getSalesforceConnection();

      const result = await conn.query(`
        SELECT Id,
               ApexClassId,
               ApexClass.Name,
               JobType,
               Status,
               JobItemsProcessed,
               TotalJobItems,
               NumberOfErrors,
               MethodName,
               ExtendedStatus,
               CreatedDate,
               CompletedDate
        FROM AsyncApexJob
        ORDER BY CreatedDate DESC
        LIMIT ${limit}
      `);

      return jsonResult(result);
    }
  );

  server.registerTool(
    'salesforce_get_apex_logs',
    {
      description:
        'List recent Apex debug logs available through the Salesforce Tooling API.',
      inputSchema: z.object({
        limit: z.number().int().min(1).max(100).default(20),
      }),
      annotations: {
        readOnlyHint: true,
      },
    },
    async ({ limit }) => {
      const conn = await getSalesforceConnection();

      const result = await conn.tooling.query(`
        SELECT Id,
               LogUserId,
               LogLength,
               Request,
               Operation,
               Status,
               StartTime,
               DurationMilliseconds
        FROM ApexLog
        ORDER BY StartTime DESC
        LIMIT ${limit}
      `);

      return jsonResult(result);
    }
  );

  server.registerTool(
    'salesforce_preview_update',
    {
      description:
        'Preview a bulk Salesforce update without modifying records. Runs a SELECT query and shows which records would receive the proposed field values.',
      inputSchema: z.object({
        query: z
          .string()
          .describe('SOQL SELECT query identifying records to update'),
        proposedFields: z
          .record(z.string(), z.any())
          .describe('Fields and values that would be applied'),
        previewLimit: z.number().int().min(1).max(500).default(100),
      }),
      annotations: {
        readOnlyHint: true,
      },
    },
    async ({ query, proposedFields, previewLimit }) => {
      const trimmed = query.trim();

      if (!/^SELECT\b/i.test(trimmed)) {
        throw new Error(
          'Preview requires a SELECT SOQL query. No write operations are accepted.'
        );
      }

      const conn = await getSalesforceConnection();
      const result = await conn.query(trimmed);

      const records = (result.records as any[]).slice(0, previewLimit);

      return jsonResult({
        totalMatched: result.totalSize,
        previewed: records.length,
        truncated: result.totalSize > records.length,
        proposedFields,
        records: records.map((record) => ({
          current: record,
          proposed: {
            Id: record.Id,
            ...proposedFields,
          },
        })),
        executed: false,
        message: 'Preview only. No Salesforce records were modified.',
      });
    }
  );
    server.registerTool(
    'salesforce_prepare_bulk_update',
    {
      description:
        'Prepare and preview a bulk Salesforce update without modifying records. Returns an operation token required for execution.',
      inputSchema: z.object({
        objectName: z
          .string()
          .describe('Salesforce object API name'),
        query: z
          .string()
          .describe('SOQL SELECT query identifying records to update'),
        proposedFields: z
          .record(z.string(), z.any())
          .describe('Fields and values to apply to each matched record'),
        previewLimit: z
          .number()
          .int()
          .min(1)
          .max(500)
          .default(100),
      }),
      annotations: {
        readOnlyHint: true,
      },
    },
    async ({ objectName, query, proposedFields, previewLimit }) => {
      const trimmed = query.trim();

      if (!/^SELECT\b/i.test(trimmed)) {
        throw new Error('Only SELECT queries can be used for bulk-update preparation.');
      }

      const conn = await getSalesforceConnection();
      // const description = await conn.sobject(objectName).describe();
      const cached = await getCachedDescribe(
        conn,
        objectName
      );

      const description = cached.description;

      if (!description.updateable) {
        throw new Error(`${objectName} is not updateable by the execution user.`);
      }

      const fieldMap = new Map(
        description.fields.map((field) => [field.name, field])
      );

      for (const fieldName of Object.keys(proposedFields)) {
        const field = fieldMap.get(fieldName);

        if (!field) {
          throw new Error(
            `Field ${fieldName} does not exist on ${objectName}.`
          );
        }

        if (!field.updateable) {
          throw new Error(
            `Field ${objectName}.${fieldName} is not updateable by the execution user.`
          );
        }
      }

      const result = await conn.query(trimmed);

      const recordIds = (result.records as any[])
        .map((record) => record.Id)
        .filter(Boolean);

      if (recordIds.length === 0) {
        return jsonResult({
          totalMatched: 0,
          message: 'No records matched. No operation was created.',
        });
      }

      const operationToken = createOperationToken();

      pendingBulkUpdates.set(operationToken, {
        objectName,
        recordIds,
        proposedFields,
        createdAt: Date.now(),
      });

      const preview = (result.records as any[])
        .slice(0, previewLimit)
        .map((record) => ({
          current: record,
          proposed: {
            Id: record.Id,
            ...proposedFields,
          },
        }));

      return jsonResult({
        operationToken,
        objectName,
        totalMatched: result.totalSize,
        previewed: preview.length,
        proposedFields,
        records: preview,
        executed: false,
        message:
          'Preview complete. No records were modified. Use salesforce_execute_bulk_update with this operationToken to execute.',
      });
    }
  );

server.registerTool(
  'salesforce_execute_bulk_update',
  {
    description:
      'Execute a previously prepared Salesforce bulk update using its operation token and save rollback data to the audit log.',
    inputSchema: z.object({
      operationToken: z.string(),
      confirm: z.literal(true),
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
    },
  },
  async ({ operationToken, confirm }) => {
    if (confirm !== true) {
      throw new Error('Bulk update was not explicitly confirmed.');
    }

    const operation = pendingBulkUpdates.get(operationToken);

    if (!operation) {
      throw new Error(
        'Operation token is invalid, expired, or belongs to a previous MCP process.'
      );
    }

    const ageMs = Date.now() - operation.createdAt;

    if (ageMs > 15 * 60 * 1000) {
      pendingBulkUpdates.delete(operationToken);
      throw new Error('Operation token expired.');
    }

    const conn = await getSalesforceConnection();

    const fieldsToCapture = [
      'Id',
      ...Object.keys(operation.proposedFields),
    ];

    const idList = operation.recordIds
      .map((id) => `'${escapeSoql(id)}'`)
      .join(',');

    const beforeResult = await conn.query(`
      SELECT ${fieldsToCapture.join(', ')}
      FROM ${operation.objectName}
      WHERE Id IN (${idList})
    `);

    const beforeRecords = beforeResult.records as any[];

    const recordsToUpdate = operation.recordIds.map((recordId) => ({
      Id: recordId,
      ...operation.proposedFields,
    }));

    const results = await conn
      .sobject(operation.objectName)
      .update(recordsToUpdate);

    const normalizedResults = Array.isArray(results)
      ? results
      : [results];

    const successes = normalizedResults.filter(
      (result: any) => result.success
    );

    const failures = normalizedResults.filter(
      (result: any) => !result.success
    );

    const auditId = crypto.randomUUID();

    await appendAuditLog({
      auditId,
      timestamp: new Date().toISOString(),
      objectName: operation.objectName,
      proposedFields: operation.proposedFields,
      beforeRecords,
      attempted: recordsToUpdate.length,
      succeeded: successes.length,
      failed: failures.length,
      results: normalizedResults,
    });

    pendingBulkUpdates.delete(operationToken);

    return jsonResult({
      auditId,
      objectName: operation.objectName,
      attempted: recordsToUpdate.length,
      succeeded: successes.length,
      failed: failures.length,
      rollbackAvailable: successes.length > 0,
      message:
        'Bulk update executed and original values were saved for rollback.',
    });
  }
);

server.registerTool(
  'salesforce_rollback_bulk_update',
  {
    description:
      'Rollback a previously executed bulk update using its audit ID.',
    inputSchema: z.object({
      auditId: z.string(),
      confirm: z.literal(true),
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
    },
  },
  async ({ auditId, confirm }) => {
    if (confirm !== true) {
      throw new Error('Rollback was not explicitly confirmed.');
    }

    const contents = await fs.readFile(auditLogPath, 'utf8');

    const entries = contents
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));

    const audit = entries.find(
      (entry) => entry.auditId === auditId
    );

    if (!audit) {
      throw new Error(`Audit record not found: ${auditId}`);
    }

    const conn = await getSalesforceConnection();

    const rollbackRecords = audit.beforeRecords.map(
      (record: Record<string, unknown>) => {
        const clean: Record<string, unknown> = {
          Id: record.Id,
        };

        for (const fieldName of Object.keys(audit.proposedFields)) {
          clean[fieldName] = record[fieldName];
        }

        return clean;
      }
    );

    const results = await conn
      .sobject(audit.objectName)
      .update(rollbackRecords);

    return jsonResult({
      auditId,
      objectName: audit.objectName,
      recordsAttempted: rollbackRecords.length,
      results,
      rolledBack: true,
    });
  }
);


/* ############################################################## */
/*              HIGHER - LEVEL REASONING TOOLS                    */
/* ############################################################## */


////////////////////////////////////////
//    Salesforce Explain Object       //
////////////////////////////////////////

  server.registerTool(
    'salesforce_explain_object',
    {
      description:
        'Build a comprehensive technical overview of a Salesforce object, including fields, relationships, record types, validation rules, layouts, triggers, flows, and object permissions.',
      inputSchema: z.object({
        objectName: z
          .string()
          .describe(
            'Salesforce object API name, such as Opportunity or Contract_Details__c'
          ),
      }),
      annotations: {
        readOnlyHint: true,
      },
    },
    async ({ objectName }) => {
      const conn = await getSalesforceConnection();
      const safeObject = escapeSoql(objectName);

      const output: Record<string, unknown> = {
        objectName,
      };

      // ------------------------------------------------------------
      // 1. OBJECT + FIELD DESCRIPTION
      // ------------------------------------------------------------

      try {
        // const description = await conn.sobject(objectName).describe();
        const cached = await getCachedDescribe(conn, objectName );

        const description = cached.description;

        output.schemaCacheSource = cached.source;

        output.object = {
          name: description.name,
          label: description.label,
          labelPlural: description.labelPlural,
          custom: description.custom,
          createable: description.createable,
          updateable: description.updateable,
          deletable: description.deletable,
          queryable: description.queryable,
          searchable: description.searchable,
          recordTypeInfos: description.recordTypeInfos,
        };

        output.fields = description.fields.map((field) => ({
          name: field.name,
          label: field.label,
          type: field.type,
          custom: field.custom,
          length: field.length,
          precision: field.precision,
          scale: field.scale,
          required: !field.nillable && !field.defaultedOnCreate,
          nillable: field.nillable,
          createable: field.createable,
          updateable: field.updateable,
          calculated: field.calculated,
          calculatedFormula: field.calculatedFormula,
          referenceTo: field.referenceTo,
          relationshipName: field.relationshipName,
          unique: field.unique,
          externalId: field.externalId,
        }));

        output.childRelationships = description.childRelationships.map(
          (relationship) => ({
            childObject: relationship.childSObject,
            field: relationship.field,
            relationshipName: relationship.relationshipName,
            cascadeDelete: relationship.cascadeDelete,
            restrictedDelete: relationship.restrictedDelete,
          })
        );
      } catch (error) {
        output.describeError = normalizeSalesforceError(error);
      }

      // ------------------------------------------------------------
      // 2. RECORD TYPES
      // ------------------------------------------------------------

      try {
        output.recordTypes = await conn.query(`
          SELECT Id,
                 Name,
                 DeveloperName,
                 SobjectType,
                 IsActive,
                 BusinessProcessId
          FROM RecordType
          WHERE SobjectType = '${safeObject}'
          ORDER BY Name
        `);
      } catch (error) {
        output.recordTypesError = normalizeSalesforceError(error);
      }

      // ------------------------------------------------------------
      // 3. ENTITY DEFINITION
      // ------------------------------------------------------------

      let entityDefinitionId: string | null = null;

      try {
        const entityResult = await conn.tooling.query(`
          SELECT Id,
                 QualifiedApiName,
                 Label,
                 PluralLabel,
                 IsCustomizable
          FROM EntityDefinition
          WHERE QualifiedApiName = '${safeObject}'
          LIMIT 1
        `);

        if (entityResult.records.length > 0) {
          const entity: any = entityResult.records[0];
          entityDefinitionId = entity.Id;
          output.entityDefinition = entity;
        }
      } catch (error) {
        output.entityDefinitionError = normalizeSalesforceError(error);
      }

      // ------------------------------------------------------------
      // 4. VALIDATION RULES
      // ------------------------------------------------------------

      if (entityDefinitionId) {
        try {
          output.validationRules = await conn.tooling.query(`
            SELECT Id,
                   ValidationName,
                   Active,
                   Description,
                   ErrorMessage,
                   ErrorDisplayField
            FROM ValidationRule
            WHERE EntityDefinitionId = '${escapeSoql(entityDefinitionId)}'
            ORDER BY ValidationName
          `);
        } catch (error) {
          output.validationRulesError = normalizeSalesforceError(error);
        }
      }

      // ------------------------------------------------------------
      // 5. PAGE LAYOUTS
      // ------------------------------------------------------------

      if (entityDefinitionId) {
        try {
          output.layouts = await conn.tooling.query(`
            SELECT Id,
                   Name,
                   TableEnumOrId
            FROM Layout
            WHERE TableEnumOrId = '${escapeSoql(entityDefinitionId)}'
            ORDER BY Name
          `);
        } catch (error) {
          output.layoutsError = normalizeSalesforceError(error);
        }
      }

      // ------------------------------------------------------------
      // 6. APEX TRIGGERS
      // ------------------------------------------------------------

      try {
        output.apexTriggers = await conn.tooling.query(`
          SELECT Id,
                 Name,
                 TableEnumOrId,
                 ApiVersion,
                 Status,
                 UsageBeforeInsert,
                 UsageAfterInsert,
                 UsageBeforeUpdate,
                 UsageAfterUpdate,
                 UsageBeforeDelete,
                 UsageAfterDelete,
                 UsageAfterUndelete
          FROM ApexTrigger
          WHERE TableEnumOrId = '${safeObject}'
          ORDER BY Name
        `);
      } catch (error) {
        output.apexTriggersError = normalizeSalesforceError(error);
      }

      // ------------------------------------------------------------
      // 7. FLOWS THAT REFERENCE THE OBJECT
      //
      // MetadataComponentDependency is more useful here than simply
      // looking for flows whose trigger object matches the object.
      // ------------------------------------------------------------

      try {
        output.dependencies = await queryDependenciesByName(
          conn,
          objectName,
          'exact'
        );
      } catch (error) {
        output.dependenciesError = normalizeSalesforceError(error);
      }

      // ------------------------------------------------------------
      // 8. OBJECT PERMISSIONS
      // ------------------------------------------------------------

      try {
        output.objectPermissions = await conn.query(`
          SELECT Id,
                 ParentId,
                 Parent.Name,
                 Parent.Label,
                 Parent.IsOwnedByProfile,
                 PermissionsRead,
                 PermissionsCreate,
                 PermissionsEdit,
                 PermissionsDelete,
                 PermissionsViewAllRecords,
                 PermissionsModifyAllRecords
          FROM ObjectPermissions
          WHERE SObjectType = '${safeObject}'
          ORDER BY Parent.Label
        `);
      } catch (error) {
        output.objectPermissionsError = normalizeSalesforceError(error);
      }

      // ------------------------------------------------------------
      // 9. SUMMARY COUNTS
      // ------------------------------------------------------------

      const fields = Array.isArray(output.fields)
        ? (output.fields as any[])
        : [];

      const dependencies: any = output.dependencies;

      output.summary = {
        totalFields: fields.length,
        customFields: fields.filter((field) => field.custom).length,
        calculatedFields: fields.filter((field) => field.calculated).length,
        lookupOrRelationshipFields: fields.filter(
          (field) =>
            Array.isArray(field.referenceTo) &&
            field.referenceTo.length > 0
        ).length,

        dependenciesFound:
          dependencies &&
          typeof dependencies.totalSize === 'number'
            ? dependencies.totalSize
            : null,
      };

      return jsonResult(output);
    }
  );

  

////////////////////////////////////////////////
//    Salesforce Explain Record Access       //
//////////////////////////////////////////////

/* ********************************************************************************************* */
/*   Combines Salesforce's UserRecordAccess with the user's profile, permission sets,           */
/*   permission-set groups, object permissions,record ownership, and share-table information.  */
/* ****************************************************************************************** */ 

  server.registerTool(
    'salesforce_explain_record_access',
    {
      description:
        'Explain a Salesforce user\'s access to a specific record, including effective record access, ownership, profile, permission sets, permission set groups, object permissions, and explicit sharing where available.',
      inputSchema: z.object({
        userId: z
          .string()
          .describe('Salesforce User ID'),
        objectName: z
          .string()
          .describe('Salesforce object API name such as Opportunity'),
        recordId: z
          .string()
          .describe('Salesforce record ID'),
      }),
      annotations: {
        readOnlyHint: true,
      },
    },
    async ({ userId, objectName, recordId }) => {
      const conn = await getSalesforceConnection();

      const safeUser = escapeSoql(userId);
      const safeObject = escapeSoql(objectName);
      const safeRecord = escapeSoql(recordId);

      const output: Record<string, unknown> = {
        userId,
        objectName,
        recordId,
      };

      // ------------------------------------------------------------
      // 1. USER + PROFILE
      // ------------------------------------------------------------

      let profileId: string | null = null;

      try {
        const result = await conn.query(`
          SELECT Id,
                 Name,
                 Username,
                 IsActive,
                 ProfileId,
                 Profile.Name,
                 UserRoleId,
                 UserRole.Name
          FROM User
          WHERE Id = '${safeUser}'
          LIMIT 1
        `);

        if (result.records.length === 0) {
          throw new Error(`User not found: ${userId}`);
        }

        const user: any = result.records[0];
        profileId = user.ProfileId;

        output.user = user;
      } catch (error) {
        output.userError = normalizeSalesforceError(error);
      }

      // ------------------------------------------------------------
      // 2. EFFECTIVE RECORD ACCESS
      // Salesforce calculates the final answer for this user/record.
      // ------------------------------------------------------------

      try {
        output.effectiveRecordAccess = await conn.query(`
          SELECT RecordId,
                 HasReadAccess,
                 HasEditAccess,
                 HasDeleteAccess,
                 HasTransferAccess,
                 HasAllAccess
          FROM UserRecordAccess
          WHERE UserId = '${safeUser}'
          AND RecordId = '${safeRecord}'
        `);
      } catch (error) {
        output.effectiveRecordAccessError =
          normalizeSalesforceError(error);
      }

      // ------------------------------------------------------------
      // 3. RECORD + OWNER
      // ------------------------------------------------------------

      try {
        // const description = await conn.sobject(objectName).describe();
      const cached = await getCachedDescribe(
        conn,
        objectName
      );

      const description = cached.description;
        
        const fieldNames = new Set(
          description.fields.map((field) => field.name)
        );

        const selectFields = ['Id'];

        if (fieldNames.has('Name')) {
          selectFields.push('Name');
        }

        if (fieldNames.has('OwnerId')) {
          selectFields.push('OwnerId', 'Owner.Name');
        }

        if (fieldNames.has('RecordTypeId')) {
          selectFields.push(
            'RecordTypeId',
            'RecordType.Name',
            'RecordType.DeveloperName'
          );
        }

        const recordResult = await conn.query(`
          SELECT ${selectFields.join(', ')}
          FROM ${objectName}
          WHERE Id = '${safeRecord}'
          LIMIT 1
        `);

        if (recordResult.records.length === 0) {
          throw new Error(
            `Record ${recordId} not found on ${objectName}`
          );
        }

        output.record = recordResult.records[0];
      } catch (error) {
        output.recordError = normalizeSalesforceError(error);
      }

      // ------------------------------------------------------------
      // 4. USER'S PERMISSION SET ASSIGNMENTS
      // ------------------------------------------------------------

      let assignedPermissionSetIds: string[] = [];

      try {
        const assignments = await conn.query(`
          SELECT Id,
                 PermissionSetId,
                 PermissionSet.Name,
                 PermissionSet.Label,
                 PermissionSet.IsOwnedByProfile,
                 PermissionSetGroupId,
                 PermissionSetGroup.DeveloperName,
                 PermissionSetGroup.MasterLabel
          FROM PermissionSetAssignment
          WHERE AssigneeId = '${safeUser}'
        `);

        output.permissionAssignments = assignments;

        assignedPermissionSetIds = (assignments.records as any[])
          .map((record) => record.PermissionSetId)
          .filter(Boolean);
      } catch (error) {
        output.permissionAssignmentsError =
          normalizeSalesforceError(error);
      }

      // ------------------------------------------------------------
      // 5. PROFILE'S UNDERLYING PERMISSION SET
      // ------------------------------------------------------------

      let profilePermissionSetIds: string[] = [];

      if (profileId) {
        try {
          const profilePermissionSets = await conn.query(`
            SELECT Id,
                   Name,
                   Label,
                   ProfileId
            FROM PermissionSet
            WHERE ProfileId = '${escapeSoql(profileId)}'
          `);

          output.profilePermissionSet = profilePermissionSets;

          profilePermissionSetIds =
            (profilePermissionSets.records as any[]).map(
              (record) => record.Id
            );
        } catch (error) {
          output.profilePermissionSetError =
            normalizeSalesforceError(error);
        }
      }

      // ------------------------------------------------------------
      // 6. EFFECTIVE OBJECT PERMISSION SOURCES
      // ------------------------------------------------------------

      const permissionParents = [
        ...new Set([
          ...assignedPermissionSetIds,
          ...profilePermissionSetIds,
        ]),
      ];

      if (permissionParents.length > 0) {
        try {
          const ids = permissionParents
            .map((id) => `'${escapeSoql(id)}'`)
            .join(',');

          output.objectPermissionSources = await conn.query(`
            SELECT Id,
                   ParentId,
                   Parent.Name,
                   Parent.Label,
                   Parent.IsOwnedByProfile,
                   SObjectType,
                   PermissionsRead,
                   PermissionsCreate,
                   PermissionsEdit,
                   PermissionsDelete,
                   PermissionsViewAllRecords,
                   PermissionsModifyAllRecords
            FROM ObjectPermissions
            WHERE SObjectType = '${safeObject}'
            AND ParentId IN (${ids})
            ORDER BY Parent.Label
          `);
        } catch (error) {
          output.objectPermissionSourcesError =
            normalizeSalesforceError(error);
        }
      }

      // ------------------------------------------------------------
      // 7. SHARING MODEL
      // ------------------------------------------------------------

      try {
        const sharing = await conn.tooling.query(`
          SELECT QualifiedApiName,
                 InternalSharingModel,
                 ExternalSharingModel
          FROM EntityDefinition
          WHERE QualifiedApiName = '${safeObject}'
          LIMIT 1
        `);

        output.sharingModel = sharing;
      } catch (error) {
        output.sharingModelError =
          normalizeSalesforceError(error);
      }

      // ------------------------------------------------------------
      // 8. SHARE TABLE
      //
      // Standard objects commonly use ObjectShare.
      // Custom objects commonly use Object__Share.
      // Some objects do not expose a share table.
      // ------------------------------------------------------------

      try {
        const shareObject =
          objectName.endsWith('__c')
            ? objectName.replace(/__c$/, '__Share')
            : `${objectName}Share`;

        const shareDescription =
          await conn.sobject(shareObject).describe();

        const shareFields = new Set(
          shareDescription.fields.map((field) => field.name)
        );

        const parentField =
          shareFields.has('ParentId')
            ? 'ParentId'
            : shareFields.has(`${objectName}Id`)
              ? `${objectName}Id`
              : null;

        if (parentField) {
          output.shareRecords = await conn.query(`
            SELECT Id,
                   ${parentField},
                   UserOrGroupId,
                   RowCause
            FROM ${shareObject}
            WHERE ${parentField} = '${safeRecord}'
          `);

          output.shareObject = shareObject;
        } else {
          output.shareTableNote =
            `Share object ${shareObject} exists, but its parent field could not be determined automatically.`;
        }
      } catch (error) {
        output.shareTableNote =
          `No directly queryable share table was found or accessible for ${objectName}.`;

        output.shareTableError =
          normalizeSalesforceError(error);
      }

      // ------------------------------------------------------------
      // 9. ACCESS SUMMARY
      // ------------------------------------------------------------

      const accessResult: any =
        (output.effectiveRecordAccess as any)?.records?.[0];

      const permissionRecords: any[] =
        (output.objectPermissionSources as any)?.records ?? [];

      const grantsViewAll = permissionRecords.filter(
        (permission) => permission.PermissionsViewAllRecords
      );

      const grantsModifyAll = permissionRecords.filter(
        (permission) => permission.PermissionsModifyAllRecords
      );

      output.accessSummary = {
        hasReadAccess:
          accessResult?.HasReadAccess ?? null,

        hasEditAccess:
          accessResult?.HasEditAccess ?? null,

        hasDeleteAccess:
          accessResult?.HasDeleteAccess ?? null,

        hasTransferAccess:
          accessResult?.HasTransferAccess ?? null,

        hasAllAccess:
          accessResult?.HasAllAccess ?? null,

        viewAllSources: grantsViewAll.map((permission) => ({
          name: permission.Parent?.Name,
          label: permission.Parent?.Label,
          profile: permission.Parent?.IsOwnedByProfile,
        })),

        modifyAllSources: grantsModifyAll.map((permission) => ({
          name: permission.Parent?.Name,
          label: permission.Parent?.Label,
          profile: permission.Parent?.IsOwnedByProfile,
        })),
      };

      return jsonResult(output);
    }
  );


////////////////////////////////////////
//    Salesforce Compare Users       //
//////////////////////////////////////

    server.registerTool(
    'salesforce_compare_users',
    {
      description:
        'Compare two Salesforce users across profile, role, license, permission sets, permission set groups, and optionally object-level permissions.',
      inputSchema: z.object({
        userIdA: z.string().describe('First Salesforce User ID'),
        userIdB: z.string().describe('Second Salesforce User ID'),
        objectName: z
          .string()
          .optional()
          .describe(
            'Optional Salesforce object API name to compare object permissions'
          ),
      }),
      annotations: {
        readOnlyHint: true,
      },
    },
    async ({ userIdA, userIdB, objectName }) => {
      const conn = await getSalesforceConnection();

      const safeUserA = escapeSoql(userIdA);
      const safeUserB = escapeSoql(userIdB);

      async function getUserDetails(userId: string) {
        const userResult = await conn.query(`
          SELECT Id,
                 Name,
                 Username,
                 Email,
                 IsActive,
                 UserType,
                 ProfileId,
                 Profile.Name,
                 UserRoleId,
                 UserRole.Name,
                 UserPermissionsMarketingUser,
                 UserPermissionsOfflineUser
          FROM User
          WHERE Id = '${userId}'
          LIMIT 1
        `);

        if (userResult.records.length === 0) {
          throw new Error(`User not found: ${userId}`);
        }

        const user: any = userResult.records[0];

        const assignments = await conn.query(`
          SELECT Id,
                 PermissionSetId,
                 PermissionSet.Name,
                 PermissionSet.Label,
                 PermissionSet.IsOwnedByProfile,
                 PermissionSetGroupId,
                 PermissionSetGroup.DeveloperName,
                 PermissionSetGroup.MasterLabel
          FROM PermissionSetAssignment
          WHERE AssigneeId = '${userId}'
        `);

        const directPermissionSets = (assignments.records as any[])
          .filter(
            (record) =>
              record.PermissionSetId &&
              !record.PermissionSet?.IsOwnedByProfile
          )
          .map((record) => ({
            id: record.PermissionSetId,
            name: record.PermissionSet?.Name,
            label: record.PermissionSet?.Label,
          }));

        const permissionSetGroups = (assignments.records as any[])
          .filter((record) => record.PermissionSetGroupId)
          .map((record) => ({
            id: record.PermissionSetGroupId,
            developerName: record.PermissionSetGroup?.DeveloperName,
            label: record.PermissionSetGroup?.MasterLabel,
          }));

        let objectPermissions: unknown = null;

        if (objectName) {
          const safeObject = escapeSoql(objectName);

          const profilePermissionSetResult = await conn.query(`
            SELECT Id,
                   Name,
                   Label,
                   ProfileId
            FROM PermissionSet
            WHERE ProfileId = '${escapeSoql(user.ProfileId)}'
          `);

          const parentIds = [
            ...directPermissionSets.map((ps) => ps.id),
            ...(profilePermissionSetResult.records as any[]).map(
              (ps) => ps.Id
            ),
          ];

          if (parentIds.length > 0) {
            const ids = [
              ...new Set(parentIds),
            ]
              .map((id) => `'${escapeSoql(id)}'`)
              .join(',');

            objectPermissions = await conn.query(`
              SELECT Id,
                     ParentId,
                     Parent.Name,
                     Parent.Label,
                     Parent.IsOwnedByProfile,
                     SObjectType,
                     PermissionsRead,
                     PermissionsCreate,
                     PermissionsEdit,
                     PermissionsDelete,
                     PermissionsViewAllRecords,
                     PermissionsModifyAllRecords
              FROM ObjectPermissions
              WHERE SObjectType = '${safeObject}'
              AND ParentId IN (${ids})
              ORDER BY Parent.Label
            `);
          }
        }

        return {
          user,
          directPermissionSets,
          permissionSetGroups,
          objectPermissions,
        };
      }

      const [userA, userB] = await Promise.all([
        getUserDetails(safeUserA),
        getUserDetails(safeUserB),
      ]);

      function byKey(
        items: any[],
        keyFn: (item: any) => string | undefined
      ) {
        const map = new Map<string, any>();

        for (const item of items) {
          const key = keyFn(item);

          if (key) {
            map.set(key, item);
          }
        }

        return map;
      }

      const permissionSetsA = byKey(
        userA.directPermissionSets,
        (item) => item.name
      );

      const permissionSetsB = byKey(
        userB.directPermissionSets,
        (item) => item.name
      );

      const groupsA = byKey(
        userA.permissionSetGroups,
        (item) => item.developerName
      );

      const groupsB = byKey(
        userB.permissionSetGroups,
        (item) => item.developerName
      );

      const permissionSetOnlyA = [
        ...permissionSetsA.keys(),
      ]
        .filter((name) => !permissionSetsB.has(name))
        .map((name) => permissionSetsA.get(name));

      const permissionSetOnlyB = [
        ...permissionSetsB.keys(),
      ]
        .filter((name) => !permissionSetsA.has(name))
        .map((name) => permissionSetsB.get(name));

      const sharedPermissionSets = [
        ...permissionSetsA.keys(),
      ]
        .filter((name) => permissionSetsB.has(name))
        .map((name) => permissionSetsA.get(name));

      const groupOnlyA = [...groupsA.keys()]
        .filter((name) => !groupsB.has(name))
        .map((name) => groupsA.get(name));

      const groupOnlyB = [...groupsB.keys()]
        .filter((name) => !groupsA.has(name))
        .map((name) => groupsB.get(name));

      const sharedGroups = [...groupsA.keys()]
        .filter((name) => groupsB.has(name))
        .map((name) => groupsA.get(name));

      return jsonResult({
        userA: userA.user,
        userB: userB.user,

        profileComparison: {
          sameProfile:
            userA.user.ProfileId === userB.user.ProfileId,
          userAProfile: {
            id: userA.user.ProfileId,
            name: userA.user.Profile?.Name,
          },
          userBProfile: {
            id: userB.user.ProfileId,
            name: userB.user.Profile?.Name,
          },
        },

        roleComparison: {
          sameRole:
            userA.user.UserRoleId === userB.user.UserRoleId,
          userARole: {
            id: userA.user.UserRoleId,
            name: userA.user.UserRole?.Name,
          },
          userBRole: {
            id: userB.user.UserRoleId,
            name: userB.user.UserRole?.Name,
          },
        },

        permissionSetComparison: {
          shared: sharedPermissionSets,
          onlyUserA: permissionSetOnlyA,
          onlyUserB: permissionSetOnlyB,
        },

        permissionSetGroupComparison: {
          shared: sharedGroups,
          onlyUserA: groupOnlyA,
          onlyUserB: groupOnlyB,
        },

        objectName: objectName ?? null,

        objectPermissions: objectName
          ? {
              userA: userA.objectPermissions,
              userB: userB.objectPermissions,
            }
          : null,
      });
    }
  );


///////////////////////////////////////////////
//    Salesforce Find Every Reference       //
/////////////////////////////////////////////

  server.registerTool(
    'salesforce_find_every_reference',
    {
      description:
        'Search broadly across Salesforce metadata for references to an API name, field, object, class, flow, or other component.',
      inputSchema: z.object({
        search: z
          .string()
          .describe(
            'API name or text to search for, such as Second_Signer__c, Opportunity, or LeadTriggerHandler'
          ),
      }),
      annotations: {
        readOnlyHint: true,
      },
    },
    async ({ search }) => {
      const conn = await getSalesforceConnection();

      const safe = escapeSoql(search);
      const needle = search.toLowerCase();

      const output: Record<string, unknown> = {
        search,
      };

      // ------------------------------------------------------------
      // 1. METADATA DEPENDENCY GRAPH
      // ------------------------------------------------------------

      try {
        output.metadataDependencies = await queryDependenciesByName(
          conn,
          search,
          'contains'
        );
      } catch (error) {
        output.metadataDependenciesError =
          normalizeSalesforceError(error);
      }

      // ------------------------------------------------------------
      // 2. APEX CLASSES
      // ------------------------------------------------------------

      try {
        const result = await conn.tooling.query(`
          SELECT Id,
                 Name,
                 Body,
                 ApiVersion,
                 Status
          FROM ApexClass
          ORDER BY Name
        `);

        output.apexClasses = (result.records as any[])
          .filter((record) =>
            String(record.Body ?? '')
              .toLowerCase()
              .includes(needle)
          )
          .map((record) => ({
            id: record.Id,
            name: record.Name,
            apiVersion: record.ApiVersion,
            status: record.Status,
          }));
      } catch (error) {
        output.apexClassesError =
          normalizeSalesforceError(error);
      }

      // ------------------------------------------------------------
      // 3. APEX TRIGGERS
      // ------------------------------------------------------------

      try {
        const result = await conn.tooling.query(`
          SELECT Id,
                 Name,
                 Body,
                 TableEnumOrId,
                 ApiVersion,
                 Status
          FROM ApexTrigger
          ORDER BY Name
        `);

        output.apexTriggers = (result.records as any[])
          .filter((record) =>
            String(record.Body ?? '')
              .toLowerCase()
              .includes(needle)
          )
          .map((record) => ({
            id: record.Id,
            name: record.Name,
            object: record.TableEnumOrId,
            apiVersion: record.ApiVersion,
            status: record.Status,
          }));
      } catch (error) {
        output.apexTriggersError =
          normalizeSalesforceError(error);
      }

      // ------------------------------------------------------------
      // 4. FLOWS
      //
      // We search both flow names and serialized metadata.
      // ------------------------------------------------------------

      try {
        const definitions = await conn.tooling.query(`
          SELECT Id,
                 DeveloperName,
                 MasterLabel,
                 ActiveVersionId,
                 LatestVersionId,
                 ProcessType
          FROM FlowDefinitionView
          ORDER BY DeveloperName
        `);

        const matchingFlows: any[] = [];

        for (const definition of definitions.records as any[]) {
          const nameMatch =
            String(definition.DeveloperName ?? '')
              .toLowerCase()
              .includes(needle) ||
            String(definition.MasterLabel ?? '')
              .toLowerCase()
              .includes(needle);

          const versionId =
            definition.ActiveVersionId ??
            definition.LatestVersionId;

          let metadataMatch = false;

          if (versionId) {
            try {
              const flowResult = await conn.tooling.query(`
                SELECT Id,
                       VersionNumber,
                       Status,
                       Metadata
                FROM Flow
                WHERE Id = '${escapeSoql(versionId)}'
                LIMIT 1
              `);

              const flow: any = flowResult.records[0];

              if (flow?.Metadata) {
                metadataMatch = JSON.stringify(flow.Metadata)
                  .toLowerCase()
                  .includes(needle);
              }
            } catch {
              // Ignore individual Flow retrieval failures.
            }
          }

          if (nameMatch || metadataMatch) {
            matchingFlows.push({
              id: definition.Id,
              developerName: definition.DeveloperName,
              masterLabel: definition.MasterLabel,
              processType: definition.ProcessType,
              activeVersionId: definition.ActiveVersionId,
              latestVersionId: definition.LatestVersionId,
              nameMatch,
              metadataMatch,
            });
          }
        }

        output.flows = matchingFlows;
      } catch (error) {
        output.flowsError =
          normalizeSalesforceError(error);
      }

      // ------------------------------------------------------------
      // 5. VALIDATION RULES
      // ------------------------------------------------------------

      try {
        const result = await conn.tooling.query(`
          SELECT Id,
                 ValidationName,
                 Active,
                 Description,
                 ErrorMessage,
                 EntityDefinitionId,
                 Metadata
          FROM ValidationRule
        `);

        output.validationRules = (result.records as any[])
          .filter((record) =>
            JSON.stringify(record)
              .toLowerCase()
              .includes(needle)
          )
          .map((record) => ({
            id: record.Id,
            name: record.ValidationName,
            active: record.Active,
            description: record.Description,
            errorMessage: record.ErrorMessage,
            entityDefinitionId:
              record.EntityDefinitionId,
          }));
      } catch (error) {
        output.validationRulesError =
          normalizeSalesforceError(error);
      }

      // ------------------------------------------------------------
      // 6. CUSTOM FIELD DEFINITIONS / FORMULAS
      // ------------------------------------------------------------

      try {
        const result = await conn.tooling.query(`
          SELECT Id,
                 DeveloperName,
                 TableEnumOrId,
                 DataType,
                 Metadata
          FROM CustomField
        `);

        output.customFields = (result.records as any[])
          .filter((record) =>
            JSON.stringify(record)
              .toLowerCase()
              .includes(needle)
          )
          .map((record) => ({
            id: record.Id,
            developerName: record.DeveloperName,
            object: record.TableEnumOrId,
            dataType: record.DataType,
          }));
      } catch (error) {
        output.customFieldsError =
          normalizeSalesforceError(error);
      }

      // ------------------------------------------------------------
      // 7. LAYOUTS
      // ------------------------------------------------------------

      try {
        const result = await conn.tooling.query(`
          SELECT Id,
                 Name,
                 TableEnumOrId,
                 Metadata
          FROM Layout
        `);

        output.layouts = (result.records as any[])
          .filter((record) =>
            JSON.stringify(record)
              .toLowerCase()
              .includes(needle)
          )
          .map((record) => ({
            id: record.Id,
            name: record.Name,
            object: record.TableEnumOrId,
          }));
      } catch (error) {
        output.layoutsError =
          normalizeSalesforceError(error);
      }

      // ------------------------------------------------------------
      // 8. CUSTOM METADATA TYPES
      // ------------------------------------------------------------

      try {
        const global = await conn.describeGlobal();

        const matchingTypes = global.sobjects
          .filter((obj) => obj.name.endsWith('__mdt'))
          .filter(
            (obj) =>
              obj.name.toLowerCase().includes(needle) ||
              obj.label.toLowerCase().includes(needle)
          )
          .map((obj) => ({
            name: obj.name,
            label: obj.label,
          }));

        output.customMetadataTypes = matchingTypes;
      } catch (error) {
        output.customMetadataTypesError =
          normalizeSalesforceError(error);
      }

      // ------------------------------------------------------------
      // 9. SUMMARY
      // ------------------------------------------------------------

      const countArray = (value: unknown) =>
        Array.isArray(value) ? value.length : null;

      const dependencyCount =
        (output.metadataDependencies as any)?.totalSize ?? null;

      output.summary = {
        metadataDependencies: dependencyCount,
        apexClasses: countArray(output.apexClasses),
        apexTriggers: countArray(output.apexTriggers),
        flows: countArray(output.flows),
        validationRules: countArray(output.validationRules),
        customFields: countArray(output.customFields),
        layouts: countArray(output.layouts),
        customMetadataTypes:
          countArray(output.customMetadataTypes),
      };

      return jsonResult(output);
    }
  );


//////////////////////////////////////////////
//    Salesforce Find Explain Field       //
////////////////////////////////////////////

  server.registerTool(
    'salesforce_explain_field',
    {
      description:
        'Build a comprehensive technical overview of a Salesforce field, including schema details, formula/relationship information, field-level permissions, and metadata dependencies.',
      inputSchema: z.object({
        objectName: z
          .string()
          .describe('Salesforce object API name'),
        fieldName: z
          .string()
          .describe('Field API name, such as Second_Signer__c'),
      }),
      annotations: {
        readOnlyHint: true,
      },
    },
    async ({ objectName, fieldName }) => {
      const conn = await getSalesforceConnection();

      const safeObject = escapeSoql(objectName);
      const fullFieldName = fieldName.includes('.')
        ? fieldName
        : `${objectName}.${fieldName}`;

      const safeFullField = escapeSoql(fullFieldName);

      const output: Record<string, unknown> = {
        objectName,
        fieldName,
        fullFieldName,
      };

      // ------------------------------------------------------------
      // 1. FIELD DESCRIPTION
      // ------------------------------------------------------------

      try {
        // const objectDescription = await conn.sobject(objectName).describe();
        const cached = await getCachedDescribe(
          conn,
          objectName
        );

        const objectDescription = cached.description;

        const field = objectDescription.fields.find(
          (item) =>
            item.name.toLowerCase() === fieldName.toLowerCase()
        );

        if (!field) {
          throw new Error(
            `Field ${fieldName} was not found on ${objectName}.`
          );
        }

        output.field = {
          name: field.name,
          label: field.label,
          type: field.type,
          custom: field.custom,
          length: field.length,
          precision: field.precision,
          scale: field.scale,
          nillable: field.nillable,
          required:
            !field.nillable && !field.defaultedOnCreate,
          defaultedOnCreate: field.defaultedOnCreate,
          createable: field.createable,
          updateable: field.updateable,
          calculated: field.calculated,
          calculatedFormula: field.calculatedFormula,
          referenceTo: field.referenceTo,
          relationshipName: field.relationshipName,
          relationshipOrder: field.relationshipOrder,
          unique: field.unique,
          externalId: field.externalId,
          autoNumber: field.autoNumber,
          defaultValue: field.defaultValue,
          defaultValueFormula: field.defaultValueFormula,
          restrictedPicklist: field.restrictedPicklist,
          picklistValues: field.picklistValues?.map((value) => ({
            label: value.label,
            value: value.value,
            active: value.active,
            defaultValue: value.defaultValue,
          })),
        };
      } catch (error) {
        output.fieldDescribeError =
          normalizeSalesforceError(error);
      }

      // ------------------------------------------------------------
      // 2. ENTITY PARTICLE / FIELD DEFINITION
      // ------------------------------------------------------------

      try {
        const entityResult = await conn.tooling.query(`
          SELECT Id, DurableId, QualifiedApiName
          FROM EntityDefinition
          WHERE QualifiedApiName = '${safeObject}'
          LIMIT 1
        `);

        if (entityResult.records.length > 0) {
          const entity: any = entityResult.records[0];

          const fieldResult = await conn.tooling.query(`
            SELECT DurableId,
                   QualifiedApiName,
                   Label,
                   DataType,
                   Length,
                   Precision,
                   Scale,
                   IsCalculated,
                   IsCompound,
                   IsHighScaleNumber,
                   ReferenceTo,
                   RelationshipName
            FROM FieldDefinition
            WHERE EntityDefinitionId = '${escapeSoql(entity.Id)}'
            AND QualifiedApiName = '${escapeSoql(fieldName)}'
            LIMIT 1
          `);

          output.fieldDefinition = fieldResult;
        }
      } catch (error) {
        output.fieldDefinitionError =
          normalizeSalesforceError(error);
      }

      // ------------------------------------------------------------
      // 3. FIELD LEVEL SECURITY
      // ------------------------------------------------------------

      try {
        output.fieldPermissions = await conn.query(`
          SELECT Id,
                 ParentId,
                 Parent.Name,
                 Parent.Label,
                 Parent.IsOwnedByProfile,
                 SObjectType,
                 Field,
                 PermissionsRead,
                 PermissionsEdit
          FROM FieldPermissions
          WHERE Field = '${safeFullField}'
          ORDER BY Parent.Label
        `);
      } catch (error) {
        output.fieldPermissionsError =
          normalizeSalesforceError(error);
      }

      // ------------------------------------------------------------
      // 4. METADATA DEPENDENCIES
      // ------------------------------------------------------------

      try {
        output.dependencies = await conn.tooling.query(`
          SELECT MetadataComponentId,
                 MetadataComponentName,
                 MetadataComponentType,
                 RefMetadataComponentId,
                 RefMetadataComponentName,
                 RefMetadataComponentType
          FROM MetadataComponentDependency
          WHERE RefMetadataComponentName = '${escapeSoql(fieldName)}'
             OR MetadataComponentName = '${escapeSoql(fieldName)}'
             OR RefMetadataComponentName = '${safeFullField}'
             OR MetadataComponentName = '${safeFullField}'
          LIMIT 2000
        `);
      } catch (error) {
        output.dependenciesError =
          normalizeSalesforceError(error);
      }

      // ------------------------------------------------------------
      // 5. SEARCH APEX FOR REFERENCES
      // ------------------------------------------------------------

      try {
        const classes = await conn.tooling.query(`
          SELECT Id, Name, Body
          FROM ApexClass
          ORDER BY Name
        `);

        const triggers = await conn.tooling.query(`
          SELECT Id, Name, Body, TableEnumOrId
          FROM ApexTrigger
          ORDER BY Name
        `);

        const needle = fieldName.toLowerCase();

        output.apexReferences = {
          classes: (classes.records as any[])
            .filter((record) =>
              String(record.Body ?? '')
                .toLowerCase()
                .includes(needle)
            )
            .map((record) => ({
              id: record.Id,
              name: record.Name,
            })),

          triggers: (triggers.records as any[])
            .filter((record) =>
              String(record.Body ?? '')
                .toLowerCase()
                .includes(needle)
            )
            .map((record) => ({
              id: record.Id,
              name: record.Name,
              object: record.TableEnumOrId,
            })),
        };
      } catch (error) {
        output.apexReferencesError =
          normalizeSalesforceError(error);
      }

      // ------------------------------------------------------------
      // 6. SEARCH FLOWS
      // ------------------------------------------------------------

      try {
        const definitions = await conn.tooling.query(`
          SELECT Id,
                 DeveloperName,
                 MasterLabel,
                 ActiveVersionId,
                 LatestVersionId,
                 ProcessType
          FROM FlowDefinitionView
          ORDER BY DeveloperName
        `);

        const needle = fieldName.toLowerCase();
        const matchingFlows: any[] = [];

        for (const definition of definitions.records as any[]) {
          const versionId =
            definition.ActiveVersionId ??
            definition.LatestVersionId;

          if (!versionId) {
            continue;
          }

          try {
            const flowResult = await conn.tooling.query(`
              SELECT Id,
                     VersionNumber,
                     Status,
                     Metadata
              FROM Flow
              WHERE Id = '${escapeSoql(versionId)}'
              LIMIT 1
            `);

            const flow: any = flowResult.records[0];

            if (
              flow?.Metadata &&
              JSON.stringify(flow.Metadata)
                .toLowerCase()
                .includes(needle)
            ) {
              matchingFlows.push({
                definitionId: definition.Id,
                developerName: definition.DeveloperName,
                masterLabel: definition.MasterLabel,
                processType: definition.ProcessType,
                versionId,
                versionNumber: flow.VersionNumber,
                status: flow.Status,
              });
            }
          } catch {
            // Skip individual Flow retrieval errors.
          }
        }

        output.flowReferences = matchingFlows;
      } catch (error) {
        output.flowReferencesError =
          normalizeSalesforceError(error);
      }

      // ------------------------------------------------------------
      // 7. FORMULA / CUSTOM FIELD REFERENCES
      // ------------------------------------------------------------

      try {
        const customFields = await conn.tooling.query(`
          SELECT Id,
                 DeveloperName,
                 TableEnumOrId,
                 DataType,
                 Metadata
          FROM CustomField
        `);

        const needle = fieldName.toLowerCase();

        output.customFieldReferences =
          (customFields.records as any[])
            .filter((record) =>
              JSON.stringify(record.Metadata ?? {})
                .toLowerCase()
                .includes(needle)
            )
            .map((record) => ({
              id: record.Id,
              developerName: record.DeveloperName,
              object: record.TableEnumOrId,
              dataType: record.DataType,
            }));
      } catch (error) {
        output.customFieldReferencesError =
          normalizeSalesforceError(error);
      }

      // ------------------------------------------------------------
      // 8. SUMMARY
      // ------------------------------------------------------------

      const fieldPermissions: any[] =
        (output.fieldPermissions as any)?.records ?? [];

      const readableSources = fieldPermissions
        .filter((item) => item.PermissionsRead)
        .map((item) => ({
          name: item.Parent?.Name,
          label: item.Parent?.Label,
          profile: item.Parent?.IsOwnedByProfile,
        }));

      const editableSources = fieldPermissions
        .filter((item) => item.PermissionsEdit)
        .map((item) => ({
          name: item.Parent?.Name,
          label: item.Parent?.Label,
          profile: item.Parent?.IsOwnedByProfile,
        }));

      output.summary = {
        readablePermissionSources: readableSources,
        editablePermissionSources: editableSources,
        flowReferenceCount:
          Array.isArray(output.flowReferences)
            ? output.flowReferences.length
            : null,
        customFieldReferenceCount:
          Array.isArray(output.customFieldReferences)
            ? output.customFieldReferences.length
            : null,
        apexClassReferenceCount:
          Array.isArray(
            (output.apexReferences as any)?.classes
          )
            ? (output.apexReferences as any).classes.length
            : null,
        apexTriggerReferenceCount:
          Array.isArray(
            (output.apexReferences as any)?.triggers
          )
            ? (output.apexReferences as any).triggers.length
            : null,
      };

      return jsonResult(output);
    }
  );


////////////////////////////////////////
//    Salesforce Diagnose Error      //
//////////////////////////////////////

  server.registerTool(
    'salesforce_diagnose_error',
    {
      description:
        'Investigate a Salesforce error, component name, exception, or failure message across Apex logs, async jobs, Flows, Apex source, validation rules, and metadata dependencies.',
      inputSchema: z.object({
        errorText: z
          .string()
          .describe(
            'Salesforce error message, exception text, component name, Flow name, Apex class name, or other failure text'
          ),
        recentLimit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .default(25),
      }),
      annotations: {
        readOnlyHint: true,
      },
    },
    async ({ errorText, recentLimit }) => {
      const conn = await getSalesforceConnection();

      const safe = escapeSoql(errorText);
      const needle = errorText.toLowerCase();

      const output: Record<string, unknown> = {
        errorText,
        analyzedAt: new Date().toISOString(),
      };

      // ------------------------------------------------------------
      // 1. RECENT APEX LOG HEADERS
      // ------------------------------------------------------------

      try {
        const logs = await conn.tooling.query(`
          SELECT Id,
                 LogUserId,
                 LogLength,
                 Request,
                 Operation,
                 Status,
                 StartTime,
                 DurationMilliseconds
          FROM ApexLog
          ORDER BY StartTime DESC
          LIMIT ${recentLimit}
        `);

        output.recentApexLogs = logs;
      } catch (error) {
        output.recentApexLogsError =
          normalizeSalesforceError(error);
      }

      // ------------------------------------------------------------
      // 2. RECENT ASYNC APEX JOBS
      // ------------------------------------------------------------

      try {
        output.asyncJobs = await conn.query(`
          SELECT Id,
                 ApexClassId,
                 ApexClass.Name,
                 JobType,
                 Status,
                 MethodName,
                 JobItemsProcessed,
                 TotalJobItems,
                 NumberOfErrors,
                 ExtendedStatus,
                 CreatedDate,
                 CompletedDate
          FROM AsyncApexJob
          ORDER BY CreatedDate DESC
          LIMIT ${recentLimit}
        `);
      } catch (error) {
        output.asyncJobsError =
          normalizeSalesforceError(error);
      }

      // ------------------------------------------------------------
      // 3. APEX CLASSES CONTAINING ERROR TEXT
      // ------------------------------------------------------------

      try {
        const classes = await conn.tooling.query(`
          SELECT Id,
                 Name,
                 Body,
                 ApiVersion,
                 Status
          FROM ApexClass
          ORDER BY Name
        `);

        output.apexClassMatches =
          (classes.records as any[])
            .filter((record) => {
              const haystack = [
                record.Name,
                record.Body,
              ]
                .filter(Boolean)
                .join('\n')
                .toLowerCase();

              return haystack.includes(needle);
            })
            .map((record) => ({
              id: record.Id,
              name: record.Name,
              apiVersion: record.ApiVersion,
              status: record.Status,
            }));
      } catch (error) {
        output.apexClassMatchesError =
          normalizeSalesforceError(error);
      }

      // ------------------------------------------------------------
      // 4. APEX TRIGGERS CONTAINING ERROR TEXT
      // ------------------------------------------------------------

      try {
        const triggers = await conn.tooling.query(`
          SELECT Id,
                 Name,
                 Body,
                 TableEnumOrId,
                 ApiVersion,
                 Status
          FROM ApexTrigger
          ORDER BY Name
        `);

        output.apexTriggerMatches =
          (triggers.records as any[])
            .filter((record) => {
              const haystack = [
                record.Name,
                record.Body,
                record.TableEnumOrId,
              ]
                .filter(Boolean)
                .join('\n')
                .toLowerCase();

              return haystack.includes(needle);
            })
            .map((record) => ({
              id: record.Id,
              name: record.Name,
              object: record.TableEnumOrId,
              apiVersion: record.ApiVersion,
              status: record.Status,
            }));
      } catch (error) {
        output.apexTriggerMatchesError =
          normalizeSalesforceError(error);
      }

      // ------------------------------------------------------------
      // 5. FLOW DEFINITIONS + METADATA SEARCH
      // ------------------------------------------------------------

      try {
        const definitions = await conn.tooling.query(`
          SELECT Id,
                 DeveloperName,
                 MasterLabel,
                 ProcessType,
                 ActiveVersionId,
                 LatestVersionId
          FROM FlowDefinitionView
          ORDER BY DeveloperName
        `);

        const matchingFlows: any[] = [];

        for (const definition of definitions.records as any[]) {
          const nameHaystack = [
            definition.DeveloperName,
            definition.MasterLabel,
          ]
            .filter(Boolean)
            .join('\n')
            .toLowerCase();

          const nameMatch = nameHaystack.includes(needle);

          const versionId =
            definition.ActiveVersionId ??
            definition.LatestVersionId;

          let metadataMatch = false;
          let versionNumber: number | null = null;
          let status: string | null = null;

          if (versionId) {
            try {
              const flowResult = await conn.tooling.query(`
                SELECT Id,
                       VersionNumber,
                       Status,
                       Metadata
                FROM Flow
                WHERE Id = '${escapeSoql(versionId)}'
                LIMIT 1
              `);

              const flow: any = flowResult.records[0];

              versionNumber = flow?.VersionNumber ?? null;
              status = flow?.Status ?? null;

              if (flow?.Metadata) {
                metadataMatch = JSON.stringify(flow.Metadata)
                  .toLowerCase()
                  .includes(needle);
              }
            } catch {
              // Ignore individual flow retrieval errors.
            }
          }

          if (nameMatch || metadataMatch) {
            matchingFlows.push({
              definitionId: definition.Id,
              developerName: definition.DeveloperName,
              masterLabel: definition.MasterLabel,
              processType: definition.ProcessType,
              activeVersionId: definition.ActiveVersionId,
              latestVersionId: definition.LatestVersionId,
              versionNumber,
              status,
              nameMatch,
              metadataMatch,
            });
          }
        }

        output.flowMatches = matchingFlows;
      } catch (error) {
        output.flowMatchesError =
          normalizeSalesforceError(error);
      }

      // ------------------------------------------------------------
      // 6. VALIDATION RULE SEARCH
      // ------------------------------------------------------------

      try {
        const rules = await conn.tooling.query(`
          SELECT Id,
                 ValidationName,
                 Active,
                 Description,
                 ErrorMessage,
                 EntityDefinitionId,
                 Metadata
          FROM ValidationRule
        `);

        output.validationRuleMatches =
          (rules.records as any[])
            .filter((record) =>
              JSON.stringify(record)
                .toLowerCase()
                .includes(needle)
            )
            .map((record) => ({
              id: record.Id,
              name: record.ValidationName,
              active: record.Active,
              description: record.Description,
              errorMessage: record.ErrorMessage,
              entityDefinitionId:
                record.EntityDefinitionId,
            }));
      } catch (error) {
        output.validationRuleMatchesError =
          normalizeSalesforceError(error);
      }

      // ------------------------------------------------------------
      // 7. METADATA DEPENDENCY SEARCH
      // ------------------------------------------------------------

      try {
        output.metadataDependencies =
          await conn.tooling.query(`
            SELECT MetadataComponentId,
                   MetadataComponentName,
                   MetadataComponentType,
                   RefMetadataComponentId,
                   RefMetadataComponentName,
                   RefMetadataComponentType
            FROM MetadataComponentDependency
            WHERE MetadataComponentName LIKE '%${safe}%'
               OR RefMetadataComponentName LIKE '%${safe}%'
            LIMIT 2000
          `);
      } catch (error) {
        output.metadataDependenciesError =
          normalizeSalesforceError(error);
      }

      // ------------------------------------------------------------
      // 8. HEURISTIC CLASSIFICATION
      // ------------------------------------------------------------

      const lower = errorText.toLowerCase();

      const classifications: string[] = [];

      if (
        lower.includes('cannot_execute_flow_trigger') ||
        lower.includes('flow')
      ) {
        classifications.push('FLOW_OR_PROCESS_AUTOMATION');
      }

      if (
        lower.includes('apex') ||
        lower.includes('trigger') ||
        lower.includes('exception') ||
        lower.includes('stack trace')
      ) {
        classifications.push('APEX_OR_TRIGGER');
      }

      if (
        lower.includes('validation') ||
        lower.includes('field_custom_validation_exception')
      ) {
        classifications.push('VALIDATION_RULE');
      }

      if (
        lower.includes('insufficient_access') ||
        lower.includes('insufficient privileges') ||
        lower.includes('permission')
      ) {
        classifications.push('PERMISSIONS_OR_SHARING');
      }

      if (
        lower.includes('required_field_missing') ||
        lower.includes('required field')
      ) {
        classifications.push('REQUIRED_FIELD');
      }

      if (
        lower.includes('duplicate') ||
        lower.includes('duplicate_value')
      ) {
        classifications.push('DUPLICATE_RULE_OR_UNIQUE_FIELD');
      }

      if (
        lower.includes('queryexception') ||
        lower.includes('invalid_field') ||
        lower.includes('malformed_query')
      ) {
        classifications.push('SOQL_OR_SCHEMA');
      }

      output.classification =
        classifications.length > 0
          ? classifications
          : ['UNKNOWN'];

      // ------------------------------------------------------------
      // 9. SUMMARY COUNTS
      // ------------------------------------------------------------

      output.summary = {
        apexClassMatches:
          Array.isArray(output.apexClassMatches)
            ? output.apexClassMatches.length
            : null,

        apexTriggerMatches:
          Array.isArray(output.apexTriggerMatches)
            ? output.apexTriggerMatches.length
            : null,

        flowMatches:
          Array.isArray(output.flowMatches)
            ? output.flowMatches.length
            : null,

        validationRuleMatches:
          Array.isArray(output.validationRuleMatches)
            ? output.validationRuleMatches.length
            : null,

        dependencyMatches:
          (output.metadataDependencies as any)?.totalSize ??
          null,
      };

      return jsonResult(output);
    }
  );




//////////////////////////////////////
//    Salesforce Schema Cache      //
////////////////////////////////////

// ---------------------
// 1. Cache Status 
// ---------------------

  server.registerTool(
    'salesforce_schema_cache_status',
    {
      description:
        'Show the current Salesforce schema cache status.',
      annotations: {
        readOnlyHint: true,
      },
    },
    async () => {
      const now = Date.now();

      const entries = [
        ...schemaCache.entries(),
      ].map(([objectName, entry]) => ({
        objectName,
        expiresAt:
          new Date(
            entry.expiresAt
          ).toISOString(),
        expiresInSeconds:
          Math.max(
            0,
            Math.floor(
              (entry.expiresAt - now) /
                1000
            )
          ),
      }));

      return jsonResult({
        ttlMinutes:
          SCHEMA_CACHE_TTL_MS /
          60000,
        cachedObjects:
          entries.length,
        entries,
      });
    }
  );

// -------------------------
// 2. Manually Clear Cache 
// -------------------------

  server.registerTool(
    'salesforce_clear_schema_cache',
    {
      description:
        'Clear cached Salesforce object schema. Optionally clear only one object.',
      inputSchema: z.object({
        objectName: z
          .string()
          .optional()
          .describe(
            'Optional Salesforce object API name. Omit to clear the entire cache.'
          ),
      }),
      annotations: {
        readOnlyHint: true,
      },
    },
    async ({ objectName }) => {
      clearSchemaCache(objectName);

      return jsonResult({
        cleared:
          objectName ?? 'ALL',
        remainingObjects:
          schemaCache.size,
      });
    }
  );

// -------------------------
// 3. Warm The Cache 
// -------------------------

  server.registerTool(
    'salesforce_warm_schema_cache',
    {
      description:
        'Preload Salesforce object descriptions into the schema cache.',
      inputSchema: z.object({
        objectNames: z
          .array(z.string())
          .min(1)
          .max(100)
          .describe(
            'Salesforce object API names to cache'
          ),
      }),
      annotations: {
        readOnlyHint: true,
      },
    },
    async ({ objectNames }) => {
      const conn =
        await getSalesforceConnection();

      const results: any[] = [];

      for (
        const objectName
        of objectNames
      ) {
        try {
          const result =
            await getCachedDescribe(
              conn,
              objectName
            );

          results.push({
            objectName,
            success: true,
            source:
              result.source,
            fieldCount:
              result.description
                .fields?.length ??
              null,
          });
        } catch (error) {
          results.push({
            objectName,
            success: false,
            error:
              normalizeSalesforceError(
                error
              ),
          });
        }
      }

      return jsonResult({
        cachedObjects:
          schemaCache.size,
        results,
      });
    }
  );


////////////////////////////////////////
//    Salesforce Diagnose Error      //
//////////////////////////////////////

  server.registerTool(
    'salesforce_inventory_all_user_access',
    {
      description:
        'Inventory effective access assignments for all active Salesforce users, including profiles, roles, licenses, permission sets, permission set groups, and selected high-risk system permissions.',
      inputSchema: z.object({
        includeInactiveUsers: z
          .boolean()
          .default(false)
          .describe(
            'Include inactive Salesforce users. Defaults to false.'
          ),
      }),
      annotations: {
        readOnlyHint: true,
      },
    },
    async ({ includeInactiveUsers }) => {
      const conn = await getSalesforceConnection();

      const output: Record<string, unknown> = {};

      // ------------------------------------------------------------
      // 1. USERS
      // ------------------------------------------------------------

      const userWhere = includeInactiveUsers
        ? ''
        : 'WHERE IsActive = true';

      const usersResult = await conn.query(`
        SELECT
          Id,
          Name,
          Username,
          Email,
          IsActive,
          UserType,
          ProfileId,
          Profile.Name,
          UserRoleId,
          UserRole.Name,
          UserRole.DeveloperName,
          UserPermissionsMarketingUser,
          UserPermissionsOfflineUser
        FROM User
        ${userWhere}
        ORDER BY Name
      `);

      const users = usersResult.records as any[];

      // ------------------------------------------------------------
      // 2. USER LICENSES THROUGH PROFILE
      // ------------------------------------------------------------

      const profileIds = [
        ...new Set(
          users
            .map((user) => user.ProfileId)
            .filter(Boolean)
        ),
      ];

      const profileMap = new Map<string, any>();

      if (profileIds.length > 0) {
        const ids = profileIds
          .map((id) => `'${escapeSoql(id)}'`)
          .join(',');

        const profilesResult = await conn.query(`
          SELECT
            Id,
            Name,
            UserLicenseId,
            UserLicense.Name
          FROM Profile
          WHERE Id IN (${ids})
        `);

        for (const profile of profilesResult.records as any[]) {
          profileMap.set(profile.Id, profile);
        }
      }

      // ------------------------------------------------------------
      // 3. PERMISSION SET ASSIGNMENTS
      // ------------------------------------------------------------

      const userIds = users.map((user) => user.Id);

      const assignmentsByUser =
        new Map<string, any[]>();

      const permissionSetIds =
        new Set<string>();

      if (userIds.length > 0) {
        // Query in chunks so we don't create an enormous IN clause.
        const chunkSize = 150;

        for (
          let i = 0;
          i < userIds.length;
          i += chunkSize
        ) {
          const chunk = userIds.slice(
            i,
            i + chunkSize
          );

          const ids = chunk
            .map(
              (id) =>
                `'${escapeSoql(id)}'`
            )
            .join(',');

          const assignments =
            await conn.query(`
              SELECT
                Id,
                AssigneeId,
                PermissionSetId,
                PermissionSet.Name,
                PermissionSet.Label,
                PermissionSet.IsOwnedByProfile,
                PermissionSet.ProfileId,
                PermissionSetGroupId,
                PermissionSetGroup.DeveloperName,
                PermissionSetGroup.MasterLabel
              FROM PermissionSetAssignment
              WHERE AssigneeId IN (${ids})
            `);

          for (
            const assignment
            of assignments.records as any[]
          ) {
            const existing =
              assignmentsByUser.get(
                assignment.AssigneeId
              ) ?? [];

            existing.push(assignment);

            assignmentsByUser.set(
              assignment.AssigneeId,
              existing
            );

            if (assignment.PermissionSetId) {
              permissionSetIds.add(
                assignment.PermissionSetId
              );
            }
          }
        }
      }

      // ------------------------------------------------------------
      // 4. PROFILE-BACKED PERMISSION SETS
      // ------------------------------------------------------------

      const profilePermissionSets =
        new Map<string, any>();

      if (profileIds.length > 0) {
        const ids = profileIds
          .map((id) => `'${escapeSoql(id)}'`)
          .join(',');

        const result = await conn.query(`
          SELECT
            Id,
            Name,
            Label,
            ProfileId,
            IsOwnedByProfile
          FROM PermissionSet
          WHERE ProfileId IN (${ids})
        `);

        for (
          const ps
          of result.records as any[]
        ) {
          if (ps.ProfileId) {
            profilePermissionSets.set(
              ps.ProfileId,
              ps
            );

            permissionSetIds.add(ps.Id);
          }
        }
      }

      // ------------------------------------------------------------
      // 5. HIGH-RISK SYSTEM PERMISSIONS
      //
      // These are intentionally explicit so we can immediately
      // identify broad administrative access.
      // ------------------------------------------------------------

      const permissionSetDetails =
        new Map<string, any>();

      if (permissionSetIds.size > 0) {
        const allPermissionSetIds =
          [...permissionSetIds];

        const chunkSize = 150;

        for (
          let i = 0;
          i < allPermissionSetIds.length;
          i += chunkSize
        ) {
          const chunk =
            allPermissionSetIds.slice(
              i,
              i + chunkSize
            );

          const ids = chunk
            .map(
              (id) =>
                `'${escapeSoql(id)}'`
            )
            .join(',');

          const result = await conn.query(`
            SELECT
              Id,
              Name,
              Label,
              IsOwnedByProfile,
              ProfileId,
              PermissionsModifyAllData,
              PermissionsViewAllData,
              PermissionsManageUsers,
              PermissionsCustomizeApplication,
              PermissionsAuthorApex,
              PermissionsManageProfilesPermissionsets,
              PermissionsViewSetup,
              PermissionsManageRoles,
              PermissionsManageSharing,
              PermissionsTransferAnyEntity,
              PermissionsPasswordNeverExpires,
              PermissionsApiEnabled
            FROM PermissionSet
            WHERE Id IN (${ids})
          `);

          for (
            const ps
            of result.records as any[]
          ) {
            permissionSetDetails.set(
              ps.Id,
              ps
            );
          }
        }
      }

      // ------------------------------------------------------------
      // 6. BUILD USER ACCESS INVENTORY
      // ------------------------------------------------------------

      const userInventory =
        users.map((user) => {
          const assignments =
            assignmentsByUser.get(
              user.Id
            ) ?? [];

          const profile =
            profileMap.get(
              user.ProfileId
            );

          const profilePermissionSet =
            profilePermissionSets.get(
              user.ProfileId
            );

          const directPermissionSets =
            assignments
              .filter(
                (assignment) =>
                  assignment.PermissionSetId &&
                  !assignment
                    .PermissionSet
                    ?.IsOwnedByProfile
              )
              .map((assignment) => ({
                id:
                  assignment.PermissionSetId,
                name:
                  assignment
                    .PermissionSet
                    ?.Name,
                label:
                  assignment
                    .PermissionSet
                    ?.Label,
              }));

          const permissionSetGroups =
            assignments
              .filter(
                (assignment) =>
                  assignment
                    .PermissionSetGroupId
              )
              .map((assignment) => ({
                id:
                  assignment
                    .PermissionSetGroupId,
                developerName:
                  assignment
                    .PermissionSetGroup
                    ?.DeveloperName,
                label:
                  assignment
                    .PermissionSetGroup
                    ?.MasterLabel,
              }));

          const effectivePermissionSets =
            [
              profilePermissionSet?.Id,
              ...directPermissionSets.map(
                (ps) => ps.id
              ),
            ].filter(Boolean);

          const highRiskSources: any[] = [];

          const highRiskPermissionNames = [
            'PermissionsModifyAllData',
            'PermissionsViewAllData',
            'PermissionsManageUsers',
            'PermissionsCustomizeApplication',
            'PermissionsAuthorApex',
            'PermissionsManageProfilesPermissionsets',
            'PermissionsViewSetup',
            'PermissionsManageRoles',
            'PermissionsManageSharing',
            'PermissionsTransferAnyEntity',
            'PermissionsPasswordNeverExpires',
          ];

          for (
            const psId
            of effectivePermissionSets
          ) {
            const ps =
              permissionSetDetails.get(
                psId
              );

            if (!ps) {
              continue;
            }

            const enabledHighRiskPermissions =
              highRiskPermissionNames.filter(
                (permissionName) =>
                  ps[permissionName] === true
              );

            if (
              enabledHighRiskPermissions.length >
              0
            ) {
              highRiskSources.push({
                permissionSetId:
                  ps.Id,
                name:
                  ps.Name,
                label:
                  ps.Label,
                profileBacked:
                  ps.IsOwnedByProfile,
                permissions:
                  enabledHighRiskPermissions,
              });
            }
          }

          return {
            id: user.Id,
            name: user.Name,
            username: user.Username,
            email: user.Email,
            active: user.IsActive,
            userType: user.UserType,

            profile: {
              id: user.ProfileId,
              name:
                user.Profile?.Name,
            },

            role: user.UserRoleId
              ? {
                  id:
                    user.UserRoleId,
                  name:
                    user.UserRole?.Name,
                  developerName:
                    user.UserRole
                      ?.DeveloperName,
                }
              : null,

            license: profile
              ? {
                  id:
                    profile.UserLicenseId,
                  name:
                    profile.UserLicense
                      ?.Name,
                }
              : null,

            profilePermissionSet:
              profilePermissionSet
                ? {
                    id:
                      profilePermissionSet.Id,
                    name:
                      profilePermissionSet.Name,
                    label:
                      profilePermissionSet.Label,
                  }
                : null,

            directPermissionSets,

            permissionSetGroups,

            counts: {
              directPermissionSets:
                directPermissionSets.length,
              permissionSetGroups:
                permissionSetGroups.length,
              highRiskSources:
                highRiskSources.length,
            },

            highRiskSources,
          };
        });

      // ------------------------------------------------------------
      // 7. PROFILE / ROLE / LICENSE SUMMARY
      // ------------------------------------------------------------

      const profileCounts =
        new Map<string, number>();

      const roleCounts =
        new Map<string, number>();

      const licenseCounts =
        new Map<string, number>();

      for (
        const user
        of userInventory as any[]
      ) {
        const profileName =
          user.profile?.name ??
          'NONE';

        profileCounts.set(
          profileName,
          (profileCounts.get(
            profileName
          ) ?? 0) + 1
        );

        const roleName =
          user.role?.name ??
          'NO_ROLE';

        roleCounts.set(
          roleName,
          (roleCounts.get(
            roleName
          ) ?? 0) + 1
        );

        const licenseName =
          user.license?.name ??
          'UNKNOWN';

        licenseCounts.set(
          licenseName,
          (licenseCounts.get(
            licenseName
          ) ?? 0) + 1
        );
      }

      const highRiskUsers =
        (userInventory as any[])
          .filter(
            (user) =>
              user.highRiskSources.length >
              0
          )
          .map((user) => ({
            id: user.id,
            name: user.name,
            username: user.username,
            profile: user.profile,
            highRiskSources:
              user.highRiskSources,
          }));

      output.summary = {
        totalUsers:
          userInventory.length,

        profilesInUse:
          profileCounts.size,

        rolesInUse:
          roleCounts.size,

        licensesInUse:
          licenseCounts.size,

        usersWithHighRiskPermissions:
          highRiskUsers.length,
      };

      output.profileDistribution =
        [...profileCounts.entries()]
          .map(([name, count]) => ({
            name,
            count,
          }))
          .sort(
            (a, b) =>
              b.count - a.count
          );

      output.roleDistribution =
        [...roleCounts.entries()]
          .map(([name, count]) => ({
            name,
            count,
          }))
          .sort(
            (a, b) =>
              b.count - a.count
          );

      output.licenseDistribution =
        [...licenseCounts.entries()]
          .map(([name, count]) => ({
            name,
            count,
          }))
          .sort(
            (a, b) =>
              b.count - a.count
          );

      output.highRiskUsers =
        highRiskUsers;

      output.users =
        userInventory;

      return jsonResult(output);
    }
  );



// ------------------------------------ //
// ********   RETURN SERVER   ******** //
// ---------------------------------- //


  return server;
}

serveStdio(() => createServer());
