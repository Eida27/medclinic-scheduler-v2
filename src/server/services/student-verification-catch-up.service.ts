import "server-only";
import type { PoolClient } from "pg";

/** Task 3 supplies authoritative state loading and idempotent notification content here. */
export async function queueFirstVerificationCurrentStateCatchUp(
  _client: PoolClient,
  _studentNumber: string,
) {
  void _client;
  void _studentNumber;
  // Intentionally empty until the authoritative schedule-state engine is available.
}
