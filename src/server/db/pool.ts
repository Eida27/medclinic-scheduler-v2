import "server-only";
import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { serverEnv } from "@/lib/env";

declare global {
  var __medclinicPool: Pool | undefined;
}

export const pool = globalThis.__medclinicPool ?? new Pool({ connectionString: serverEnv().DATABASE_URL });
if (process.env.NODE_ENV !== "production") globalThis.__medclinicPool = pool;

export async function query<T extends QueryResultRow>(text: string, values: unknown[] = []) {
  return pool.query<T>(text, values);
}

export async function transaction<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
