// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool, transaction } from "@/server/db/pool";
import { linkPublishedLaboratoryAppointments } from "@/server/laboratory/laboratory-checklist.repository";
import { cleanupTestFixtures, insertTestAcademicSnapshot, insertTestStudent, TEST_REFERENCE_IDS } from "@/test/integration-fixtures";
import * as repository from "./student-result-submissions.repository";

const owner = "TEST-LAB-READ-01";
const foreign = "TEST-LAB-READ-02";
const pattern = "TEST-LAB-READ-%";
const years: number[] = [];
const allowed: string[] = [];
const excluded: string[] = [];
let currentYear: number;
let officialId: string;
let officialAppointmentId: string;
let officialDate: string;
let historicalId: string;
let newerHistoricalId: string;

async function createSubmission(input: {
  year: number; name: string; status?: "DRAFT" | "FINALIZED" | "SUPERSEDED" | "INVALIDATED";
  appointmentOwner?: string; submissionOwner?: string; appointmentType?: string; resultType?: string;
  appointmentId?: string; basedOn?: string; discarded?: boolean; deleted?: boolean; pending?: boolean;
  day?: number; fileId?: string; uploadedAt?: string;
}) {
  return transaction(async (client) => {
    const date = `${input.year}-09-${String(input.day ?? 1).padStart(2, "0")}`;
    let appointmentId = input.appointmentId;
    if (!appointmentId) {
      const appointment = await client.query<{ id: string }>(
        `INSERT INTO appointments (clinic_id,student_number,schedule_type,appointment_date,status,
           is_published,schedule_cycle_start,scheduling_category,created_by,updated_by)
         VALUES ($1,$2,$3,$4,'COMPLETED',TRUE,$5,'REGULAR',$6,$6) RETURNING id`,
        [input.appointmentType === "PHYSICAL_EXAM" ? TEST_REFERENCE_IDS.physicalExamClinic : TEST_REFERENCE_IDS.laboratoryClinic,
          input.appointmentOwner ?? owner,input.appointmentType ?? "LABORATORY",date,input.year,TEST_REFERENCE_IDS.adminUser],
      );
      appointmentId = appointment.rows[0].id;
      if (input.appointmentType !== "PHYSICAL_EXAM") {
        await linkPublishedLaboratoryAppointments(client,[appointmentId]);
        await client.query(`UPDATE laboratory_checklist_items SET verified_at=NOW(),verified_by=$2,
          verification_source='INTERNAL' WHERE checklist_id=(SELECT checklist_id FROM laboratory_checklist_appointments WHERE appointment_id=$1)`,
        [appointmentId,TEST_REFERENCE_IDS.adminUser]);
      }
    }
    const status = input.status ?? "FINALIZED";
    const submission = await client.query<{ id: string }>(
      `INSERT INTO student_result_submissions (appointment_id,student_number,result_type,status,
         finalized_at,invalidated_at,invalidated_by,invalidation_reason,superseded_at,superseded_by_submission_id,
         based_on_submission_id,discarded_at,last_activity_at)
       VALUES ($1,$2,$3,$4::varchar,CASE WHEN $4::varchar='DRAFT' THEN NULL ELSE NOW() END,
         CASE WHEN $4::varchar='INVALIDATED' THEN NOW() END,CASE WHEN $4::varchar='INVALIDATED' THEN $5::uuid END,
         CASE WHEN $4::varchar='INVALIDATED' THEN 'Invalid fixture result' END,
         CASE WHEN $4::varchar='SUPERSEDED' THEN NOW() END,CASE WHEN $4::varchar='SUPERSEDED' THEN $6::uuid END,
         $7,CASE WHEN $8 THEN NOW() END,'2026-01-01T00:00:00Z') RETURNING id`,
      [appointmentId,input.submissionOwner ?? owner,input.resultType ?? "LABORATORY",status,
        TEST_REFERENCE_IDS.adminUser,officialId ?? null,input.basedOn ?? null,input.discarded ?? false],
    );
    const submissionId = submission.rows[0].id;
    const fileId = input.fileId ?? randomUUID();
    await client.query(
      `INSERT INTO student_result_files (id,submission_id,storage_key,original_filename,detected_mime_type,
         extension,byte_size,checksum_sha256,deleted_at,storage_delete_pending,uploaded_at)
       VALUES ($1,$2,$3,$4,'application/pdf','pdf',10,$5,CASE WHEN $6 THEN NOW() END,$7,$8)`,
      [fileId,submissionId,`laboratory-read/${fileId}`,input.name,"a".repeat(64),input.deleted ?? false,
        input.pending ?? false,input.uploadedAt ?? "2026-01-01T01:00:00Z"],
    );
    return { submissionId, appointmentId, fileId, date };
  });
}

