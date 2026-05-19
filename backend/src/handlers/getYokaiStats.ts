import type { APIGatewayProxyHandler } from 'aws-lambda';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, CAPTURES_TABLE } from '../lib/dynamodb';

const HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
};

export const handler: APIGatewayProxyHandler = async (event) => {
  const youkaiId = event.pathParameters?.id;
  if (!youkaiId) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Missing id' }) };
  }

  let seal = 0;
  let bond = 0;
  let lastKey: Record<string, unknown> | undefined;

  do {
    const res = await ddb.send(new QueryCommand({
      TableName: CAPTURES_TABLE,
      IndexName: 'youkaiId-index',
      KeyConditionExpression: 'youkaiId = :yk',
      ExpressionAttributeValues: { ':yk': youkaiId },
      ProjectionExpression: 'actionType',
      ExclusiveStartKey: lastKey,
    }));
    for (const item of res.Items ?? []) {
      if (item.actionType === 'bond') bond++;
      else seal++;
    }
    lastKey = res.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (lastKey);

  return {
    statusCode: 200,
    headers: HEADERS,
    body: JSON.stringify({ seal_count: seal, bond_count: bond }),
  };
};
