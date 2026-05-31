import type { APIGatewayProxyHandler } from 'aws-lambda';
import { ScanCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, KITOSHI_PRAYERS_TABLE } from '../lib/dynamodb';

const HEADERS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

export const handler: APIGatewayProxyHandler = async () => {
  const res = await ddb.send(new ScanCommand({
    TableName: KITOSHI_PRAYERS_TABLE,
    FilterExpression: 'expires_at > :now',
    ExpressionAttributeValues: { ':now': new Date().toISOString() },
    ProjectionExpression: 'deviceId, prayer_id, lat, lon, placed_at, expires_at',
  }));

  return {
    statusCode: 200,
    headers: HEADERS,
    body: JSON.stringify({ prayers: res.Items ?? [] }),
  };
};
