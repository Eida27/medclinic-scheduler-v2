// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { pool } from "@/server/db/pool";
import {
  cleanupTestFixtures,
  insertTestStudent,
  TEST_REFERENCE_IDS,
} from "@/test/integration-fixtures";
import {
  getAdminStudentResultProfileRow,
  getStudentNumberForSubmission,
  listAdminStudentResultProfileRows,
} from "./student-result-submissions.repository";

const studentNumberPattern = "TEST-PROFILE-%";
const batchNamePattern = "TEST profile aggregation%";

type AppointmentStatus = "PENDING" | "COMPLETED" | "RESCHEDULED";
type ResultType = "LABORATORY" | "PHYSICAL_EXAM";
type SubmissionStatus = "DRAFT" | "FINALIZED" | "INVALIDATED";

let partialLaboratoryId: string;
let invalidatedAfterCleanupId: string;
let newerLaboratoryId: string;
let oldFinalizedId: string;
let invalidatedReplacementId: string;
let replacementFinalizedId: string;
let rescheduledReplacementId: string;

async function appointment(input: {
  studentNumber: string;
  resultType: ResultType;
  date: string;
  status?: AppointmentStatus;
  createdAt: string;
  rescheduledFrom?: string;
}) {
  const clinicId = input.resultType === "LABORATORY"
    ? TEST_REFERENCE_IDS.laboratoryClinic
    : TEST_REFERENCE_IDS.physicalExamClinic;
  const result = await pool.query<{ id: string }>(
    `INSERT INTO appointments (
       clinic_id, student_number, schedule_type, appointment_date, status,
       is_published, rescheduled_from, created_by, updated_by, created_at
     ) VALUES ($1,$2,$3,$4,$5,TRUE,$6,$7,$7,$8)
     RETURNING id`,
    [
      clinicId,
      input.studentNumber,
      input.resultType,
      input.date,
      input.status ?? "COMPLETED",
      input.rescheduledFrom ?? null,
      TEST_REFERENCE_IDS.adminUser,
      input.createdAt,
    ],
  );
  return result.rows[0].id;
}

async function submission(input: {
  appointmentId: string;
  studentNumber: string;
  resultType: ResultType;
  status: SubmissionStatus;
  activityAt: string;
}) {
  const finalizedAt = input.status === "DRAFT" ? null : input.activityAt;
  const invalidatedAt = input.status === "INVALIDATED" ? input.activityAt : null;
  const result = await pool.query<{ id: string }>(
    `INSERT INTO student_result_submissions (
       appointment_id, student_number, result_type, status, last_activity_at,
       finalized_at, invalidated_at, invalidated_by, invalidation_reason, created_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$5)
     RETURNING id`,
    [
      input.appointmentId,
      input.studentNumber,
      input.resultType,
      input.status,
      input.activityAt,
      finalizedAt,
      invalidatedAt,
      input.status === "INVALIDATED" ? TEST_REFERENCE_IDS.adminUser : null,
      input.status === "INVALIDATED" ? "Superseded result" : null,
    ],
  );
  return result.rows[0].id;
}

async function file(input: {
  submissionId: string;
  name: string;
  byteSize: number;
  uploadedAt: string;
  deletedAt?: string;
  storageDeletePending?: boolean;
}) {
  await pool.query(
    `INSERT INTO student_result_files (
       submission_id, storage_key, original_filename, detected_mime_type,
       extension, byte_size, checksum_sha256, storage_delete_pending,
       deleted_at, uploaded_at
     ) VALUES ($1,$2,$3,'application/pdf','pdf',$4,$5,$6,$7,$8)`,
    [
      input.submissionId,
      `task-5/${input.submissionId}/${input.name}`,
      input.name,
      input.byteSize,
      input.name.padEnd(64, "0").slice(0, 64),
      input.storageDeletePending ?? false,
      input.deletedAt ?? null,
      input.uploadedAt,
    ],
  );
}

