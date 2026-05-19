import type { APIGatewayProxyHandler } from 'aws-lambda';
import { randomUUID } from 'crypto';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, RESEARCH_TABLE } from '../lib/dynamodb';
import { resolveRole } from '../lib/auth';
import type { ResearchDBItem, ResearchSource, SourceType } from '../types/research';

const HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
};

const VALID_SOURCE_TYPES: SourceType[] = ['academic', 'web', 'oral', 'image'];

export const handler: APIGatewayProxyHandler = async (event) => {
  const role = resolveRole(event);
  if (!role) {
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

  // system ロールは body の collector_id を尊重する（ルーティン識別に使用）
  const defaultCollectorId = role === 'system' ? 'system:claude' : 'admin:curator';
  const collectorId =
    role === 'system' && typeof body.collector_id === 'string' && body.collector_id.trim()
      ? body.collector_id.trim()
      : defaultCollectorId;

  const now = new Date().toISOString();
  const item: ResearchDBItem = {
    research_id: randomUUID(),
    status: 'pending',
    yokai_name: yokai_name.trim(),
    collector_id: collectorId,
    collected_at: now,
  };

  if (typeof body.notes === 'string')      item.notes = body.notes;
  if (typeof body.place_name === 'string') item.place_name = body.place_name;
  if (typeof body.source_url === 'string' && body.source_url.trim()) item.source_url = body.source_url.trim();
  if (typeof body.source_type === 'string' && VALID_SOURCE_TYPES.includes(body.source_type as SourceType)) {
    item.source_type = body.source_type as SourceType;
  }
  if (typeof body.raw_content === 'string')        item.raw_content = body.raw_content;
  if (typeof body.summary === 'string')            item.summary = body.summary;
  if (typeof body.reliability_score === 'number')  item.reliability_score = body.reliability_score;
  if (typeof body.originality_score === 'number')  item.originality_score = body.originality_score;
  if (typeof body.latitude === 'number')           item.latitude = body.latitude;
  if (typeof body.longitude === 'number')          item.longitude = body.longitude;
  if (Array.isArray(body.media_attachments))       item.media_attachments = body.media_attachments as string[];
  if (Array.isArray(body.sources)) {
    item.sources = (body.sources as ResearchSource[]).filter(
      s => s && typeof s.url === 'string' && s.url.trim()
    );
  }

  await ddb.send(new PutCommand({ TableName: RESEARCH_TABLE, Item: item }));

  return {
    statusCode: 201,
    headers: HEADERS,
    body: JSON.stringify({ ok: true, research_id: item.research_id }),
  };
};
