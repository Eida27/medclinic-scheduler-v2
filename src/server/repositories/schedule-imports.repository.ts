import "server-only";
import type { PoolClient } from "pg";
import { AppError } from "@/lib/errors";
import type { AppointmentScheduleType, ClinicCode } from "@/server/clinics";
import { query, transaction } from "@/server/db/pool";
import { writeAudit } from "@/server/repositories/audit.repository";
import { getScheduleBatch } from "@/server/repositories/coordinator-schedules.repository";
import type { ImportedStudentRow } from "@/server/services/student-import-csv";
import { resolveSchedulingWindow } from "@/server/services/scheduling-window";
import { generatePairedSchedule } from "@/server/rule-engine/generate-paired-schedule";
import {
  makeCapacityForPriorityBatch,
  makePhysicalExamCapacityForPriorityBatch,
  nextDateAfter,
  publishDisplacedRegularReplacements,
} from "@/server/services/priority-displacement.service";
import { studentDisplayNameSql } from "@/server/students/student-display-name";

export type ScheduleImportStatus =
  | "DRAFT"
  | "VALIDATED"
  | "GENERATED"
  | "PUBLISHED"
  | "CANCELLED"
  | "NEEDS_REVIEW";

const synchronizedStatuses = new Set<ScheduleImportStatus>([
  "DRAFT",
  "VALIDATED",
  "GENERATED",
  "PUBLISHED",
  "CANCELLED",
]);

export function deriveScheduleImportStatus(statuses: string[]): ScheduleImportStatus {
  const first = statuses[0];
  if (!first || !synchronizedStatuses.has(first as ScheduleImportStatus)) return "NEEDS_REVIEW";
  return statuses.every((status) => status === first) ? first as ScheduleImportStatus : "NEEDS_REVIEW";
}

export type CreateScheduleImportInput = {
  sourceFilename: string;
  studentCategory: "REGULAR" | "OJT" | "TOUR" | "SPECIALIZED";
  academicYearStart: number;
  preferredMonth: number | null;
  rows: ImportedStudentRow[];
};

export type ScheduleImportResult = {
  importId: string;
  outcome: "PUBLISHED";
  status: "PUBLISHED";
  totalRows: number;
  insertedStudentCount: number;
  updatedStudentCount: number;
  skippedStudentCount: number;
  laboratoryItemCount: number;
  physicalExaminationItemCount: number;
  publishedAppointmentCount: number;
  generatedRange: { startDate: string; endDate: string } | null;
  overflow: { pairCountBeyondPreferredWindow: number; unscheduledStudentCount: number };
  displacementTotal: number;
  batchIds: string[];
};

export type ScheduleImportListItem = {
  importId: string;
  importName: string;
  sourceFilename: string;
  totalRows: number;
  createdStudentCount: number;
  matchedStudentCount: number;
  submittedByName: string | null;
  description: string | null;
  createdByName: string;
  laboratoryItemCount: number;
  physicalExaminationItemCount: number;
  status: ScheduleImportStatus;
  createdAt: string;
  updatedAt: string;
  studentCategory: CreateScheduleImportInput["studentCategory"] | null;
  academicYearStart: number | null;
  preferredMonth: number | null;
  acceptedAt: string;
  skippedStudentCount: number;
  generatedRange: { startDate: string; endDate: string } | null;
  overflow: { pairCountBeyondPreferredWindow: number; unscheduledStudentCount: number };
  displacementTotal: number;
};

type StoredImportChildBatch = NonNullable<Awaited<ReturnType<typeof getScheduleBatch>>>;

export type ScheduleImportAppointment = {
  id: string;
  batchId: string;
  studentNumber: string;
  studentName: string;
  scheduleType: AppointmentScheduleType;
  priorityGroupName: string | null;
  appointmentDate: string;
  status: string;
  isPublished: boolean;
  notes: string | null;
};

export type ImportChildBatch = StoredImportChildBatch & {
  appointments: ScheduleImportAppointment[];
};

export type ScheduleImportDetail = ScheduleImportListItem & {
  childBatches: ImportChildBatch[];
};

export type LockedImportChild = {
  id: string;
  status: string;
  clinicCode: ClinicCode;
};

type CollegeReference = {
  id: string;
  name: string;
};

type ProgramReference = {
  id: string;
  college_id: string;
  code: string;
};

type ExistingStudent = {
  student_number: string;
};

