import "server-only";
import type { PoolClient } from "pg";
import { AppError } from "@/lib/errors";
import { writeAudit } from "@/server/repositories/audit.repository";

export type StudentAcademicSnapshotCandidate = {
  studentNumber: string;
  academicYearStart: number;
  studentName: string;
  collegeId: string;
  collegeName: string;
  programId: string;
  programCode: string;
  programName: string;
  yearLevel: number;
  sourceImportGroupId: string;
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
      }))),
    ],
  );
  return gateway.rows[0].result;
}
