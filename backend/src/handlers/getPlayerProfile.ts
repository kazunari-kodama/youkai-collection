import type { APIGatewayProxyHandler } from 'aws-lambda';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, PLAYER_PROFILE_TABLE } from '../lib/dynamodb';

const HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
};

export const handler: APIGatewayProxyHandler = async (event) => {
  const deviceId = event.queryStringParameters?.deviceId;
  if (!deviceId) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Missing deviceId' }) };
  }

  const result = await ddb.send(new GetCommand({
    TableName: PLAYER_PROFILE_TABLE,
    Key: { deviceId },
  }));

  if (!result.Item) {
    return {
      statusCode: 200,
      headers: HEADERS,
      body: JSON.stringify({ deviceId, faction: null, job: null, rank: 'C', exp: 0, title: '' }),
    };
  }

  return { statusCode: 200, headers: HEADERS, body: JSON.stringify(result.Item) };
};
