import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import crypto from 'node:crypto';
import * as z from 'zod/v4';
import { getSalesforceConnection } from './salesforce.js';

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

const pendingBulkUpdates = new Map<
  string,
  {
    objectName: string;
    recordIds: string[];
    proposedFields: Record<string, unknown>;
    createdAt: number;
  }
>();

function createOperationToken() {
  return crypto.randomUUID();
}

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
      const result = await conn.sobject(objectName).describe();

      return jsonResult(result);
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
      const description = await conn.sobject(objectName).describe();

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

      const description = await conn.sobject(metadataType).describe();

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

      for (const obj of global.sobjects.filter((o) => o.custom && o.queryable)) {
        try {
          const description = await conn.sobject(obj.name).describe();

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
      const safe = componentName.replace(/'/g, "\\'");

      const result = await conn.tooling.query(`
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
      const description = await conn.sobject(objectName).describe();

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
      const description = await conn.sobject(objectName).describe();

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
      }),
      annotations: {
        readOnlyHint: true,
      },
    },
    async ({ fieldName }) => {
      const conn = await getSalesforceConnection();
      const safe = escapeSoql(fieldName);

      const result = await conn.tooling.query(`
        SELECT MetadataComponentId,
               MetadataComponentName,
               MetadataComponentType,
               RefMetadataComponentId,
               RefMetadataComponentName,
               RefMetadataComponentType
        FROM MetadataComponentDependency
        WHERE RefMetadataComponentName = '${safe}'
           OR MetadataComponentName = '${safe}'
        LIMIT 2000
      `);

      return jsonResult(result);
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
      const description = await conn.sobject(objectName).describe();

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
        'Execute a previously prepared Salesforce bulk update using its operation token.',
      inputSchema: z.object({
        operationToken: z
          .string()
          .describe('Operation token returned by salesforce_prepare_bulk_update'),
        confirm: z
          .literal(true)
          .describe('Must explicitly be true to execute the write'),
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
          'Operation token is invalid, expired, or was created by a previous MCP process.'
        );
      }

      const ageMs = Date.now() - operation.createdAt;
      const maxAgeMs = 15 * 60 * 1000;

      if (ageMs > maxAgeMs) {
        pendingBulkUpdates.delete(operationToken);

        throw new Error(
          'Operation token expired. Prepare the bulk update again.'
        );
      }

      const conn = await getSalesforceConnection();

      const records = operation.recordIds.map((recordId) => ({
        Id: recordId,
        ...operation.proposedFields,
      }));

      const results = await conn
        .sobject(operation.objectName)
        .update(records);

      pendingBulkUpdates.delete(operationToken);

      const normalizedResults = Array.isArray(results)
        ? results
        : [results];

      const successes = normalizedResults.filter(
        (result: any) => result.success
      );

      const failures = normalizedResults.filter(
        (result: any) => !result.success
      );

      return jsonResult({
        objectName: operation.objectName,
        attempted: records.length,
        succeeded: successes.length,
        failed: failures.length,
        successes,
        failures,
        operationTokenConsumed: true,
      });
    }
  );
  return server;
}

serveStdio(() => createServer());
