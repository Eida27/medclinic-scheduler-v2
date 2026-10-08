// @vitest-environment node
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PoolClient } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { pool } from "@/server/db/pool";

const migrationPath = join(process.cwd(), "database/migrations/028_final_defense_clinical_workflows.sql");
const actor = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const clinic = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const snapshot = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

// Only the pre-028 contracts referenced by this migration; the separate empty-database
// rehearsal verifies the same migration against the entire production chain.
async function isolated(callback: (client: PoolClient) => Promise<void>, migrate = true) {
  const client = await pool.connect();
  const schema = `clinical_schema_${randomUUID().replaceAll("-", "_")}`;
  try {
    await client.query(`CREATE SCHEMA ${schema}; SET search_path TO ${schema},public`);
    await client.query(`
      CREATE TABLE users (id uuid PRIMARY KEY);
      CREATE TABLE students (student_number varchar(20) PRIMARY KEY);
      CREATE TABLE academic_years (start_year integer PRIMARY KEY, closing_date date NOT NULL);
      CREATE TABLE student_academic_snapshots (id uuid PRIMARY KEY, student_number varchar(20), academic_year_start integer, year_level integer);
      CREATE TABLE appointments (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), student_number varchar(20) NOT NULL,
        schedule_type varchar(30) NOT NULL, schedule_cycle_start integer, scheduling_category varchar(30),
        clinic_id uuid NOT NULL, appointment_date date NOT NULL DEFAULT '2026-09-23', status varchar(30) NOT NULL DEFAULT 'PENDING',
        is_published boolean NOT NULL DEFAULT false, rescheduled_from uuid REFERENCES appointments(id), ovpsa_batch_id uuid,
        schedule_pair_id uuid, created_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE laboratory_results (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), appointment_id uuid);
      CREATE TABLE exam_results (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), appointment_id uuid UNIQUE REFERENCES appointments(id),
        student_number varchar(20), result_status varchar(30) DEFAULT 'PENDING_UPLOAD', completed_at date,
        CONSTRAINT exam_results_result_status_check CHECK (result_status IN ('PENDING_UPLOAD','COMPLETED','REQUIRES_FOLLOW_UP','NOT_APPLICABLE')));
      CREATE TABLE student_result_submissions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), appointment_id uuid, student_number varchar(20), result_type varchar(30),
        CONSTRAINT student_result_submissions_result_type_check CHECK (result_type IN ('LABORATORY','PHYSICAL_EXAM')));
      CREATE TABLE ovpsa_external_laboratory_verifications (appointment_id uuid);
      INSERT INTO users VALUES ('${actor}');
      INSERT INTO students VALUES ('S1'),('S2');
      INSERT INTO academic_years VALUES (2026,'2027-05-10'),(2025,'2026-05-10');
      INSERT INTO student_academic_snapshots VALUES ('${snapshot}','S1',2026,2), (gen_random_uuid(),'S2',2026,2);
    `);
    if (migrate) await client.query(await readFile(migrationPath, "utf8"));
    await callback(client);
  } finally {
    await client.query("ROLLBACK");
    await client.query("SET search_path TO public");
    await client.query(`DROP SCHEMA ${schema} CASCADE`);
    client.release();
  }
}

async function appointment(client: PoolClient, service = "LABORATORY", published = true) {
  const result = await client.query<{ id: string }>(`INSERT INTO appointments
    (student_number,schedule_type,schedule_cycle_start,scheduling_category,clinic_id,is_published)
    VALUES ('S1',$1,2026,'REGULAR',$2,$3) RETURNING id`, [service, clinic, published]);
  return result.rows[0].id;
}

async function checklist(client: PoolClient, appointmentId: string) {
  const result = await client.query<{ id: string }>(`INSERT INTO laboratory_checklists
    (root_appointment_id,student_number,academic_year_start,academic_snapshot_id,year_level_snapshot,scheduling_category_snapshot)
    VALUES ($1,'S1',2026,$2,2,'REGULAR') RETURNING id`, [appointmentId, snapshot]);
  const id = result.rows[0].id;
  await client.query("INSERT INTO laboratory_checklist_appointments VALUES ($1,$2)", [appointmentId, id]);
  await client.query("INSERT INTO laboratory_checklist_items (checklist_id,test_code) VALUES ($1,'CBC'),($1,'URINE'),($1,'STOOL')", [id]);
  return id;
}

