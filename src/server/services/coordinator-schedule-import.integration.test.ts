// @vitest-environment node
import { afterAll, describe, expect, it } from "vitest";
import { pool } from "@/server/db/pool";
import { importCoordinatorScheduleCsv } from "./coordinator-schedules.service";

const actorUserId = "00000000-0000-4000-8000-000000000002";
const regularPriorityId = "30000000-0000-4000-8000-000000000004";
const header = "Student ID,Name,College,Course,Year,Appointment Date,Appointment Type";

function input(contents: string) {
  return {
    fileName: "coordinator-schedule.csv",
    fileSize: Buffer.byteLength(contents),
    contents,
    batchName: "CSV import integration test",
    priorityGroupId: regularPriorityId,
    submittedByName: "Test Coordinator",
    description: "Disposable import fixture",
  };
}

async function cleanup(batchIds: string[], studentNumbers: string[]) {
  await pool.query("DELETE FROM audit_logs WHERE entity_type='schedule_batch' AND entity_id = ANY($1::varchar[])", [batchIds]);
  await pool.query("DELETE FROM schedule_batches WHERE id = ANY($1::uuid[])", [batchIds]);
  await pool.query("DELETE FROM students WHERE student_number = ANY($1::varchar[])", [studentNumbers]);
}

afterAll(async () => pool.end());

