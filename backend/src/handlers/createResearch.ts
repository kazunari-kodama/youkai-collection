import type { APIGatewayProxyHandler } from 'aws-lambda';
import { randomUUID } from 'crypto';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, RESEARCH_TABLE } from '../lib/dynamodb';
import type { ResearchDBItem, SourceType } from '../types/research';

const HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
};

const ADMIN_KEY = process.env.ADMIN_KEY!;
const SYSTEM_KEY = process.env.SYSTEM_KEY!;

const VALID_SOURCE_TYPES: SourceType[] = ['academic', 'web', 'oral', 'image'];

export const handler: APIGatewayProxyHandler = async (event) => {
  const adminKey = event.headers['x-admin-key'] ?? event.headers['X-Admin-Key'];
  const systemKey = event.headers['x-system-key'] ?? event.headers['X-System-Key'];

  const isAdmin = adminKey === ADMIN_KEY;
  const isSystem = systemKey === SYSTEM_KEY;

  if (!isAdmin && !isSystem) {
    return { statusCode: 401, headers: HEADERS, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { yokai_name } = body;
  if (!yokai_name || typeof yokai_name !== 'string' || !yokai_name.trim()) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'yokai_name required' }) };
  }

  const now = new Date().toISOString();
  const item: ResearchDBItem = {
    research_id: randomUUID(),
    status: 'pending',
    yokai_name: yokai_name.trim(),
    collector_id: isSystem ? 'system:claude' : 'admin:curator',
    collected_at: now,
  };

  if (typeof body.source_url === 'string' && body.source_url.trim()) item.source_url = body.source_url.trim();
  if (typeof body.source_type === 'string' && VALID_SOURCE_TYPES.includes(body.source_type as SourceType)) {
    item.source_type = body.source_type as SourceType;
  }
  if (typeof body.raw_content === 'string') item.raw_content = body.raw_content;
  if (typeof body.summary === 'string') item.summary = body.summary;
  if (typeof body.reliability_score === 'number') item.reliability_score = body.reliability_score;
  if (typeof body.originality_score === 'number') item.originality_score = body.originality_score;
  if (Array.isArray(body.media_attachments)) item.media_attachments = body.media_attachments as string[];

  await ddb.send(new PutCommand({ TableName: RESEARCH_TABLE, Item: item }));

  return {
    statusCode: 201,
    headers: HEADERS,
    body: JSON.stringify({ ok: true, research_id: item.research_id }),
  };
};