type ResolvedRow = ImportedStudentRow & {
  collegeId: string | null;
  programId: string | null;
  existedBeforeImport: boolean;
  alreadyScheduledForCycle: boolean;
};

function normalizeComparable(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFKC")
    .trim()
    .replace(/\s+/gu, " ")
    .toLowerCase();
}

function addFieldError(
  fields: Record<string, string[]>,
  field: string,
  message: string,
) {
  fields[field] = [...(fields[field] ?? []), message];
}

function uniqueReferenceMap<T>(
  rows: T[],
  keyFor: (row: T) => string,
): Map<string, T | null> {
  const result = new Map<string, T | null>();
  for (const row of rows) {
    const key = keyFor(row);
    result.set(key, result.has(key) ? null : row);
  }
  return result;
}


export async function createScheduleImport(
  input: CreateScheduleImportInput,
  actorUserId: string,
): Promise<ScheduleImportResult | { fields: Record<string, string[]> }> {
  return transaction(async (client) => {
    const fields: Record<string, string[]> = {};
    const colleges = await client.query<CollegeReference>(
      "SELECT id, name FROM colleges WHERE is_active=TRUE",
    );
    const programs = await client.query<ProgramReference>(
      "SELECT id, college_id, code FROM programs WHERE is_active=TRUE",
    );
    const collegeByName = uniqueReferenceMap(
      colleges.rows,
      (college) => normalizeComparable(college.name),
    );
    const programByCollegeAndCode = uniqueReferenceMap(
      programs.rows,
      (program) => `${program.college_id}:${normalizeComparable(program.code)}`,
    );
    const validatedRows = input.rows.map((row) => {
      const college = collegeByName.get(normalizeComparable(row.collegeName));
      if (!college) {
        addFieldError(
          fields,
          `rows.${row.rowNumber}.College`,
          "College must match an active college name.",
        );
      }
      const program = college
        ? programByCollegeAndCode.get(`${college.id}:${normalizeComparable(row.courseCode)}`)
        : null;
      if (college && !program) {
        addFieldError(
          fields,
          `rows.${row.rowNumber}.Course`,
          "Course must match an active code in the selected college.",
        );
      }

      return {
        ...row,
        collegeId: college?.id ?? null,
        programId: program?.id ?? null,
        existedBeforeImport: false,
        alreadyScheduledForCycle: false,
      };
    });

    if (Object.keys(fields).length) return { fields };

    await client.query("SELECT pg_advisory_xact_lock(hashtext('medclinic:schedule-import-queue'))");
    const accepted = await client.query<{ acceptedAt: Date }>(
      `SELECT clock_timestamp() AS "acceptedAt"`,
    );
    const studentNumbers = [...new Set(input.rows.map((row) => row.studentNumber))];
    const existingStudents = await client.query<ExistingStudent>(
      `SELECT student_number FROM students
        WHERE student_number = ANY($1::varchar[])`,
      [studentNumbers],
    );
    const scheduledStudents = await client.query<{ student_number: string }>(
      `SELECT DISTINCT student_number
       FROM appointments
        WHERE student_number = ANY($1::varchar[])
          AND schedule_cycle_start=$2`,
      [studentNumbers, input.academicYearStart],
    );
    const existingStudentNumbers = new Set(
      existingStudents.rows.map((student) => student.student_number),
    );
    const scheduledStudentNumbers = new Set(
      scheduledStudents.rows.map((student) => student.student_number),
    );
    const resolvedRows: ResolvedRow[] = validatedRows.map((row) => ({
      ...row,
      existedBeforeImport: existingStudentNumbers.has(row.studentNumber),
      alreadyScheduledForCycle: scheduledStudentNumbers.has(row.studentNumber),
    }));

    const insertedStudentCount = resolvedRows.filter((row) => !row.existedBeforeImport).length;
    const updatedStudentCount = resolvedRows.length - insertedStudentCount;
    const skippedStudentCount = resolvedRows.filter(
      (row) => row.alreadyScheduledForCycle,
    ).length;
    const importName = Array.from(
      `${input.studentCategory} ${input.academicYearStart}-${input.academicYearStart + 1} - ${input.sourceFilename}`,
    ).slice(0, 150).join("");
    const importGroup = await client.query<{ id: string }>(
      `INSERT INTO schedule_import_groups (
         import_name, source_filename, total_rows, created_student_count,
         matched_student_count, created_by, student_category, academic_year_start,
         preferred_month, accepted_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING id`,
      [
        importName,
        input.sourceFilename,
        input.rows.length,
        insertedStudentCount,
        updatedStudentCount,
        actorUserId,
        input.studentCategory,
        input.academicYearStart,
        input.preferredMonth,
        accepted.rows[0].acceptedAt,
      ],
    );
    const importId = importGroup.rows[0].id;

    await client.query(
      `INSERT INTO students (
         student_number, first_name, middle_name, last_name, suffix,
         college_id, program_id, year_level, date_of_birth
       )
       SELECT fixture.student_number, fixture.first_name, fixture.middle_name,
              fixture.last_name, fixture.suffix, fixture.college_id,
              fixture.program_id, fixture.year_level, fixture.date_of_birth
         FROM UNNEST(
           $1::varchar[], $2::varchar[], $3::varchar[], $4::varchar[],
           $5::varchar[], $6::uuid[], $7::uuid[], $8::integer[], $9::date[]
         ) AS fixture(
           student_number, first_name, middle_name, last_name, suffix,
           college_id, program_id, year_level, date_of_birth
         )
       ON CONFLICT (student_number) DO UPDATE SET
         first_name=EXCLUDED.first_name,
         middle_name=EXCLUDED.middle_name,
         last_name=EXCLUDED.last_name,
         suffix=EXCLUDED.suffix,
         college_id=EXCLUDED.college_id,
         program_id=EXCLUDED.program_id,
         year_level=EXCLUDED.year_level,
         date_of_birth=EXCLUDED.date_of_birth,
         updated_at=NOW()`,
      [
        resolvedRows.map((student) => student.studentNumber),
        resolvedRows.map((student) => student.firstName),
        resolvedRows.map((student) => student.middleInitial),
        resolvedRows.map((student) => student.surname),
        resolvedRows.map((student) => student.suffix),
        resolvedRows.map((student) => student.collegeId),
        resolvedRows.map((student) => student.programId),
        resolvedRows.map((student) => student.yearLevel),
        resolvedRows.map((student) => student.dateOfBirth),
      ],
    );
    const updatedStudentNumbers = resolvedRows
      .filter((student) => student.existedBeforeImport)
      .map((student) => student.studentNumber);
    if (updatedStudentNumbers.length) {
      await client.query(
        `INSERT INTO audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
         SELECT $1, 'STUDENT_PROFILE_UPDATED_BY_IMPORT', 'student', student_number,
                jsonb_build_object('importId', $2::text)
           FROM UNNEST($3::varchar[]) AS fixture(student_number)`,
        [actorUserId, importId, updatedStudentNumbers],
      );
    }

    const schedulableRows = resolvedRows.filter((row) => !row.alreadyScheduledForCycle);
    const windowStart = resolveSchedulingWindow({
      category: input.studentCategory,
      academicYearStart: input.academicYearStart,
      preferredMonth: input.preferredMonth,
      acceptedAt: accepted.rows[0].acceptedAt.toISOString(),
      timeZone: "Asia/Manila",
    });
    const searchEndDate = `${input.academicYearStart + 5}-07-31`;
    const capacityRows = await client.query<{
      clinic_id: string;
      clinic_code: ClinicCode;
      schedule_type: AppointmentScheduleType;
      safe_daily_capacity: number;
      max_daily_capacity: number;
    }>(
      `SELECT setting.clinic_id, clinic.code AS clinic_code, setting.schedule_type,
              setting.safe_daily_capacity, setting.max_daily_capacity
         FROM clinic_capacity_settings setting
         JOIN clinics clinic ON clinic.id=setting.clinic_id
        WHERE (clinic.code='KABALAKA_CLINIC' AND setting.schedule_type='LABORATORY')
           OR (clinic.code='CPU_CLINIC' AND setting.schedule_type='PHYSICAL_EXAM')`,
    );
    const capacityByType = new Map(
      capacityRows.rows.map((row) => [row.schedule_type, row]),
    );
    const laboratoryCapacity = capacityByType.get("LABORATORY");
    const physicalExamCapacity = capacityByType.get("PHYSICAL_EXAM");
    if (!laboratoryCapacity || !physicalExamCapacity) {
      throw new AppError(
        "SCHEDULE_CAPACITY_NOT_CONFIGURED",
        "Both clinic capacity settings are required before importing schedules.",
        409,
      );
    }

    const existingLoad = await client.query<{
      clinic_code: ClinicCode;
      appointment_date: string;
      appointment_count: number;
    }>(
      `SELECT clinic.code AS clinic_code, appointment.appointment_date::text,
              COUNT(*)::int AS appointment_count
         FROM appointments appointment
         JOIN clinics clinic ON clinic.id=appointment.clinic_id
        WHERE appointment.appointment_date BETWEEN $1 AND $2
          AND appointment.status IN ('DRAFT','PENDING','COMPLETED','NO_SHOW')
        GROUP BY clinic.code, appointment.appointment_date`,
      [windowStart, searchEndDate],
    );
    const loadFor = (clinicCode: ClinicCode) => Object.fromEntries(
      existingLoad.rows
        .filter((row) => row.clinic_code === clinicCode)
        .map((row) => [row.appointment_date, row.appointment_count]),
    );
    const laboratoryLoad = loadFor("KABALAKA_CLINIC");
    const physicalExamLoad = loadFor("CPU_CLINIC");
    const blockedDates = await client.query<{ clinic_code: ClinicCode; date: string }>(
      `SELECT clinic.code AS clinic_code, blocked.date::date::text AS date
         FROM clinic_unavailable_dates unavailable
         JOIN clinics clinic ON clinic.id=unavailable.clinic_id
         CROSS JOIN LATERAL generate_series(
           GREATEST(unavailable.start_date, $1::date),
           LEAST(unavailable.end_date, $2::date),
           INTERVAL '1 day'
         ) AS blocked(date)
        WHERE unavailable.end_date >= $1::date
          AND unavailable.start_date <= $2::date`,
      [windowStart, searchEndDate],
    );
    const preferredWindowEnd = input.studentCategory === "REGULAR"
      ? `${input.academicYearStart + 1}-03-31`
      : new Date(Date.UTC(
          (input.preferredMonth ?? 8) >= 8 ? input.academicYearStart : input.academicYearStart + 1,
          input.preferredMonth ?? 8,
          0,
        )).toISOString().slice(0, 10);
    const allocationInput = () => ({
      requests: schedulableRows.map((row) => ({
        requestId: `${importId}:${row.rowNumber}`,
        studentNumber: row.studentNumber,
        category: input.studentCategory,
        acceptedAt: accepted.rows[0].acceptedAt.toISOString(),
        sourceRowOrder: row.rowNumber - 1,
        windowStart,
      })),
      laboratoryCapacity: {
        safeDailyCapacity: laboratoryCapacity.safe_daily_capacity,
        maxDailyCapacity: laboratoryCapacity.max_daily_capacity,
      },
      physicalExamCapacity: {
        safeDailyCapacity: physicalExamCapacity.safe_daily_capacity,
        maxDailyCapacity: physicalExamCapacity.max_daily_capacity,
      },
      existingLaboratoryLoad: laboratoryLoad,
      existingPhysicalExamLoad: physicalExamLoad,
      blockedLaboratoryDates: blockedDates.rows
        .filter((row) => row.clinic_code === "KABALAKA_CLINIC")
        .map((row) => row.date),
      blockedPhysicalExamDates: blockedDates.rows
        .filter((row) => row.clinic_code === "CPU_CLINIC")
        .map((row) => row.date),
      searchEndDate,
    });
    let assignments = generatePairedSchedule(allocationInput());
    const initialOverflowCount = assignments.assignments.filter(
      (assignment) => assignment.laboratoryDate > preferredWindowEnd,
    ).length;
    const displacedPairCandidates = input.studentCategory === "REGULAR"
      ? []
      : await makeCapacityForPriorityBatch({
          scheduleCycleStart: input.academicYearStart,
          windowStart,
          windowEnd: preferredWindowEnd,
          neededPairCount: initialOverflowCount,
          actorUserId,
        }, client);
    for (const candidate of displacedPairCandidates) {
      laboratoryLoad[candidate.laboratoryDate] = Math.max(
        0,
        (laboratoryLoad[candidate.laboratoryDate] ?? 0) - 1,
      );
      physicalExamLoad[candidate.physicalExamDate] = Math.max(
        0,
        (physicalExamLoad[candidate.physicalExamDate] ?? 0) - 1,
      );
    }
    if (displacedPairCandidates.length) assignments = generatePairedSchedule(allocationInput());
    const physicalExamOnlyOverflow = assignments.assignments.filter(
      (assignment) => (
        assignment.laboratoryDate <= preferredWindowEnd
        && assignment.physicalExamDate > preferredWindowEnd
      ),
    );
    const displacedPhysicalExamCandidates = input.studentCategory === "REGULAR"
      ? []
      : await makePhysicalExamCapacityForPriorityBatch({
          scheduleCycleStart: input.academicYearStart,
          windowEnd: preferredWindowEnd,
          physicalExamNotBeforeDates: physicalExamOnlyOverflow.map(
            (assignment) => nextDateAfter(assignment.laboratoryDate),
          ),
          actorUserId,
        }, client);
    for (const candidate of displacedPhysicalExamCandidates) {
      physicalExamLoad[candidate.physicalExamDate] = Math.max(
        0,
        (physicalExamLoad[candidate.physicalExamDate] ?? 0) - 1,
      );
    }
    if (displacedPhysicalExamCandidates.length) {
      assignments = generatePairedSchedule(allocationInput());
      const remainingPhysicalExamOnlyOverflowCount = assignments.assignments.filter(
        (assignment) => (
          assignment.laboratoryDate <= preferredWindowEnd
          && assignment.physicalExamDate > preferredWindowEnd
        ),
      ).length;
      if (
        remainingPhysicalExamOnlyOverflowCount
        > physicalExamOnlyOverflow.length - displacedPhysicalExamCandidates.length
      ) {
        throw new AppError(
          "PRIORITY_DISPLACEMENT_UNRESOLVED",
          "Regular appointments could not be moved without preserving the priority scheduling window.",
          409,
        );
      }
    }
    const displacedCandidates = [
      ...displacedPairCandidates,
      ...displacedPhysicalExamCandidates,
    ];
    if (assignments.unscheduledRequestIds.length) {
      throw new AppError(
        "SCHEDULE_CAPACITY_EXHAUSTED",
        "The complete import could not be assigned within the scheduling horizon.",
        409,
        { students: assignments.unscheduledRequestIds },
      );
    }

    const collegeIds = new Set(schedulableRows.map((row) => row.collegeId));
    const programIds = new Set(schedulableRows.map((row) => row.programId));
    const commonCollegeId = collegeIds.size === 1 ? [...collegeIds][0] : null;
    const commonProgramId = programIds.size === 1 ? [...programIds][0] : null;
    const batchIds: string[] = [];
    const insertBatch = async (
      clinicCode: ClinicCode,
      clinicLabel: string,
      itemCount: number,
    ) => {
      const result = await client.query<{ id: string }>(
        `INSERT INTO schedule_batches (
           clinic_id, batch_name, college_id, program_id, status, validation_summary,
           validated_by, validated_at, created_by, published_by, published_at, import_group_id
         ) SELECT clinic.id, $2, $3, $4, 'PUBLISHED', $5::jsonb,
                  $6, $7, $6, $6, $7, $8
             FROM clinics clinic WHERE clinic.code=$1
         RETURNING id`,
        [
          clinicCode,
          Array.from(`${importName} - ${clinicLabel}`).slice(0, 150).join(""),
          commonCollegeId,
          commonProgramId,
          JSON.stringify({ totalItems: itemCount, validCount: itemCount, warningCount: 0, conflictCount: 0 }),
          actorUserId,
          accepted.rows[0].acceptedAt,
          importId,
        ],
      );
      batchIds.push(result.rows[0].id);
      return result.rows[0].id;
    };
    const laboratoryBatchId = await insertBatch(
      "KABALAKA_CLINIC",
      "KABALAKA Clinic",
      assignments.assignments.length,
    );
    const physicalExamBatchId = await insertBatch(
      "CPU_CLINIC",
      "CPU Clinic",
      assignments.assignments.length,
    );

    const rowOrderByStudent = new Map(
      schedulableRows.map((row) => [row.studentNumber, row.rowNumber - 1]),
    );
    const insertItems = async (
      batchId: string,
      clinicId: string,
      scheduleType: AppointmentScheduleType,
      dates: string[],
    ) => {
      await client.query(
        `INSERT INTO coordinator_schedule_items (
           batch_id, clinic_id, student_number, schedule_type, priority_group_id,
           target_date, status, source_row_order, schedule_cycle_start
         )
         SELECT $1, $2, fixture.student_number, $3, NULL,
                fixture.target_date, 'SCHEDULED', fixture.source_row_order, $4
           FROM UNNEST($5::varchar[], $6::date[], $7::integer[])
             AS fixture(student_number, target_date, source_row_order)`,
        [
          batchId,
          clinicId,
          scheduleType,
          input.academicYearStart,
          assignments.assignments.map((assignment) => assignment.studentNumber),
          dates,
          assignments.assignments.map((assignment) => rowOrderByStudent.get(assignment.studentNumber)),
        ],
      );
    };
    await insertItems(
      laboratoryBatchId,
      laboratoryCapacity.clinic_id,
      "LABORATORY",
      assignments.assignments.map((assignment) => assignment.laboratoryDate),
    );
    await insertItems(
      physicalExamBatchId,
      physicalExamCapacity.clinic_id,
      "PHYSICAL_EXAM",
      assignments.assignments.map((assignment) => assignment.physicalExamDate),
    );

    const appointmentIds: string[] = [];
    const insertAppointments = async (
      batchId: string,
      clinicId: string,
      scheduleType: AppointmentScheduleType,
      dates: string[],
    ) => {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO appointments (
           batch_id, schedule_item_id, clinic_id, student_number, schedule_type,
           appointment_date, status, is_published, created_by, updated_by,
           schedule_pair_id, schedule_cycle_start
         )
         SELECT $1, item.id, $2, fixture.student_number, $3, fixture.appointment_date,
                'PENDING', TRUE, $4, $4, fixture.schedule_pair_id, $5
           FROM UNNEST($6::varchar[], $7::date[], $8::uuid[])
             AS fixture(student_number, appointment_date, schedule_pair_id)
           JOIN coordinator_schedule_items item
             ON item.batch_id=$1 AND item.student_number=fixture.student_number
            AND item.schedule_type=$3
         RETURNING id`,
        [
          batchId,
          clinicId,
          scheduleType,
          actorUserId,
          input.academicYearStart,
          assignments.assignments.map((assignment) => assignment.studentNumber),
          dates,
          assignments.assignments.map((assignment) => assignment.schedulePairId),
        ],
      );
      appointmentIds.push(...inserted.rows.map((row) => row.id));
    };
    await insertAppointments(
      laboratoryBatchId,
      laboratoryCapacity.clinic_id,
      "LABORATORY",
      assignments.assignments.map((assignment) => assignment.laboratoryDate),
    );
    await insertAppointments(
      physicalExamBatchId,
      physicalExamCapacity.clinic_id,
      "PHYSICAL_EXAM",
      assignments.assignments.map((assignment) => assignment.physicalExamDate),
    );
    if (appointmentIds.length) {
      await client.query(
        `INSERT INTO appointment_status_logs (appointment_id, old_status, new_status, changed_by)
         SELECT id, NULL, 'PENDING', $1 FROM UNNEST($2::uuid[]) AS fixture(id)`,
        [actorUserId, appointmentIds],
      );
    }
    await publishDisplacedRegularReplacements({
      candidates: displacedCandidates,
      sourceImportGroupId: importId,
      actorUserId,
      replacementWindowStart: nextDateAfter(preferredWindowEnd),
      searchEndDate,
    }, client);

    const laboratoryItemCount = assignments.assignments.length;
    const physicalExaminationItemCount = assignments.assignments.length;
    const allDates = assignments.assignments.flatMap(
      (assignment) => [assignment.laboratoryDate, assignment.physicalExamDate],
    ).sort();
    const generatedRange = allDates.length
      ? { startDate: allDates[0], endDate: allDates.at(-1)! }
      : null;
    const pairCountBeyondPreferredWindow = assignments.assignments.filter(
      (assignment) => assignment.laboratoryDate > preferredWindowEnd,
    ).length;
    const metadata = {
      sourceFilename: input.sourceFilename,
      batchIds,
      totalRows: input.rows.length,
      laboratoryItemCount,
      physicalExaminationItemCount,
      insertedStudentCount,
      updatedStudentCount,
      skippedStudentCount,
      studentCategory: input.studentCategory,
      academicYearStart: input.academicYearStart,
      publishedAppointmentCount: appointmentIds.length,
      generatedRange,
      pairCountBeyondPreferredWindow,
      displacementTotal: displacedCandidates.length,
    };
    await writeAudit(
      actorUserId,
      "SCHEDULE_IMPORT_PUBLISHED",
      "schedule_import_group",
      importId,
      metadata,
      client,
    );

    return {
      importId,
      outcome: "PUBLISHED",
      status: "PUBLISHED",
      totalRows: input.rows.length,
      insertedStudentCount,
      updatedStudentCount,
      skippedStudentCount,
      laboratoryItemCount,
      physicalExaminationItemCount,
      publishedAppointmentCount: appointmentIds.length,
      generatedRange,
      overflow: {
        pairCountBeyondPreferredWindow,
        unscheduledStudentCount: 0,
      },
      displacementTotal: displacedCandidates.length,
      batchIds,
    };
  });
}

type ScheduleImportSummaryRow = {
  import_id: string;
  import_name: string;
  source_filename: string;
  total_rows: number;
  created_student_count: number;
  matched_student_count: number;
  submitted_by_name: string | null;
  description: string | null;
  created_by_name: string;
  laboratory_item_count: number;
  physical_examination_item_count: number;
  child_statuses: string[];
  created_at: Date;
  updated_at: Date;
  student_category: CreateScheduleImportInput["studentCategory"] | null;
  academic_year_start: number | null;
  preferred_month: number | null;
  accepted_at: Date;
  published_metadata: Record<string, unknown> | null;
};

async function loadScheduleImportGroups(importId?: string) {
  const values = importId ? [importId] : [];
  const where = importId ? "WHERE import_group.id=$1" : "";
  const result = await query<ScheduleImportSummaryRow>(
    `SELECT import_group.id AS import_id,
            import_group.import_name,
            import_group.source_filename,
            import_group.total_rows,
            import_group.created_student_count,
            import_group.matched_student_count,
            import_group.submitted_by_name,
            import_group.description,
            import_group.student_category,
            import_group.academic_year_start,
            import_group.preferred_month,
            import_group.accepted_at,
            published_audit.metadata AS published_metadata,
            creator.full_name AS created_by_name,
            COUNT(item.id) FILTER (WHERE item.schedule_type='LABORATORY')::int
              AS laboratory_item_count,
            COUNT(item.id) FILTER (WHERE item.schedule_type='PHYSICAL_EXAM')::int
              AS physical_examination_item_count,
            COALESCE(
              ARRAY_AGG(DISTINCT batch.status) FILTER (WHERE batch.id IS NOT NULL),
              ARRAY[]::varchar[]
            ) AS child_statuses,
            import_group.created_at,
            import_group.updated_at
       FROM schedule_import_groups import_group
       JOIN users creator ON creator.id=import_group.created_by
       LEFT JOIN schedule_batches batch ON batch.import_group_id=import_group.id
       LEFT JOIN coordinator_schedule_items item ON item.batch_id=batch.id
       LEFT JOIN LATERAL (
         SELECT audit.metadata
           FROM audit_logs audit
          WHERE audit.entity_type='schedule_import_group'
            AND audit.entity_id=import_group.id::text
            AND audit.action='SCHEDULE_IMPORT_PUBLISHED'
          ORDER BY audit.created_at DESC, audit.id DESC
          LIMIT 1
       ) published_audit ON TRUE
       ${where}
       GROUP BY import_group.id, creator.full_name, published_audit.metadata
       ORDER BY import_group.created_at DESC`,
    values,
  );
  return result.rows.map((row): ScheduleImportListItem => ({
    importId: row.import_id,
    importName: row.import_name,
    sourceFilename: row.source_filename,
    totalRows: row.total_rows,
    createdStudentCount: row.created_student_count,
    matchedStudentCount: row.matched_student_count,
    submittedByName: row.submitted_by_name,
    description: row.description,
    createdByName: row.created_by_name,
    laboratoryItemCount: row.laboratory_item_count,
    physicalExaminationItemCount: row.physical_examination_item_count,
    status: deriveScheduleImportStatus(row.child_statuses),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    studentCategory: row.student_category,
    academicYearStart: row.academic_year_start,
    preferredMonth: row.preferred_month,
    acceptedAt: row.accepted_at.toISOString(),
    skippedStudentCount: Number(row.published_metadata?.skippedStudentCount ?? 0),
    generatedRange: (row.published_metadata?.generatedRange as ScheduleImportListItem["generatedRange"] | undefined) ?? null,
    overflow: {
      pairCountBeyondPreferredWindow: Number(row.published_metadata?.pairCountBeyondPreferredWindow ?? 0),
      unscheduledStudentCount: 0,
    },
    displacementTotal: Number(row.published_metadata?.displacementTotal ?? 0),
  }));
}

export async function listScheduleImportGroups(): Promise<ScheduleImportListItem[]> {
  return loadScheduleImportGroups();
}

export async function withLockedScheduleImport<T>(
  importId: string,
  callback: (client: PoolClient, children: LockedImportChild[]) => Promise<T>,
): Promise<T | null> {
  return transaction(async (client) => {
    const group = await client.query(
      "SELECT id FROM schedule_import_groups WHERE id=$1 FOR UPDATE",
      [importId],
    );
    if (!group.rowCount) return null;

    const children = await client.query<{
      id: string;
      status: string;
      clinic_code: ClinicCode;
    }>(
      `SELECT batch.id, batch.status, clinic.code AS clinic_code
         FROM schedule_batches batch
         JOIN clinics clinic ON clinic.id=batch.clinic_id
        WHERE batch.import_group_id=$1
        ORDER BY CASE clinic.code
          WHEN 'KABALAKA_CLINIC' THEN 1
          WHEN 'CPU_CLINIC' THEN 2
          ELSE 3
        END, batch.id
        FOR UPDATE OF batch`,
      [importId],
    );
    return callback(client, children.rows.map((child) => ({
      id: child.id,
      status: child.status,
      clinicCode: child.clinic_code,
    })));
  });
}

export async function touchScheduleImportGroup(
  importId: string,
  client: PoolClient,
): Promise<void> {
  await client.query(
    "UPDATE schedule_import_groups SET updated_at=NOW() WHERE id=$1",
    [importId],
  );
}

export async function getImportChildBatches(
  importId: string,
  client?: PoolClient,
): Promise<ImportChildBatch[]> {
  const sql = `SELECT batch.id
                 FROM schedule_batches batch
                 JOIN clinics clinic ON clinic.id=batch.clinic_id
                WHERE batch.import_group_id=$1
                ORDER BY CASE clinic.code
                  WHEN 'KABALAKA_CLINIC' THEN 1
                  WHEN 'CPU_CLINIC' THEN 2
                  ELSE 3
                END, batch.id`;
  const ids = client
    ? await client.query<{ id: string }>(sql, [importId])
    : await query<{ id: string }>(sql, [importId]);
  const appointmentsSql = `SELECT appointment.id,
                                  appointment.batch_id AS "batchId",
                                  appointment.student_number AS "studentNumber",
                                  ${studentDisplayNameSql("student")} AS "studentName",
                                  appointment.schedule_type AS "scheduleType",
                                  priority_group.name AS "priorityGroupName",
                                  appointment.appointment_date::text AS "appointmentDate",
                                  appointment.status,
                                  appointment.is_published AS "isPublished",
                                  appointment.notes
                             FROM appointments appointment
                             JOIN schedule_batches batch ON batch.id=appointment.batch_id
                             JOIN students student ON student.student_number=appointment.student_number
                             LEFT JOIN coordinator_schedule_items schedule_item
                               ON schedule_item.id=appointment.schedule_item_id
                             LEFT JOIN priority_groups priority_group
                               ON priority_group.id=schedule_item.priority_group_id
                            WHERE batch.import_group_id=$1
                            ORDER BY appointment.appointment_date,
                                     student.last_name, student.first_name, appointment.id`;
  const appointmentResult = client
    ? await client.query<ScheduleImportAppointment>(appointmentsSql, [importId])
    : await query<ScheduleImportAppointment>(appointmentsSql, [importId]);
  const appointmentsByBatch = new Map<string, ScheduleImportAppointment[]>();
  for (const appointment of appointmentResult.rows) {
    appointmentsByBatch.set(appointment.batchId, [
      ...(appointmentsByBatch.get(appointment.batchId) ?? []),
      appointment,
    ]);
  }
  const children: ImportChildBatch[] = [];
  for (const { id } of ids.rows) {
    const child = await getScheduleBatch(id, client);
    if (child) {
      children.push({
        ...child,
        appointments: appointmentsByBatch.get(id) ?? [],
      });
    }
  }
  return children;
}

export async function getScheduleImportGroup(
  importId: string,
): Promise<ScheduleImportDetail | null> {
  const summary = (await loadScheduleImportGroups(importId))[0];
  if (!summary) return null;
  return {
    ...summary,
    childBatches: await getImportChildBatches(importId),
  };
}