beforeAll(async () => {
  await cleanupTestFixtures(studentNumberPattern, batchNamePattern);

  const students = [
    ["TEST-PROFILE-0001", "Ana", "Partial"],
    ["TEST-PROFILE-0002", "Bianca", "Complete"],
    ["TEST-PROFILE-0003", "Carlo", "Invalidated"],
    ["TEST-PROFILE-0004", "Dina", "Newcycle"],
    ["TEST-PROFILE-0005", "Enzo", "Replacement"],
    ["TEST-PROFILE-0006", "Faye", "Draftonly"],
    ["TEST-PROFILE-0007", "Gio", "Rescheduled"],
    ["TEST-PROFILE-0008", "Hana", "Direct"],
  ] as const;
  for (const [studentNumber, firstName, lastName] of students) {
    await insertTestStudent({ studentNumber, firstName, lastName, yearLevel: 4 });
  }

  const partialLabAppointment = await appointment({
    studentNumber: "TEST-PROFILE-0001",
    resultType: "LABORATORY",
    date: "2098-01-10",
    createdAt: "2098-01-01T00:00:00Z",
  });
  await appointment({
    studentNumber: "TEST-PROFILE-0001",
    resultType: "PHYSICAL_EXAM",
    date: "2098-01-11",
    createdAt: "2098-01-01T00:01:00Z",
  });
  partialLaboratoryId = await submission({
    appointmentId: partialLabAppointment,
    studentNumber: "TEST-PROFILE-0001",
    resultType: "LABORATORY",
    status: "FINALIZED",
    activityAt: "2099-01-07T00:00:00Z",
  });
  await file({
    submissionId: partialLaboratoryId,
    name: "partial-a.pdf",
    byteSize: 10,
    uploadedAt: "2099-01-07T00:00:01Z",
  });
  await file({
    submissionId: partialLaboratoryId,
    name: "partial-b.pdf",
    byteSize: 20,
    uploadedAt: "2099-01-07T00:00:02Z",
  });

  for (const [resultType, date] of [
    ["LABORATORY", "2098-02-10"],
    ["PHYSICAL_EXAM", "2098-02-11"],
  ] as const) {
    const appointmentId = await appointment({
      studentNumber: "TEST-PROFILE-0002",
      resultType,
      date,
      createdAt: "2098-02-01T00:00:00Z",
    });
    const finalized = await submission({
      appointmentId,
      studentNumber: "TEST-PROFILE-0002",
      resultType,
      status: "FINALIZED",
      activityAt: resultType === "LABORATORY"
        ? "2099-01-08T00:00:00Z"
        : "2099-01-09T00:00:00Z",
    });
    await file({
      submissionId: finalized,
      name: `${resultType.toLowerCase()}-complete.pdf`,
      byteSize: 40,
      uploadedAt: "2099-01-09T00:00:01Z",
    });
  }

  const invalidatedAppointment = await appointment({
    studentNumber: "TEST-PROFILE-0003",
    resultType: "LABORATORY",
    date: "2098-03-10",
    createdAt: "2098-03-01T00:00:00Z",
  });
  invalidatedAfterCleanupId = await submission({
    appointmentId: invalidatedAppointment,
    studentNumber: "TEST-PROFILE-0003",
    resultType: "LABORATORY",
    status: "INVALIDATED",
    activityAt: "2099-01-06T00:00:00Z",
  });
  await file({
    submissionId: invalidatedAfterCleanupId,
    name: "cleaned-a.pdf",
    byteSize: 50,
    uploadedAt: "2099-01-05T00:00:01Z",
    deletedAt: "2099-01-06T00:01:00Z",
  });
  await file({
    submissionId: invalidatedAfterCleanupId,
    name: "cleaned-b.pdf",
    byteSize: 70,
    uploadedAt: "2099-01-05T00:00:02Z",
    deletedAt: "2099-01-06T00:01:00Z",
  });
  await pool.query(
    "UPDATE student_result_submissions SET last_activity_at='2099-01-01T00:00:00Z' WHERE id=$1",
    [invalidatedAfterCleanupId],
  );

  const oldLaboratory = await appointment({
    studentNumber: "TEST-PROFILE-0004",
    resultType: "LABORATORY",
    date: "2097-04-10",
    createdAt: "2097-04-01T00:00:00Z",
  });
  oldFinalizedId = await submission({
    appointmentId: oldLaboratory,
    studentNumber: "TEST-PROFILE-0004",
    resultType: "LABORATORY",
    status: "FINALIZED",
    activityAt: "2099-01-05T00:00:00Z",
  });
  newerLaboratoryId = await appointment({
    studentNumber: "TEST-PROFILE-0004",
    resultType: "LABORATORY",
    date: "2098-04-10",
    status: "PENDING",
    createdAt: "2098-04-01T00:00:00Z",
  });

  const replacementAppointment = await appointment({
    studentNumber: "TEST-PROFILE-0005",
    resultType: "LABORATORY",
    date: "2098-05-10",
    createdAt: "2098-05-01T00:00:00Z",
  });
  invalidatedReplacementId = await submission({
    appointmentId: replacementAppointment,
    studentNumber: "TEST-PROFILE-0005",
    resultType: "LABORATORY",
    status: "INVALIDATED",
    activityAt: "2099-01-03T00:00:00Z",
  });
  replacementFinalizedId = await submission({
    appointmentId: replacementAppointment,
    studentNumber: "TEST-PROFILE-0005",
    resultType: "LABORATORY",
    status: "FINALIZED",
    activityAt: "2099-01-04T00:00:00Z",
  });
  await file({
    submissionId: replacementFinalizedId,
    name: "active.pdf",
    byteSize: 80,
    uploadedAt: "2099-01-04T00:00:01Z",
  });
  await file({
    submissionId: replacementFinalizedId,
    name: "pending-delete.pdf",
    byteSize: 90,
    uploadedAt: "2099-01-04T00:00:02Z",
    storageDeletePending: true,
  });
  await file({
    submissionId: replacementFinalizedId,
    name: "deleted.pdf",
    byteSize: 100,
    uploadedAt: "2099-01-04T00:00:03Z",
    deletedAt: "2099-01-04T01:00:00Z",
  });

  const draftAppointment = await appointment({
    studentNumber: "TEST-PROFILE-0006",
    resultType: "LABORATORY",
    date: "2098-06-10",
    createdAt: "2098-06-01T00:00:00Z",
  });
  await submission({
    appointmentId: draftAppointment,
    studentNumber: "TEST-PROFILE-0006",
    resultType: "LABORATORY",
    status: "DRAFT",
    activityAt: "2099-01-10T00:00:00Z",
  });

  const rescheduled = await appointment({
    studentNumber: "TEST-PROFILE-0007",
    resultType: "PHYSICAL_EXAM",
    date: "2098-07-10",
    status: "RESCHEDULED",
    createdAt: "2098-07-01T00:00:00Z",
  });
  rescheduledReplacementId = await appointment({
    studentNumber: "TEST-PROFILE-0007",
    resultType: "PHYSICAL_EXAM",
    date: "2098-07-17",
    status: "PENDING",
    createdAt: "2098-07-02T00:00:00Z",
    rescheduledFrom: rescheduled,
  });
  await submission({
    appointmentId: rescheduled,
    studentNumber: "TEST-PROFILE-0007",
    resultType: "PHYSICAL_EXAM",
    status: "FINALIZED",
    activityAt: "2099-01-02T00:00:00Z",
  });
});

