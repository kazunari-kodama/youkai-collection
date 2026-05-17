import type { APIGatewayProxyEvent } from 'aws-lambda';

export type Role = 'system' | 'curator';

const ADMIN_KEY  = process.env.ADMIN_KEY!;
const SYSTEM_KEY = process.env.SYSTEM_KEY!;

/**
 * Resolve caller role from request headers.
 * X-System-Key → 'system'  (automated pipelines)
 * X-Admin-Key  → 'curator' (CMS / human operators)
 * Neither match → null (unauthorized)
 */
export function resolveRole(event: APIGatewayProxyEvent): Role | null {
  const h = event.headers;
  const systemKey = h['x-system-key'] ?? h['X-System-Key'];
  const adminKey  = h['x-admin-key']  ?? h['X-Admin-Key'];
  if (systemKey && systemKey === SYSTEM_KEY) return 'system';
  if (adminKey  && adminKey  === ADMIN_KEY)  return 'curator';
  return null;
}
