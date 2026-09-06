import { getSalesforceConnection } from '../src/salesforce.js';

async function main() {
  const conn = await getSalesforceConnection();

  const result = await conn.query(
    'SELECT Id, Name, Username FROM User LIMIT 1'
  );

  console.log('Connected to Salesforce successfully.');
  console.log(`Instance: ${conn.instanceUrl}`);
  console.log(`Records returned: ${result.totalSize}`);

  if (result.records.length > 0) {
    const user = result.records[0] as any;
    console.log(`Sample user: ${user.Name} (${user.Username})`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