afterAll(async () => {
  await cleanupTestFixtures(studentNumberPattern, batchNamePattern);
  await pool.end();
});

describe("administrator student result profile repository", () => {
  it("groups current submission states before pagination and excludes draft-only students", async () => {
    const listed = await listAdminStudentResultProfileRows({ limit: 2, offset: 0 });
    const expectedTotal = await pool.query<{ total: number }>(
      `SELECT COUNT(DISTINCT student_number)::int AS total
         FROM student_result_submissions
        WHERE status IN ('FINALIZED','INVALIDATED')`,
    );

    expect(listed.total).toBe(expectedTotal.rows[0].total);
    expect(listed.items).toHaveLength(2);
    expect(listed.items.map((item) => item.studentNumber)).toEqual([
      "TEST-PROFILE-0002",
      "TEST-PROFILE-0001",
    ]);
    expect(listed.items.filter((item) => item.studentNumber === "TEST-PROFILE-0002"))
      .toHaveLength(1);
    expect(listed.items[0]).toMatchObject({
      progress: "FULLY_SUBMITTED",
      laboratory: { state: "FINALIZED", fileCount: 1 },
      physicalExam: { state: "FINALIZED", fileCount: 1 },
    });
    expect(listed.items[1]).toMatchObject({
      studentName: "Partial, Ana",
      progress: "PARTIALLY_SUBMITTED",
      laboratory: { state: "FINALIZED", fileCount: 2 },
      physicalExam: { state: "NOT_SUBMITTED", fileCount: 0 },
    });

    const allFixtures = await listAdminStudentResultProfileRows({ limit: 20, offset: 0 });
    const fixtureItems = allFixtures.items.filter((item) => item.studentNumber.startsWith("TEST-PROFILE-"));
    expect(fixtureItems.map((item) => item.studentNumber)).not.toContain("TEST-PROFILE-0006");
    expect(fixtureItems.find((item) => item.studentNumber === "TEST-PROFILE-0003"))
      .toMatchObject({
        progress: "AWAITING_RESUBMISSION",
        laboratory: { state: "INVALIDATED", fileCount: 2 },
      });
    expect(fixtureItems.find((item) => item.studentNumber === "TEST-PROFILE-0004"))
      .toMatchObject({ laboratory: { state: "NOT_SUBMITTED", fileCount: 0 } });
    expect(fixtureItems.find((item) => item.studentNumber === "TEST-PROFILE-0007"))
      .toMatchObject({ physicalExam: { state: "NOT_SUBMITTED", fileCount: 0 } });
  });

  it("uses current appointments and moves older or superseded submissions into deterministic history", async () => {
    const newCycle = await getAdminStudentResultProfileRow("TEST-PROFILE-0004");
    expect(newCycle?.laboratory).toMatchObject({
      appointment: { id: newerLaboratoryId, status: "PENDING" },
      state: "NOT_SUBMITTED",
      submission: null,
    });
    expect(newCycle?.history.find((item) => item.id === oldFinalizedId)).toMatchObject({
      appointmentDate: "2097-04-10",
    });

    const replacement = await getAdminStudentResultProfileRow("TEST-PROFILE-0005");
    expect(replacement?.laboratory.submission).toMatchObject({
      id: replacementFinalizedId,
      status: "FINALIZED",
      fileCount: 1,
      totalBytes: 80,
      files: [{ originalFilename: "active.pdf", byteSize: 80 }],
    });
    expect(replacement?.laboratory.state).toBe("FINALIZED");
    expect(replacement?.history.find((item) => item.id === invalidatedReplacementId))
      .toMatchObject({ status: "INVALIDATED", files: [] });

    const rescheduled = await getAdminStudentResultProfileRow("TEST-PROFILE-0007");
    expect(rescheduled?.physicalExam).toMatchObject({
      appointment: { id: rescheduledReplacementId, status: "PENDING" },
      state: "NOT_SUBMITTED",
      submission: null,
    });
  });

  it("retains invalidated file aggregates after storage cleanup without exposing downloads", async () => {
    const profile = await getAdminStudentResultProfileRow("TEST-PROFILE-0003");

    expect(profile?.laboratory.submission).toMatchObject({
      id: invalidatedAfterCleanupId,
      status: "INVALIDATED",
      fileCount: 2,
      totalBytes: 120,
      files: [],
    });
    expect(profile?.laboratory.state).toBe("INVALIDATED");
    expect(profile?.latestActivityAt).toEqual(new Date("2099-01-06T00:00:00Z"));
  });

  it("returns owners and supports direct profiles for students absent from the grouped list", async () => {
    await expect(getStudentNumberForSubmission(partialLaboratoryId))
      .resolves.toBe("TEST-PROFILE-0001");
    await expect(getStudentNumberForSubmission("00000000-0000-4000-8000-ffffffffffff"))
      .resolves.toBeNull();

    const direct = await getAdminStudentResultProfileRow("TEST-PROFILE-0008");
    expect(direct).toMatchObject({
      studentNumber: "TEST-PROFILE-0008",
      progress: "NOT_SUBMITTED",
      laboratory: { appointment: null, state: "NOT_SUBMITTED", submission: null },
      physicalExam: { appointment: null, state: "NOT_SUBMITTED", submission: null },
      history: [],
    });
    await expect(getAdminStudentResultProfileRow("TEST-PROFILE-UNKNOWN"))
      .resolves.toBeNull();
  });
});
