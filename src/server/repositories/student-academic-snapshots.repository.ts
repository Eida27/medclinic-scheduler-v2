import "server-only";
import type { PoolClient } from "pg";
import { AppError } from "@/lib/errors";
import { writeAudit } from "@/server/repositories/audit.repository";
import { studentDisplayNameSql } from "@/server/students/student-display-name";

export type StudentAcademicSnapshotSource =
  | "VERIFIED_HISTORICAL"
  | "RECOVERED_HISTORICAL"
  | "MIGRATED_INCOMPLETE";

export type StudentAcademicSnapshotCandidate = {
  studentNumber: string;
  academicYearStart: number;
  studentName: string;
  collegeId: string | null;
  collegeName: string;
  programId: string | null;
  programCode: string | null;
  programName: string;
  yearLevel: number | null;
  sourceImportGroupId: string | null;
  sourceType: StudentAcademicSnapshotSource;
  sourceMetadata: Record<string, unknown>;
};

const academicFields = [
  ["studentName", "student_name"],
  ["collegeId", "college_id"],
  ["collegeName", "college_name"],
  ["programId", "program_id"],
  ["programCode", "program_code"],
  ["programName", "program_name"],
  ["yearLevel", "year_level"],
] as const;

function snapshotKey(candidate: Pick<
  StudentAcademicSnapshotCandidate,
  "studentNumber" | "academicYearStart"
>) {
  return `${candidate.studentNumber}:${candidate.academicYearStart}`;
}

export type StudentAcademicSnapshotConflict = {
  studentNumber: string;
  academicYearStart: number;
  fields: string[];
};

export type StudentAcademicSnapshotGatewayResult =
  | {
      outcome: "CREATED_OR_IDENTICAL";
      insertedCount: number;
      identicalCount: number;
    }
  | {
      outcome: "CONFLICT";
      conflicts: StudentAcademicSnapshotConflict[];
    };

export async function ensureStudentAcademicSnapshotsWithClient(
  client: PoolClient,
  input: {
    actorUserId: string;
    candidates: StudentAcademicSnapshotCandidate[];
  },
): Promise<StudentAcademicSnapshotGatewayResult> {
  if (input.candidates.length === 0) {
    return { outcome: "CREATED_OR_IDENTICAL", insertedCount: 0, identicalCount: 0 };
  }

  const candidatesByKey = new Map<string, StudentAcademicSnapshotCandidate>();
  const conflicts: StudentAcademicSnapshotConflict[] = [];
  for (const candidate of input.candidates) {
    const key = snapshotKey(candidate);
    const prior = candidatesByKey.get(key);
    if (!prior) {
      candidatesByKey.set(key, candidate);
      continue;
    }
    const fields = academicFields.flatMap(([field]) => (
      prior[field] === candidate[field] ? [] : [field]
    ));
    if (fields.length) {
      conflicts.push({
        studentNumber: candidate.studentNumber,
        academicYearStart: candidate.academicYearStart,
        fields,
      });
    }
  }
  const candidates = [...candidatesByKey.values()];
  const academicYears = [...new Set(candidates.map((candidate) => candidate.academicYearStart))];
  const configured = await client.query<{ start_year: number }>(
    `SELECT start_year
       FROM academic_years
      WHERE start_year=ANY($1::integer[])
      ORDER BY start_year
      FOR KEY SHARE`,
    [academicYears],
  );
  const configuredYears = new Set(configured.rows.map((year) => year.start_year));
  const missingYears = academicYears.filter((year) => !configuredYears.has(year));
  if (missingYears.length) {
    throw new AppError(
      "ACADEMIC_YEAR_NOT_CONFIGURED",
      "Configure the academic year before importing schedules.",
      409,
      undefined,
      { academicYearStart: missingYears },
    );
  }

  if (conflicts.length) {
    const years = [...new Set(conflicts.map((conflict) => conflict.academicYearStart))];
    await writeAudit(
      input.actorUserId,
      "SNAPSHOT_CONFLICT_DETECTED",
      "student_academic_snapshot",
      conflicts.length === 1
        ? `${conflicts[0].studentNumber}:${conflicts[0].academicYearStart}`
        : null,
      {
        academicYearStart: years.length === 1 ? years[0] : null,
        academicYearStarts: years,
        conflictCount: conflicts.length,
        conflicts,
      },
      client,
    );
    return { outcome: "CONFLICT", conflicts };
  }
  const gateway = await client.query<{ result: StudentAcademicSnapshotGatewayResult }>(
    `SELECT ensure_student_academic_snapshots($1,$2::jsonb) AS result`,
    [
      input.actorUserId,
      JSON.stringify(candidates.map((candidate) => ({
        student_number: candidate.studentNumber,
        academic_year_start: candidate.academicYearStart,
        student_name: candidate.studentName,
        college_id: candidate.collegeId,
        college_name: candidate.collegeName,
        program_id: candidate.programId,
        program_code: candidate.programCode,
        program_name: candidate.programName,
        year_level: candidate.yearLevel,
        source_import_group_id: candidate.sourceImportGroupId,
        source_type: candidate.sourceType,
        source_metadata: candidate.sourceMetadata,
      }))),
    ],
  );
  return gateway.rows[0].result;
}

