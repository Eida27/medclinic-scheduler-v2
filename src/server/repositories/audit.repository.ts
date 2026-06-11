import "server-only";
import type { PoolClient } from "pg";
import { query } from "@/server/db/pool";

export async function writeAudit(
  actorUserId: string,
  action: string,
  entityType: string,
  entityId: string | null,
  metadata: Record<string, unknown> = {},
  client?: PoolClient,
) {
  const sql = `INSERT INTO audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
               VALUES ($1, $2, $3, $4, $5::jsonb)`;
  const values = [actorUserId, action, entityType, entityId, JSON.stringify(metadata)];
  return client ? client.query(sql, values) : query(sql, values);
}