async function issue(client: PoolClient, appointmentId: string, classification = "A", remarks: string | null = null) {
  const physician = randomUUID();
  const revision = randomUUID();
  await client.query("INSERT INTO medical_certificate_physicians (id) VALUES ($1)", [physician]);
  await client.query(`INSERT INTO medical_certificate_physician_revisions
    (id,physician_id,version,display_name,license_number,signature_bytes,signature_media_type,actor_user_id,actor_snapshot)
    VALUES ($1,$2,1,'Dr Example','LIC-1',$3,'image/png',$4,'{"name":"Admin"}')`, [revision, physician, Buffer.from("signature"), actor]);
  const result = await client.query<{ id: string }>(`INSERT INTO medical_certificate_revisions
    (certificate_id,appointment_id,student_number,academic_year_start,revision_number,physician_revision_id,
     student_snapshot,examination_snapshot,physician_snapshot,classification,remarks,examination_date,sex,template_version,
     jpeg_bytes,byte_length,sha256,issued_by,issued_by_snapshot,request_id)
    VALUES (gen_random_uuid(),$1,'S1',2026,1,$2,'{"name":"Student"}','{"attested":true}','{"name":"Dr Example"}',
      $5,$6,'2026-09-23','Female','1',$3::bytea,3,encode(digest($3::bytea,'sha256'),'hex'),$4,'{"name":"Admin"}',gen_random_uuid()) RETURNING id`,
    [appointmentId, revision, Buffer.from([0xff, 0xd8, 0xff]), actor, classification, remarks]);
  await client.query("UPDATE appointments SET status='COMPLETED' WHERE id=$1", [appointmentId]);
  await client.query("INSERT INTO exam_results (appointment_id,student_number,result_status,completed_at) VALUES ($1,'S1','COMPLETED','2026-09-23')", [appointmentId]);
  return result.rows[0].id;
}

afterAll(async () => { await pool.end(); });