beforeAll(async () => {
  await insertTestStudent({ studentNumber: owner, firstName: "Official", lastName: "Reader", yearLevel: 4 });
  await insertTestStudent({ studentNumber: foreign, firstName: "Foreign", lastName: "Reader", yearLevel: 4 });
  const clock = await pool.query<{ year: number }>(`SELECT EXTRACT(YEAR FROM clock_timestamp() AT TIME ZONE 'Asia/Manila')::int AS year`);
  currentYear = clock.rows[0].year;
  const inserted = await pool.query<{ start_year: number }>(
    `INSERT INTO academic_years (start_year,closing_date,created_by,updated_by)
     VALUES ($1,(clock_timestamp() AT TIME ZONE 'Asia/Manila')::date - 1,$4,$4),
       ($2,(clock_timestamp() AT TIME ZONE 'Asia/Manila')::date,$4,$4),
       ($3,make_date($3+1,7,31),$4,$4) RETURNING start_year`,
    [currentYear-1,currentYear,currentYear+1,TEST_REFERENCE_IDS.adminUser],
  );
  years.push(...inserted.rows.map((row) => row.start_year));
  await transaction(async (client) => {
    for (const studentNumber of [owner,foreign]) for (const year of years) {
      await insertTestAcademicSnapshot(client, { studentNumber,academicYearStart: year,
        importName: `TEST laboratory read ${studentNumber} ${year}`,actor: TEST_REFERENCE_IDS.adminUser });
    }
  });
  const official = await createSubmission({ year: currentYear,name: "official.pdf",day: 3 });
  officialId = official.submissionId;
  officialAppointmentId = official.appointmentId;
  officialDate = official.date;
  allowed.push(official.fileId);
  const past = await createSubmission({ year: currentYear-1,name: "past.pdf" });
  historicalId = past.fileId;
  allowed.push(past.fileId);
  const future = await createSubmission({ year: currentYear+1,name: "upcoming.pdf" });
  allowed.push(future.fileId);
  allowed.push((await createSubmission({ year: currentYear,name: "earlier-current.pdf",day: 2 })).fileId);
  const newerPast = await createSubmission({ year: currentYear-1,name: "newer-past.pdf",day: 2 });
  newerHistoricalId = newerPast.fileId;
  allowed.push(newerPast.fileId);
  // Two tied uploads must sort by file ID, even when inserted in reverse order.
  for (const fileId of ["f0000000-0000-4000-8000-000000000002", "f0000000-0000-4000-8000-000000000001"]) {
    await pool.query(`INSERT INTO student_result_files (id,submission_id,storage_key,original_filename,
      detected_mime_type,extension,byte_size,checksum_sha256,uploaded_at)
      VALUES ($1::uuid,$2,($1::uuid)::text,($1::uuid)::text,'application/pdf','pdf',10,$3,'2026-01-01T02:00:00Z')`,
    [fileId,officialId,"b".repeat(64)]);
    allowed.push(fileId);
  }
  for (const year of [currentYear-1,currentYear]) {
    for (const variant of [
      { name: "draft.pdf",status: "DRAFT" as const },
      { name: "discarded.pdf",status: "DRAFT" as const,discarded: true },
      { name: "superseded.pdf",status: "SUPERSEDED" as const },
      { name: "invalidated.pdf",status: "INVALIDATED" as const },
      { name: "deleted.pdf",deleted: true }, { name: "pending-delete.pdf",pending: true },
      { name: "foreign.pdf",appointmentOwner: foreign,submissionOwner: foreign },
    ]) {
      excluded.push((await createSubmission({ year,...variant })).fileId);
    }
  }
  excluded.push((await createSubmission({ year: currentYear,name: "active-edit.pdf",status: "DRAFT",
    appointmentId: officialAppointmentId,basedOn: officialId })).fileId);
  await pool.query(`INSERT INTO laboratory_results (student_number,appointment_id,result_status,completed_at)
    VALUES ($1,$2,'COMPLETED',(clock_timestamp() AT TIME ZONE 'Asia/Manila')::date)`,[owner,officialAppointmentId]);
  await pool.query(`INSERT INTO student_result_storage_cleanup_intents (storage_key,not_before)
    VALUES ('laboratory-read/unrelated-cleanup',NOW()+INTERVAL '1 day')`);
});

