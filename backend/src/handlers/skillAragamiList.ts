import type { APIGatewayProxyHandler } from 'aws-lambda';
import { ScanCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, ARAGAMI_TABLE } from '../lib/dynamodb';

const HEADERS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

export const handler: APIGatewayProxyHandler = async () => {
  const now = new Date().toISOString();
  const result = await ddb.send(new ScanCommand({
    TableName: ARAGAMI_TABLE,
    FilterExpression: 'expires_at > :now',
    ExpressionAttributeValues: { ':now': now },
    ProjectionExpression: 'youkaiId, youryoku, expires_at',
  }));

  const aragami = (result.Items ?? []).map((item) => ({
    youkaiId:   item.youkaiId   as string,
    youryoku:   item.youryoku   as number,
    expires_at: item.expires_at as string,
  }));

  return {
    statusCode: 200,
    headers: HEADERS,
    body: JSON.stringify({ aragami }),
  };
};
