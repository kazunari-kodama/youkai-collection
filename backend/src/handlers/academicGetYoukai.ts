import type { APIGatewayProxyHandler } from 'aws-lambda';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, CORE_TABLE } from '../lib/dynamodb';

const HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
};

function isPremium(event: Parameters<APIGatewayProxyHandler>[0]): boolean {
  const claim = event.requestContext.authorizer?.claims?.['cognito:groups'] ?? '';
  return String(claim).includes('premium');
}

export const handler: APIGatewayProxyHandler = async (event) => {
  if (!isPremium(event)) {
    return { statusCode: 403, headers: HEADERS, body: JSON.stringify({ error: 'Premium subscription required' }) };
  }

  const yokai_id = event.pathParameters?.id;
  if (!yokai_id) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'id required' }) };
  }

  const result = await ddb.send(new GetCommand({ TableName: CORE_TABLE, Key: { yokai_id } }));
  if (!result.Item || result.Item.published !== 'true') {
    return { statusCode: 404, headers: HEADERS, body: JSON.stringify({ error: 'Not found' }) };
  }

  return { statusCode: 200, headers: HEADERS, body: JSON.stringify(result.Item) };
};