afterAll(async () => {
  await cleanupTestFixtures(pattern,"TEST laboratory read%","TEST laboratory read%");
  await pool.query("DELETE FROM student_result_storage_cleanup_intents WHERE storage_key='laboratory-read/unrelated-cleanup'");
  await pool.query("DELETE FROM academic_years WHERE start_year=ANY($1::int[])",[years]);
});

describe("official Laboratory document reads", () => {
  it("rejects persisted submission ownership/type mismatches and Physical Examination uploads at the schema boundary", async () => {
    await expect(createSubmission({ year: currentYear,name: "foreign-appointment.pdf",appointmentOwner: foreign }))
      .rejects.toMatchObject({ code: "23514" });
    await expect(createSubmission({ year: currentYear,name: "foreign-submission.pdf",submissionOwner: foreign }))
      .rejects.toMatchObject({ code: "23514" });
    await expect(createSubmission({ year: currentYear,name: "wrong-appointment.pdf",appointmentType: "PHYSICAL_EXAM" }))
      .rejects.toMatchObject({ code: "23514" });
    await expect(createSubmission({ year: currentYear,name: "physical-exam.pdf",appointmentType: "PHYSICAL_EXAM",resultType: "PHYSICAL_EXAM" }))
      .rejects.toMatchObject({ code: "23514" });
  });
  it("includes closing-today and upcoming documents, with deterministic year/date/upload/file ordering", async () => {
    expect(typeof repository.listCurrentLaboratoryDocuments).toBe("function");
    const documents = await repository.listCurrentLaboratoryDocuments(owner);
    expect(documents.map((row) => row.originalFilename)).toEqual([
      "upcoming.pdf","official.pdf","f0000000-0000-4000-8000-000000000001","f0000000-0000-4000-8000-000000000002","earlier-current.pdf",
    ]);
    expect(documents[1]).toEqual({ submissionId: officialId,academicYearStart: currentYear,
      appointmentDate: officialDate,fileId: allowed[0],originalFilename: "official.pdf" });
  });

  it("uses configured closing dates for historical files and excludes foreign or wrong-type records", async () => {
    const documents = await repository.listHistoricalLaboratoryDocuments(owner);
    expect(documents.map((row) => row.fileId)).toEqual([newerHistoricalId,historicalId]);
    expect(documents[0].academicYearStart).toBe(currentYear-1);
  });

  it("keeps official files downloadable during an active edit and denies every ineligible file", async () => {
    for (const fileId of allowed) expect(await repository.getAccessibleStudentResultFileRow(fileId,owner)).not.toBeNull();
    for (const fileId of excluded) expect(await repository.getAccessibleStudentResultFileRow(fileId,owner)).toBeNull();
    for (const fileId of allowed) expect(await repository.getAccessibleStudentResultFileRow(fileId,foreign)).toBeNull();
  });

  it("leaves submission activity/status, files, result status and cleanup state unchanged across listing and downloads", async () => {
    async function snapshot() {
      const result = await pool.query(`SELECT
        (SELECT jsonb_agg(to_jsonb(s) ORDER BY s.id) FROM student_result_submissions s WHERE student_number LIKE $1) submissions,
        (SELECT jsonb_agg(to_jsonb(f) ORDER BY f.id) FROM student_result_files f JOIN student_result_submissions s ON s.id=f.submission_id WHERE s.student_number LIKE $1) files,
        (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id) FROM laboratory_results r WHERE student_number LIKE $1) results,
        (SELECT jsonb_agg(to_jsonb(c) ORDER BY c.storage_key) FROM student_result_storage_cleanup_intents c) cleanup`,[pattern]);
      return result.rows[0];
    }
    const before = await snapshot();
    const documents = [...await repository.listCurrentLaboratoryDocuments(owner),...await repository.listHistoricalLaboratoryDocuments(owner)];
    expect(documents.map((row) => row.fileId).sort()).toEqual([...allowed].sort());
    for (const document of documents) expect((await repository.getAccessibleStudentResultFileRow(document.fileId,owner))?.submissionId).toBe(document.submissionId);
    expect(await snapshot()).toEqual(before);
  });
});
