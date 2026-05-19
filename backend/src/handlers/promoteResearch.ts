import type { APIGatewayProxyHandler } from 'aws-lambda';
import { randomUUID } from 'crypto';
import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, RESEARCH_TABLE, CORE_TABLE } from '../lib/dynamodb';
import { resolveRole } from '../lib/auth';

const HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
};

export const handler: APIGatewayProxyHandler = async (event) => {
  const role = resolveRole(event);
  if (role !== 'curator') {
    return { statusCode: 401, headers: HEADERS, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  const research_id = event.pathParameters?.id;
  if (!research_id) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'id required' }) };
  }

  const current = await ddb.send(new GetCommand({ TableName: RESEARCH_TABLE, Key: { research_id } }));
  if (!current.Item) {
    return { statusCode: 404, headers: HEADERS, body: JSON.stringify({ error: 'Not found' }) };
  }

  if (current.Item.status !== 'reviewing') {
    return {
      statusCode: 400,
      headers: HEADERS,
      body: JSON.stringify({ error: `Cannot promote: status is ${current.Item.status}, must be reviewing` }),
    };
  }

  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    // body is optional for promote
  }

  const now = new Date().toISOString();
  const yokai_id: string =
    typeof body.yokai_id === 'string' && body.yokai_id.trim()
      ? body.yokai_id.trim()
      : randomUUID();

  const gameVisible =
    typeof body.game_visible === 'boolean'
      ? body.game_visible
      : body.game_visible === 'true';

  // notes: research.notes が優先、なければ旧 summary にフォールバック
  const resolvedNotes = current.Item.notes ?? current.Item.summary;

  const coreItem: Record<string, unknown> = {
    yokai_id,
    published: 'true',
    created_at: now,
    updated_at: now,
    name: current.Item.yokai_name,
    source_research_id: research_id,
    ...(gameVisible ? { game_visible: 'true' } : {}),
  };
  if (resolvedNotes)                              coreItem.notes = resolvedNotes;
  if (current.Item.place_name)                    coreItem.place_name = current.Item.place_name;
  if (current.Item.source_url)                    coreItem.source_url = current.Item.source_url;
  if (current.Item.source_type)                   coreItem.source_type = current.Item.source_type;
  if (current.Item.raw_content)                   coreItem.raw_content = current.Item.raw_content;
  if (current.Item.reliability_score != null)     coreItem.reliability_score = current.Item.reliability_score;
  if (current.Item.originality_score != null)     coreItem.originality_score = current.Item.originality_score;
  if (current.Item.latitude != null)              coreItem.latitude = current.Item.latitude;
  if (current.Item.longitude != null)             coreItem.longitude = current.Item.longitude;
  if (current.Item.media_attachments)             coreItem.images = current.Item.media_attachments;
  if (Array.isArray(current.Item.sources) && current.Item.sources.length > 0)
                                                   coreItem.sources = current.Item.sources;

  await ddb.send(new PutCommand({ TableName: CORE_TABLE, Item: coreItem }));

  // Mark research as approved
  await ddb.send(
    new UpdateCommand({
      TableName: RESEARCH_TABLE,
      Key: { research_id },
      UpdateExpression: 'SET #s = :s, promoted_to = :pid, reviewed_by = :rb, reviewed_at = :ra',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: {
        ':s': 'approved',
        ':pid': yokai_id,
        ':rb': 'curator',
        ':ra': now,
      },
    }),
  );

  return {
    statusCode: 200,
    headers: HEADERS,
    body: JSON.stringify({ ok: true, yokai_id, research_id }),
  };
};
