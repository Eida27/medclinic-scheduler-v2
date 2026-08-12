import "server-only";
import type { PoolClient } from "pg";
import { query } from "@/server/db/pool";

export type AuditInput = {
  actorUserId: string;
  action: string;
  entityType: string;
  entityId: string | null;
  metadata?: Record<string, unknown>;
};

export async function writeAudits(client: PoolClient, inputs: AuditInput[]) {
  if (!inputs.length) return;
  await client.query(
    `INSERT INTO audit_logs (actor_user_id,action,entity_type,entity_id,metadata)
     SELECT row.actor_user_id,row.action,row.entity_type,row.entity_id,row.metadata
       FROM jsonb_to_recordset($1::jsonb) AS row(
         actor_user_id uuid,action text,entity_type text,entity_id text,metadata jsonb
       )`,
    [JSON.stringify(inputs.map((input) => ({
      actor_user_id: input.actorUserId,
      action: input.action,
      entity_type: input.entityType,
      entity_id: input.entityId,
      metadata: input.metadata ?? {},
    })))],
  );
}

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
