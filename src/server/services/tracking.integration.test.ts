// @vitest-environment node
import { createHash, randomUUID } from "node:crypto";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool, transaction } from "@/server/db/pool";
import { linkPublishedLaboratoryAppointments } from "@/server/laboratory/laboratory-checklist.repository";
import { complianceReport } from "@/server/repositories/tracking.repository";
import {
  cleanupTestFixtures,
  insertTestAcademicSnapshot,
  insertTestStudent,
  TEST_REFERENCE_IDS,
} from "@/test/integration-fixtures";

const actorUserId = TEST_REFERENCE_IDS.clinicStaffUser;
const summaryStudentNumber = "TEST-SUMMARY-0001";
let createdYear = false;
let physicianId: string | null = null;

beforeAll(async () => {
  await cleanupTestFixtures("TEST-TRACK-%", "TEST tracking fixture%");
  await cleanupTestFixtures("TEST-SUMMARY-%", "TEST summary fixture%", "TEST summary fixture%");
  await insertTestStudent({
    studentNumber: summaryStudentNumber,
    firstName: "Summary",
    lastName: "Student",
    yearLevel: 2,
  });
  const year = await pool.query(`INSERT INTO academic_years (start_year,closing_date,created_by,updated_by)
    VALUES (2026,'2027-07-31',$1,$1) ON CONFLICT (start_year) DO NOTHING RETURNING start_year`,
  [actorUserId]);
  createdYear = Boolean(year.rowCount);
});

afterAll(async () => {
  await cleanupTestFixtures("TEST-TRACK-%", "TEST tracking fixture%");
  await cleanupTestFixtures("TEST-SUMMARY-%", "TEST summary fixture%", "TEST summary fixture%");
  if (physicianId) {
    await transaction(async (client) => {
      await client.query("ALTER TABLE medical_certificate_physician_revisions DISABLE TRIGGER medical_certificate_physician_revisions_immutable");
      await client.query("DELETE FROM medical_certificate_physician_revisions WHERE physician_id=$1", [physicianId]);
      await client.query("DELETE FROM medical_certificate_physicians WHERE id=$1", [physicianId]);
      await client.query("ALTER TABLE medical_certificate_physician_revisions ENABLE TRIGGER medical_certificate_physician_revisions_immutable");
    });
  }
  if (createdYear) await pool.query("DELETE FROM academic_years WHERE start_year=2026");
  await pool.end();
});

