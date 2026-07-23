import "server-only";
import type { PoolClient } from "pg";

export type EffectiveAppointmentScope = {
  studentNumber: string;
  scheduleType: string;
};

const LOCK_NAMESPACE = "medclinic:effective-appointment:v1";

function scopeLockKey(scope: EffectiveAppointmentScope) {
  return `${LOCK_NAMESPACE}:${scope.scheduleType}:${scope.studentNumber}`;
}

export async function lockEffectiveAppointmentScopes(
  client: PoolClient,
  scopes: EffectiveAppointmentScope[],
) {
  const keys = [...new Set(scopes.map(scopeLockKey))].sort();
  for (const key of keys) {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [key],
    );
  }
}
