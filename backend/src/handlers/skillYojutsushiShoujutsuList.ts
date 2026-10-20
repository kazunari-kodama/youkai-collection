import type { APIGatewayProxyHandler } from 'aws-lambda';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, SHOUJUTSU_TABLE } from '../lib/dynamodb';
import { isValidDeviceId } from '../lib/deviceId';

const HEADERS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

export const handler: APIGatewayProxyHandler = async (event) => {
  const deviceId = event.queryStringParameters?.deviceId;
  if (!isValidDeviceId(deviceId)) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Missing deviceId' }) };
  }

  const res = await ddb.send(new QueryCommand({
    TableName: SHOUJUTSU_TABLE,
    KeyConditionExpression: 'deviceId = :d',
    FilterExpression: '#st = :flying',
    ExpressionAttributeNames: { '#st': 'status' },
    ExpressionAttributeValues: { ':d': deviceId, ':flying': 'flying' },
  }));

  return {
    statusCode: 200,
    headers: HEADERS,
    body: JSON.stringify({ summons: res.Items ?? [] }),
  };
};
