import type { APIGatewayProxyHandler } from 'aws-lambda';
import { ScanCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, YAMABUSHI_STONES_TABLE } from '../lib/dynamodb';

const HEADERS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

export const handler: APIGatewayProxyHandler = async () => {
  const res = await ddb.send(new ScanCommand({
    TableName: YAMABUSHI_STONES_TABLE,
    ProjectionExpression: 'deviceId, stone_id, lat, lon, placed_at, #msg',
    ExpressionAttributeNames: { '#msg': 'message' },
  }));

  return {
    statusCode: 200,
    headers: HEADERS,
    body: JSON.stringify({ stones: res.Items ?? [] }),
  };
};