describe("coordinator schedule CSV import", () => {
  it("atomically creates missing students, a draft batch, schedule items, and an audit entry", async () => {
    const studentNumbers = ["CSV-TDD-0001", "CSV-TDD-0002", "CSV-TDD-0003"];
    const contents = [
      header,
      `${studentNumbers[0]},Anna Dela Cruz,College of Computer Studies,BSIT,3,06-19-2026,Physical Examination`,
      `${studentNumbers[1]},Ben Santos,College of Computer Studies,BSIT,3,06-20-2026,Laboratory`,
      `${studentNumbers[2]},Cara Reyes,College of Computer Studies,BSIT,3,06-21-2026,Physical + Laboratory`,
    ].join("\n");

    const imported = await importCoordinatorScheduleCsv(input(contents), actorUserId);

    try {
      expect(imported).toMatchObject({ status: "DRAFT", itemCount: 4, createdStudentCount: 3 });
      const students = await pool.query(
        `SELECT student_number, first_name, last_name, year_level
           FROM students WHERE student_number = ANY($1::varchar[]) ORDER BY student_number`,
        [studentNumbers],
      );
      expect(students.rows).toEqual([
        { student_number: studentNumbers[0], first_name: "Anna", last_name: "Dela Cruz", year_level: 3 },
        { student_number: studentNumbers[1], first_name: "Ben", last_name: "Santos", year_level: 3 },
        { student_number: studentNumbers[2], first_name: "Cara", last_name: "Reyes", year_level: 3 },
      ]);

      const items = await pool.query(
        `SELECT i.student_number, i.schedule_type, c.code AS clinic_code, i.target_date::text
           FROM coordinator_schedule_items i
           JOIN clinics c ON c.id=i.clinic_id
          WHERE i.batch_id = ANY($1::uuid[])
          ORDER BY i.student_number, i.schedule_type`,
        [imported.batchIds],
      );
      expect(items.rows).toEqual([
        { student_number: studentNumbers[0], schedule_type: "PHYSICAL_EXAM", clinic_code: "CPU_CLINIC", target_date: "2026-06-19" },
        { student_number: studentNumbers[1], schedule_type: "LABORATORY", clinic_code: "KABALAKA_CLINIC", target_date: "2026-06-20" },
        { student_number: studentNumbers[2], schedule_type: "LABORATORY", clinic_code: "KABALAKA_CLINIC", target_date: "2026-06-21" },
        { student_number: studentNumbers[2], schedule_type: "PHYSICAL_EXAM", clinic_code: "CPU_CLINIC", target_date: "2026-06-21" },
      ]);

      const audit = await pool.query(
        "SELECT action, metadata FROM audit_logs WHERE entity_type='schedule_batch' AND entity_id=$1",
        [imported.id],
      );
      expect(audit.rows).toEqual([expect.objectContaining({
        action: "SCHEDULE_BATCH_CSV_IMPORTED",
        metadata: expect.objectContaining({ createdStudentCount: 3, fileName: "coordinator-schedule.csv", itemCount: 4 }),
      })]);
    } finally {
      await cleanup(imported.batchIds, studentNumbers);
    }
  });

  it("rolls back the entire import when any reference value is invalid", async () => {
    const studentNumbers = ["CSV-TDD-ROLLBACK-1", "CSV-TDD-ROLLBACK-2"];
    const batchName = "CSV rollback integration test";
    const contents = [
      header,
      `${studentNumbers[0]},Valid Student,College of Computer Studies,BSIT,3,06-19-2026,Laboratory`,
      `${studentNumbers[1]},Invalid Student,Unknown College,NOPE,3,06-19-2026,Laboratory`,
    ].join("\n");

    try {
      await expect(importCoordinatorScheduleCsv({ ...input(contents), batchName }, actorUserId)).rejects.toMatchObject({
        code: "CSV_IMPORT_INVALID",
        status: 422,
        fields: { "rows.3.College": ["College must match an active college name."] },
      });

      const students = await pool.query(
        "SELECT student_number FROM students WHERE student_number = ANY($1::varchar[])",
        [studentNumbers],
      );
      const batches = await pool.query("SELECT id FROM schedule_batches WHERE batch_name=$1", [batchName]);
      expect(students.rowCount).toBe(0);
      expect(batches.rowCount).toBe(0);
    } finally {
      const batches = await pool.query<{ id: string }>("SELECT id FROM schedule_batches WHERE batch_name=$1", [batchName]);
      for (const batch of batches.rows) await cleanup([batch.id], studentNumbers);
      await pool.query("DELETE FROM students WHERE student_number = ANY($1::varchar[])", [studentNumbers]);
    }
  });

  it("rejects CSV profile data that does not match an existing student", async () => {
    const batchName = "CSV mismatch integration test";
    const contents = [
      header,
      "DEMO-0001,Wrong Person,College of Computer Studies,BSIT,4,06-19-2026,Laboratory",
    ].join("\n");

    await expect(importCoordinatorScheduleCsv({ ...input(contents), batchName }, actorUserId)).rejects.toMatchObject({
      code: "CSV_IMPORT_INVALID",
      fields: { "rows.2.Name": ["Name does not match the existing student data in this import."] },
    });
    expect((await pool.query("SELECT id FROM schedule_batches WHERE batch_name=$1", [batchName])).rowCount).toBe(0);
  });

  it("uses a matching existing student without overwriting the student record", async () => {
    const contents = [
      header,
      "DEMO-0001,Student 0001,College of Computer Studies,BSIT,4,06-19-2026,Laboratory",
    ].join("\n");
    const imported = await importCoordinatorScheduleCsv(input(contents), actorUserId);

    try {
      expect(imported.createdStudentCount).toBe(0);
      const student = await pool.query(
        "SELECT first_name, last_name, year_level FROM students WHERE student_number='DEMO-0001'",
      );
      expect(student.rows[0]).toEqual({ first_name: "Student", last_name: "0001", year_level: 4 });
    } finally {
      await cleanup(imported.batchIds, []);
    }
  });

  it("rejects an inactive or unknown priority before writing records", async () => {
    const studentNumber = "CSV-TDD-PRIORITY";
    const batchName = "CSV priority integration test";
    const contents = [
      header,
      `${studentNumber},Priority Student,College of Computer Studies,BSIT,3,06-19-2026,Laboratory`,
    ].join("\n");

    await expect(importCoordinatorScheduleCsv({
      ...input(contents),
      batchName,
      priorityGroupId: "99999999-9999-4999-8999-999999999999",
    }, actorUserId)).rejects.toMatchObject({
      code: "CSV_IMPORT_INVALID",
      fields: { priorityGroupId: ["Select an active priority group."] },
    });
    expect((await pool.query("SELECT 1 FROM students WHERE student_number=$1", [studentNumber])).rowCount).toBe(0);
    expect((await pool.query("SELECT 1 FROM schedule_batches WHERE batch_name=$1", [batchName])).rowCount).toBe(0);
  });

  it("reports a year mismatch when an existing student has no year level", async () => {
    const studentNumber = "CSV-TDD-NULL-YEAR";
    const batchName = "CSV null year integration test";
    const contents = [
      header,
      `${studentNumber},Null Year,College of Computer Studies,BSIT,3,06-19-2026,Laboratory`,
    ].join("\n");
    await pool.query(
      `INSERT INTO students (student_number, first_name, last_name, college_id, program_id, year_level)
       VALUES ($1,'Null','Year','10000000-0000-4000-8000-000000000003','20000000-0000-4000-8000-000000000003',NULL)`,
      [studentNumber],
    );

    try {
      await expect(importCoordinatorScheduleCsv({ ...input(contents), batchName }, actorUserId)).rejects.toMatchObject({
        code: "CSV_IMPORT_INVALID",
        fields: { "rows.2.Year": ["Year does not match the existing student data in this import."] },
      });
      expect((await pool.query("SELECT 1 FROM schedule_batches WHERE batch_name=$1", [batchName])).rowCount).toBe(0);
    } finally {
      const batches = await pool.query<{ id: string }>("SELECT id FROM schedule_batches WHERE batch_name=$1", [batchName]);
      for (const batch of batches.rows) await cleanup([batch.id], []);
      await pool.query("DELETE FROM students WHERE student_number=$1", [studentNumber]);
    }
  });
});
