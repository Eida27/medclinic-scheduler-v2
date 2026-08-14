// @vitest-environment node
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { pool } from "./pool";

const migrationPath = join(
  process.cwd(),
  "database/migrations/021_clinic_closure_recovery_policy.sql",
);

afterAll(async () => {
  await pool.end();
});

describe("clinic closure recovery policy migration", () => {
  it("adds policy context, warning metadata, and recovery reservation kinds", async () => {
    const migration = await readFile(migrationPath, "utf8");
    await expect(pool.query(migration)).resolves.toBeDefined();

    const columns = await pool.query<{ table_name: string; column_name: string }>(
      `SELECT table_name,column_name
         FROM information_schema.columns
        WHERE table_schema=current_schema()
          AND (table_name,column_name) IN (
            ('clinic_closure_groups','recovery_mode'),
            ('clinic_closure_groups','policy_effective_date'),
            ('clinic_closure_manual_cases','policy_metadata'),
            ('appointment_reschedule_events','policy_metadata'),
            ('ovpsa_first_year_service_reservations','reservation_kind')
          )
        ORDER BY table_name,column_name`,
    );

    expect(columns.rows).toHaveLength(5);
    await expect(pool.query(
      `SELECT 1
         FROM clinic_closure_groups
        WHERE recovery_mode<>'AUTO_ELIGIBLE'
           OR policy_effective_date<>(created_at AT TIME ZONE 'Asia/Manila')::date
        LIMIT 1`,
    )).resolves.toMatchObject({ rowCount: 0 });
  });

  it("makes the persisted closure policy context immutable", async () => {
    const client = await pool.connect();
    await client.query("BEGIN");
    try {
      const actorId = randomUUID();
      await client.query(
        `INSERT INTO users (id,full_name,email,password_hash,role)
         VALUES ($1,'Policy Migration Actor',$2,'migration-hash','ADMIN')`,
        [actorId, `policy-${actorId}@example.test`],
      );
      const group = await client.query<{ id: string }>(
        `INSERT INTO clinic_closure_groups (
           start_date,end_date,category,reason,created_by,creation_batch_id,
           recovery_mode,policy_effective_date
         ) VALUES ('2097-08-01','2097-08-01','CLOSURE','Policy fixture',$1,$2,
                   'AUTO_ELIGIBLE','2097-06-01')
         RETURNING id::text`,
        [actorId, randomUUID()],
      );

      await expect(client.query(
        `UPDATE clinic_closure_groups
            SET recovery_mode='MANUAL_ALL'
          WHERE id=$1`,
        [group.rows[0].id],
      )).rejects.toMatchObject({ code: "23514" });
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  it("reserves exclusive dates only for EXCLUSIVE OVPSA reservations", async () => {
    const indexes = await pool.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname,indexdef
         FROM pg_indexes
        WHERE schemaname=current_schema()
          AND indexname IN (
            'ovpsa_first_year_active_reservation_owner_idx',
            'ovpsa_first_year_revision_service_date_idx',
            'ovpsa_first_year_revision_laboratory_idx'
          )
        ORDER BY indexname`,
    );

    expect(indexes.rows).toHaveLength(3);
    for (const index of indexes.rows) {
      expect(index.indexdef).toContain("reservation_kind");
      expect(index.indexdef).toContain("EXCLUSIVE");
    }
  });
});