describe("final-defense clinical database invariants", () => {
  it("links published Laboratory roots and replacements to one requirement snapshot", async () => isolated(async (client) => {
    const { linkPublishedLaboratoryAppointments } = await import("@/server/laboratory/laboratory-checklist.repository");
    await client.query("BEGIN");
    const root = await appointment(client);
    await linkPublishedLaboratoryAppointments(client, [root]);
    await client.query("COMMIT");
    const created = await client.query<{ checklist_id: string; test_code: string }>(`SELECT link.checklist_id,item.test_code
      FROM laboratory_checklist_appointments link JOIN laboratory_checklist_items item ON item.checklist_id=link.checklist_id
      WHERE link.appointment_id=$1 ORDER BY item.test_code`, [root]);
    expect(created.rows.map((row) => row.test_code)).toEqual(["CBC", "STOOL", "URINE"]);
    await client.query("BEGIN");
    await client.query("UPDATE appointments SET status='RESCHEDULED' WHERE id=$1", [root]);
    const replacement = await appointment(client);
    await client.query("UPDATE appointments SET rescheduled_from=$1 WHERE id=$2", [root, replacement]);
    await linkPublishedLaboratoryAppointments(client, [replacement]);
    await client.query("COMMIT");
    const inherited = await client.query<{ checklist_id: string }>("SELECT checklist_id FROM laboratory_checklist_appointments WHERE appointment_id=$1", [replacement]);
    expect(inherited.rows[0].checklist_id).toBe(created.rows[0].checklist_id);
  }));

  it("rejects published Laboratory without a checklist at commit", async () => isolated(async (client) => {
    await client.query("BEGIN");
    await appointment(client);
    await expect(client.query("COMMIT")).rejects.toMatchObject({ code: "23514" });
  }));

  it("accepts publication and checklist creation in the same transaction", async () => isolated(async (client) => {
    await client.query("BEGIN");
    await checklist(client, await appointment(client));
    await expect(client.query("COMMIT")).resolves.toBeDefined();
  }));

  it("rejects missing required tests and non-applicable X-ray", async () => isolated(async (client) => {
    await client.query("BEGIN");
    const id = await checklist(client, await appointment(client));
    await client.query("DELETE FROM laboratory_checklist_items WHERE checklist_id=$1 AND test_code='STOOL'", [id]);
    await expect(client.query("COMMIT")).rejects.toMatchObject({ code: "23514" });
    await client.query("BEGIN");
    const other = await checklist(client, await appointment(client));
    await client.query("INSERT INTO laboratory_checklist_items (checklist_id,test_code) VALUES ($1,'XRAY')", [other]);
    await expect(client.query("COMMIT")).rejects.toMatchObject({ code: "23514" });
  }));

  it("rejects completion before all required items are verified", async () => isolated(async (client) => {
    await client.query("BEGIN");
    const id = await appointment(client);
    await checklist(client, id);
    await client.query("UPDATE appointments SET status='COMPLETED' WHERE id=$1", [id]);
    await expect(client.query("COMMIT")).rejects.toMatchObject({ code: "23514" });
  }));

  it.each([{ year: 4, category: "OJT" }, { year: 1, category: "REGULAR" }])(
    "keeps all four tests required at commit for $year/$category", async ({ year, category }) => isolated(async (client) => {
      await client.query("UPDATE student_academic_snapshots SET year_level=$1 WHERE id=$2", [year, snapshot]);
      await client.query("BEGIN");
      const appointmentId = await appointment(client);
      await client.query("UPDATE appointments SET scheduling_category=$1 WHERE id=$2", [category, appointmentId]);
      const result = await client.query<{ id: string }>(`INSERT INTO laboratory_checklists
        (root_appointment_id,student_number,academic_year_start,academic_snapshot_id,year_level_snapshot,scheduling_category_snapshot)
        VALUES ($1,'S1',2026,$2,$3,$4) RETURNING id`, [appointmentId, snapshot, year, category]);
      const checklistId = result.rows[0].id;
      await client.query("INSERT INTO laboratory_checklist_appointments VALUES ($1,$2)", [appointmentId, checklistId]);
      await client.query("INSERT INTO laboratory_checklist_items(checklist_id,test_code) VALUES ($1,'CBC'),($1,'URINE'),($1,'STOOL'),($1,'XRAY')", [checklistId]);
      await client.query("COMMIT");
      await client.query("BEGIN");
      await client.query("UPDATE laboratory_checklist_items SET verified_at=now(),verified_by=$2,verification_source='INTERNAL' WHERE checklist_id=$1 AND test_code<>'XRAY'", [checklistId, actor]);
      await client.query("UPDATE appointments SET status='COMPLETED' WHERE id=$1", [appointmentId]);
      await expect(client.query("COMMIT")).rejects.toMatchObject({ code: "23514" });
    }));

  it("completes the replacement while retaining its predecessor's historical status", async () => isolated(async (client) => {
    await client.query("BEGIN");
    const original = await appointment(client);
    const id = await checklist(client, original);
    await client.query("UPDATE appointments SET status='RESCHEDULED' WHERE id=$1", [original]);
    const replacement = await appointment(client);
    await client.query("UPDATE appointments SET rescheduled_from=$1,status='COMPLETED' WHERE id=$2", [original, replacement]);
    await client.query("INSERT INTO laboratory_checklist_appointments VALUES ($1,$2)", [replacement, id]);
    await client.query("UPDATE laboratory_checklist_items SET verified_at=now(),verified_by=$2,verification_source='INTERNAL' WHERE checklist_id=$1", [id, actor]);
    await expect(client.query("COMMIT")).resolves.toBeDefined();
    expect((await client.query("SELECT status FROM appointments WHERE id=$1", [original])).rows[0].status).toBe("RESCHEDULED");
    await expect(client.query("UPDATE laboratory_checklists SET year_level_snapshot=1 WHERE id=$1", [id])).rejects.toMatchObject({ code: "23514" });
  }));

  it("rejects links to another student's appointment", async () => isolated(async (client) => {
    await client.query("BEGIN");
    const id = await checklist(client, await appointment(client));
    const wrong = await appointment(client);
    await client.query("UPDATE appointments SET student_number='S2' WHERE id=$1", [wrong]);
    await client.query("INSERT INTO laboratory_checklist_appointments VALUES ($1,$2)", [wrong, id]);
    await expect(client.query("COMMIT")).rejects.toMatchObject({ code: "23514", message: expect.stringContaining("lineage mismatch") });
  }));

  it("rejects a requirement snapshot that disagrees with immutable academic provenance", async () => isolated(async (client) => {
    await client.query("BEGIN");
    const id = await appointment(client);
    const result = await client.query<{ id: string }>(`INSERT INTO laboratory_checklists
      (root_appointment_id,student_number,academic_year_start,academic_snapshot_id,year_level_snapshot,scheduling_category_snapshot)
      VALUES ($1,'S1',2026,$2,1,'REGULAR') RETURNING id`, [id, snapshot]);
    const checklistId = result.rows[0].id;
    await client.query("INSERT INTO laboratory_checklist_appointments VALUES ($1,$2)", [id, checklistId]);
    await client.query("INSERT INTO laboratory_checklist_items (checklist_id,test_code) VALUES ($1,'CBC'),($1,'URINE'),($1,'STOOL'),($1,'XRAY')", [checklistId]);
    await expect(client.query("COMMIT")).rejects.toMatchObject({ code: "23514", message: expect.stringContaining("provenance mismatch") });
  }));

  it("rejects Laboratory-labelled submissions for a PE appointment, including later service changes", async () => isolated(async (client) => {
    const pe = await appointment(client, "PHYSICAL_EXAM");
    await expect(client.query("INSERT INTO student_result_submissions (appointment_id,student_number,result_type) VALUES ($1,'S1','LABORATORY')", [pe]))
      .rejects.toMatchObject({ code: "23514", message: expect.stringContaining("submission appointment mismatch") });
    const lab = await appointment(client, "LABORATORY", false);
    await client.query("INSERT INTO student_result_submissions (appointment_id,student_number,result_type) VALUES ($1,'S1','LABORATORY')", [lab]);
    await expect(client.query("UPDATE appointments SET schedule_type='PHYSICAL_EXAM' WHERE id=$1", [lab]))
      .rejects.toMatchObject({ code: "23514", message: expect.stringContaining("submission appointment mismatch") });
  }));

  it("rechecks a checklist when a required item is moved away", async () => isolated(async (client) => {
    await client.query("BEGIN");
    const first = await checklist(client, await appointment(client));
    const second = await checklist(client, await appointment(client));
    await client.query("COMMIT");
    await client.query("BEGIN");
    await client.query("DELETE FROM laboratory_checklist_items WHERE checklist_id=$1 AND test_code='CBC'", [second]);
    await client.query("UPDATE laboratory_checklist_items SET checklist_id=$2 WHERE checklist_id=$1 AND test_code='CBC'", [first, second]);
    await expect(client.query("COMMIT")).rejects.toMatchObject({ code: "23514", message: expect.stringContaining("required test set mismatch") });
  }));

  it("keeps restored Laboratory and PE sources clinically checked after a cancelled child", async () => isolated(async (client) => {
    await client.query("BEGIN");
    const lab = await appointment(client);
    const checklistId = await checklist(client, lab);
    const pe = await appointment(client, "PHYSICAL_EXAM");
    await client.query("COMMIT");
    await client.query("BEGIN");
    const cancelled = await appointment(client);
    await client.query("UPDATE appointments SET status='CANCELLED',rescheduled_from=$1 WHERE id=$2", [lab, cancelled]);
    await client.query("INSERT INTO laboratory_checklist_appointments VALUES ($1,$2)", [cancelled, checklistId]);
    await client.query("UPDATE laboratory_checklist_items SET verified_at=now(),verified_by=$2,verification_source='INTERNAL' WHERE checklist_id=$1", [checklistId, actor]);
    await expect(client.query("COMMIT")).rejects.toMatchObject({ code: "23514", message: expect.stringContaining("Laboratory completion") });
    await client.query("BEGIN");
    const cancelledPe = await appointment(client, "PHYSICAL_EXAM");
    await client.query("UPDATE appointments SET status='CANCELLED',rescheduled_from=$1 WHERE id=$2", [pe, cancelledPe]);
    await client.query("UPDATE appointments SET status='COMPLETED' WHERE id=$1", [pe]);
    await expect(client.query("COMMIT")).rejects.toMatchObject({ code: "23514", message: expect.stringContaining("examination completion") });
  }));

  it("requires all verification fields together and keeps events append-only", async () => isolated(async (client) => {
    await client.query("BEGIN");
    const appointmentId = await appointment(client);
    const id = await checklist(client, appointmentId);
    await client.query("COMMIT");
    await expect(client.query("UPDATE laboratory_checklist_items SET verified_at=now() WHERE checklist_id=$1 AND test_code='CBC'", [id])).rejects.toMatchObject({ code: "23514" });
    const event = await client.query<{ id: string }>(`INSERT INTO laboratory_checklist_events
      (checklist_id,appointment_id,test_code,old_verified,new_verified,source,actor_user_id,actor_snapshot)
      VALUES ($1,$2,'CBC',false,true,'INTERNAL',$3,'{"name":"Admin"}') RETURNING id`, [id, appointmentId, actor]);
    await expect(client.query("DELETE FROM laboratory_checklist_events WHERE id=$1", [event.rows[0].id])).rejects.toMatchObject({ code: "23514" });
  }));

  it("blocks generic examination completion and legacy uploads", async () => isolated(async (client) => {
    await client.query("BEGIN");
    const id = await appointment(client, "PHYSICAL_EXAM");
    await client.query("UPDATE appointments SET status='COMPLETED' WHERE id=$1", [id]);
    await expect(client.query("COMMIT")).rejects.toMatchObject({ code: "23514" });
    await expect(client.query("INSERT INTO student_result_submissions (result_type) VALUES ('PHYSICAL_EXAM')")).rejects.toMatchObject({ code: "23514" });
    await expect(client.query("INSERT INTO exam_results (result_status) VALUES ('PENDING_UPLOAD')")).rejects.toMatchObject({ code: "23514" });
  }));

  it("commits matching issuance atomically and protects issued bytes", async () => isolated(async (client) => {
    await client.query("BEGIN");
    const id = await appointment(client, "PHYSICAL_EXAM");
    const certificate = await issue(client, id);
    await expect(client.query("COMMIT")).resolves.toBeDefined();
    await expect(client.query(`INSERT INTO medical_certificate_revisions
      (id,certificate_id,appointment_id,student_number,academic_year_start,revision_number,supersedes_revision_id,status,
       physician_revision_id,student_snapshot,examination_snapshot,physician_snapshot,classification,remarks,
       examination_date,sex,template_version,jpeg_bytes,byte_length,sha256,issued_by,issued_by_snapshot,issued_at,request_id) SELECT
      gen_random_uuid(),certificate_id,appointment_id,student_number,academic_year_start,revision_number+1,id,status,
      physician_revision_id,student_snapshot,examination_snapshot,physician_snapshot,classification,remarks,
      examination_date,sex,template_version,jpeg_bytes,byte_length,sha256,issued_by,issued_by_snapshot,issued_at,gen_random_uuid()
      FROM medical_certificate_revisions WHERE id=$1`, [certificate])).rejects.toMatchObject({ code: "23505" });
    await expect(client.query("UPDATE medical_certificate_revisions SET jpeg_bytes=$1 WHERE id=$2", [Buffer.from("new"), certificate])).rejects.toMatchObject({ code: "23514" });
    await client.query("BEGIN");
    await client.query("UPDATE medical_certificate_revisions SET status='REVOKED' WHERE id=$1", [certificate]);
    await expect(client.query("COMMIT")).rejects.toMatchObject({ code: "23514" });
    await client.query("BEGIN");
    await client.query("UPDATE medical_certificate_revisions SET status='REVOKED' WHERE id=$1", [certificate]);
    await client.query("UPDATE appointments SET status='PENDING' WHERE id=$1", [id]);
    await client.query("UPDATE exam_results SET result_status='REQUIRES_FOLLOW_UP' WHERE appointment_id=$1", [id]);
    await expect(client.query("COMMIT")).resolves.toBeDefined();
  }));

  it("allows multiline findings for a non-Class-A certificate", async () => isolated(async (client) => {
    await client.query("BEGIN");
    await issue(client, await appointment(client, "PHYSICAL_EXAM"), "B", "Follow up with clinic\nBring records");
    await expect(client.query("COMMIT")).resolves.toBeDefined();
  }));

  it("refuses pre-existing clinical data without fabricating evidence", async () => isolated(async (client) => {
    await appointment(client);
    await expect(client.query(await readFile(migrationPath, "utf8"))).rejects.toThrow(/unsupported-preexisting-clinical-data/);
  }, false));

  it("counts internal capacity holds across years without counting superseded or external appointments", async () => isolated(async (client) => {
    const { getInternalOccupancy } = await import("@/server/schedule/scheduling-occupancy.repository");
    for (const status of ["DRAFT", "PENDING", "COMPLETED", "NO_SHOW", "CANCELLED", "RESCHEDULED", "AWAITING_RESCHEDULE"]) {
      const id = await appointment(client, "LABORATORY", false);
      await client.query("UPDATE appointments SET status=$1,schedule_cycle_start=2025 WHERE id=$2", [status, id]);
    }
    const external = await appointment(client, "LABORATORY", false);
    await client.query("UPDATE appointments SET ovpsa_batch_id=gen_random_uuid() WHERE id=$1", [external]);
    const original = await appointment(client, "LABORATORY", false);
    const replacement = await appointment(client, "LABORATORY", false);
    await client.query("UPDATE appointments SET rescheduled_from=$1 WHERE id=$2", [original, replacement]);
    await appointment(client, "PHYSICAL_EXAM", false);
    expect(await getInternalOccupancy(client, "2026-09-23", clinic, "LABORATORY")).toBe(5);
    expect(await getInternalOccupancy(client, "2026-09-23", clinic, "PHYSICAL_EXAM")).toBe(1);
    expect(await getInternalOccupancy(client, "2026-09-24", clinic, "LABORATORY")).toBe(0);
  }));
});
