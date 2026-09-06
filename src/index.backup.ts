import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
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
  return server;
}

serveStdio(() => createServer());