describe("compliance tracking", () => {
  it("summarizes both services from the latest effective attendance appointments", async () => {
    const ids = await transaction(async (client) => {
      await insertTestAcademicSnapshot(client, {
        studentNumber: summaryStudentNumber,
        academicYearStart: 2026,
        importName: "TEST summary fixture provenance",
        actor: actorUserId,
      });
      const completedPhysical = await client.query<{ id: string }>(
        "INSERT INTO appointments (clinic_id,student_number,schedule_type,appointment_date,status,is_published,schedule_cycle_start,scheduling_category,created_by,updated_by) VALUES ($1,$2,'PHYSICAL_EXAM','2026-12-25','COMPLETED',TRUE,2026,'REGULAR',$3,$3) RETURNING id",
        [TEST_REFERENCE_IDS.physicalExamClinic, summaryStudentNumber, actorUserId],
      );
      const pendingPhysical = await client.query<{ id: string }>(
        "INSERT INTO appointments (clinic_id,student_number,schedule_type,appointment_date,status,is_published,schedule_cycle_start,scheduling_category,created_by,updated_by) VALUES ($1,$2,'PHYSICAL_EXAM','2026-12-20','PENDING',TRUE,2026,'REGULAR',$3,$3) RETURNING id",
        [TEST_REFERENCE_IDS.physicalExamClinic, summaryStudentNumber, actorUserId],
      );
      const completedLaboratory = await client.query<{ id: string }>(
        "INSERT INTO appointments (clinic_id,student_number,schedule_type,appointment_date,status,is_published,schedule_cycle_start,scheduling_category,created_by,updated_by) VALUES ($1,$2,'LABORATORY','2026-12-19','COMPLETED',TRUE,2026,'REGULAR',$3,$3) RETURNING id",
        [TEST_REFERENCE_IDS.laboratoryClinic, summaryStudentNumber, actorUserId],
      );
      await linkPublishedLaboratoryAppointments(client, [completedLaboratory.rows[0].id]);
      await client.query(
        "UPDATE laboratory_checklist_items SET verified_at=NOW(),verified_by=$2,verification_source='INTERNAL' WHERE checklist_id=(SELECT checklist_id FROM laboratory_checklist_appointments WHERE appointment_id=$1)",
        [completedLaboratory.rows[0].id, actorUserId],
      );
      await client.query(
        "INSERT INTO exam_results (student_number,appointment_id,result_status,encoded_by) VALUES ($1,$2,'REQUIRES_FOLLOW_UP',$3)",
        [summaryStudentNumber, pendingPhysical.rows[0].id, actorUserId],
      );
      await client.query(
        "INSERT INTO exam_results (student_number,appointment_id,result_status,completed_at,encoded_by) VALUES ($1,$2,'COMPLETED','2026-12-25',$3)",
        [summaryStudentNumber, completedPhysical.rows[0].id, actorUserId],
      );
      await client.query(
        "INSERT INTO laboratory_results (student_number,appointment_id,result_status,completed_at,encoded_by) VALUES ($1,$2,'REQUIRES_FOLLOW_UP','2026-12-19',$3)",
        [summaryStudentNumber, completedLaboratory.rows[0].id, actorUserId],
      );
      const physician = await client.query<{ id: string }>(
        "INSERT INTO medical_certificate_physicians DEFAULT VALUES RETURNING id::text",
      );
      physicianId = physician.rows[0].id;
      const signature = await sharp({ create: { width: 1, height: 1, channels: 3, background: "white" } }).png().toBuffer();
      const jpg = await sharp({ create: { width: 1, height: 1, channels: 3, background: "white" } }).jpeg().toBuffer();
      const physicianRevision = await client.query<{ id: string }>(
        "INSERT INTO medical_certificate_physician_revisions (physician_id,version,display_name,license_number,signature_bytes,signature_media_type,actor_user_id,actor_snapshot) VALUES ($1,1,'Dr. Fixture','PRC 12345',$2,'image/png',$3,$4::jsonb) RETURNING id::text",
        [physicianId, signature, actorUserId, JSON.stringify({ userId: actorUserId })],
      );
      await client.query(
        "INSERT INTO medical_certificate_revisions (certificate_id,appointment_id,student_number,academic_year_start,revision_number,status,physician_revision_id,student_snapshot,examination_snapshot,physician_snapshot,classification,examination_date,sex,template_version,jpeg_bytes,byte_length,sha256,issued_by,issued_by_snapshot,request_id) VALUES ($1,$2,$3,2026,1,'ISSUED',$4,$5::jsonb,$6::jsonb,$7::jsonb,'A','2026-12-25','Female','integration-test-v1',$8,$9,$10,$11,$12::jsonb,$13)",
        [
          randomUUID(), completedPhysical.rows[0].id, summaryStudentNumber, physicianRevision.rows[0].id,
          JSON.stringify({ studentNumber: summaryStudentNumber }),
          JSON.stringify({ examinationDate: "2026-12-25" }),
          JSON.stringify({ displayName: "Dr. Fixture" }),
          jpg, jpg.length, createHash("sha256").update(jpg).digest("hex"),
          actorUserId, JSON.stringify({ userId: actorUserId }), randomUUID(),
        ],
      );
      return {
        completedPhysical: completedPhysical.rows[0].id,
        pendingPhysical: pendingPhysical.rows[0].id,
        completedLaboratory: completedLaboratory.rows[0].id,
      };
    });

    const report = await complianceReport({
      search: summaryStudentNumber,
      page: 1,
      limit: 150,
      offset: 0,
    });

    expect(report.items).toEqual([
      expect.objectContaining({
        studentNumber: summaryStudentNumber,
        appointmentStatus: "COMPLETED",
        physicalExamStatus: "COMPLETED",
        laboratoryStatus: "COMPLETED",
        physicalExamAppointmentId: ids.completedPhysical,
        physicalExamAppointmentDate: "2026-12-25",
        physicalExamAppointmentStatus: "COMPLETED",
        laboratoryAppointmentId: ids.completedLaboratory,
        laboratoryAppointmentDate: "2026-12-19",
        laboratoryAppointmentStatus: "COMPLETED",
        nextSchedule: null,
        overallStatus: "COMPLETE",
      }),
    ]);
    expect(report.summary).toEqual({
      totalStudents: 1,
      physicalCompleted: 1,
      laboratoryCompleted: 1,
      pendingAny: 0,
    });
    expect(ids.completedPhysical).not.toBe(ids.pendingPhysical);
  });
});