import 'dotenv/config';
import jsforce from 'jsforce';

const instanceUrl = process.env.SALESFORCE_INSTANCE_URL;
const clientId = process.env.SALESFORCE_CLIENT_ID;
const clientSecret = process.env.SALESFORCE_CLIENT_SECRET;

if (!instanceUrl || !clientId || !clientSecret) {
  throw new Error(
    'Missing SALESFORCE_INSTANCE_URL, SALESFORCE_CLIENT_ID, or SALESFORCE_CLIENT_SECRET in .env'
  );
}

const sfInstanceUrl: string = instanceUrl;
const sfClientId: string = clientId;
const sfClientSecret: string = clientSecret;

export async function getSalesforceConnection() {
  const tokenUrl = `${sfInstanceUrl}/services/oauth2/token`;

const body = new URLSearchParams({
  grant_type: 'client_credentials',
  client_id: sfClientId,
  client_secret: sfClientSecret,
});

  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Salesforce authentication failed: ${response.status} ${response.statusText}\n${errorText}`
    );
  }

  const token = await response.json() as {
    access_token: string;
    instance_url: string;
  };

  return new jsforce.Connection({
    instanceUrl: token.instance_url,
    accessToken: token.access_token,
  });
}