type BatchSnapshotRow = {
  student_number: string;
  academic_year_start: number;
  student_name: string;
  college_id: string;
  college_name: string;
  program_id: string;
  program_code: string;
  program_name: string;
  year_level: number | null;
  source_import_group_id: string | null;
  source_type: StudentAcademicSnapshotSource;
  evidence_time: Date | null;
};

export async function ensureBatchStudentAcademicSnapshotsWithClient(
  client: PoolClient,
  input: { actorUserId: string; batchIds: string[] },
) {
  const rows = await client.query<BatchSnapshotRow>(
    `SELECT DISTINCT appointment.student_number,
            appointment.schedule_cycle_start AS academic_year_start,
            ${studentDisplayNameSql("student")} AS student_name,
            student.college_id,college.name AS college_name,
            student.program_id,program.code AS program_code,program.name AS program_name,
            student.year_level,
            CASE WHEN import_group.academic_year_start=appointment.schedule_cycle_start
              THEN import_group.id ELSE NULL END AS source_import_group_id,
            CASE
              WHEN import_group.academic_year_start=appointment.schedule_cycle_start
               AND college.updated_at <= import_group.accepted_at
               AND program.updated_at <= import_group.accepted_at
               AND NOT EXISTS (
                 SELECT 1
                   FROM audit_logs audit
                  WHERE audit.entity_type='student'
                    AND audit.entity_id=appointment.student_number
                    AND audit.created_at > import_group.accepted_at
                    AND NOT (
                      audit.action='STUDENT_PROFILE_UPDATED_BY_IMPORT'
                      AND audit.metadata->>'importId'=import_group.id::text
                    )
               )
                THEN 'RECOVERED_HISTORICAL'
              ELSE 'MIGRATED_INCOMPLETE'
            END AS source_type,
            CASE WHEN import_group.academic_year_start=appointment.schedule_cycle_start
              THEN import_group.accepted_at ELSE NULL END AS evidence_time
       FROM appointments appointment
       JOIN students student ON student.student_number=appointment.student_number
       JOIN colleges college ON college.id=student.college_id
       JOIN programs program ON program.id=student.program_id
       JOIN schedule_batches batch ON batch.id=appointment.batch_id
       LEFT JOIN schedule_import_groups import_group ON import_group.id=batch.import_group_id
      WHERE appointment.batch_id=ANY($1::uuid[])
        AND appointment.status='DRAFT'`,
    [input.batchIds],
  );
  return ensureStudentAcademicSnapshotsWithClient(client, {
    actorUserId: input.actorUserId,
    candidates: rows.rows.map((row) => ({
      studentNumber: row.student_number,
      academicYearStart: row.academic_year_start,
      studentName: row.student_name,
      collegeId: row.college_id,
      collegeName: row.college_name,
      programId: row.program_id,
      programCode: row.program_code,
      programName: row.program_name,
      yearLevel: row.year_level,
      sourceImportGroupId: row.source_import_group_id,
      sourceType: row.source_type,
      sourceMetadata: {
        provenance: row.source_type === "RECOVERED_HISTORICAL"
          ? "ACCEPTED_IMPORT_GROUP_RECOVERY"
          : "CURRENT_PROFILE_AT_LEGACY_PUBLICATION",
        historicalEvidenceComplete: row.source_type === "RECOVERED_HISTORICAL",
        evidenceTime: row.evidence_time?.toISOString() ?? null,
        publicationBatchIds: input.batchIds,
      },
    })),
  });
}
