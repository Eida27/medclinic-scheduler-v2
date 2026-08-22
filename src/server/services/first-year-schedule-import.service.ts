import "server-only";

import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";

import { AppError, isPostgresUniqueViolation } from "@/lib/errors";
import { transaction } from "@/server/db/pool";
import { applyOvpsaLowerPriorityDisplacements, planOvpsaLowerPriorityDisplacementsForServiceDates } from "@/server/ovpsa/ovpsa-first-year-displacement";
import { planFirstYearScheduleImport, type FirstYearImportPlan, type FirstYearUnavailableReason } from "@/server/ovpsa/ovpsa-first-year-import-planner";
import { loadCpuPhysicalExamMaximumCapacity, loadOvpsaClinicIds, type StoredOvpsaBatch } from "@/server/ovpsa/ovpsa-first-year.repository";
import { writeAudit } from "@/server/repositories/audit.repository";
import { lockEffectiveAppointmentScopes } from "@/server/repositories/effective-appointment-scope-lock.repository";
import { loadSchedulingBlockedDates } from "@/server/repositories/scheduling-blocked-dates.repository";
import { ensureStudentAcademicSnapshotsWithClient } from "@/server/repositories/student-academic-snapshots.repository";
import { queueAuthoritativeScheduleNotification } from "@/server/schedule/schedule-notification-hooks";
import { buildInitialPublicationNotification } from "@/server/schedule/schedule-notifications";
import type { ImportedStudentRow } from "@/server/services/student-import-csv";

type FirstYearScheduleImportInput = {
  sourceFilename: string;
  academicYearStart: number;
  laboratoryDate: string;
  rows: ImportedStudentRow[];
};

type ResolvedFirstYearRow = ImportedStudentRow & {
  collegeId: string;
  resolvedCollegeName: string;
  programId: string;
  resolvedProgramCode: string;
  resolvedProgramName: string;
};

type PreparedFirstYearImport = {
  rows: ResolvedFirstYearRow[];
  plan: FirstYearImportPlan;
  displacement: Awaited<ReturnType<typeof planOvpsaLowerPriorityDisplacementsForServiceDates>> | null;
};

function publicationPlanFingerprint(prepared: PreparedFirstYearImport) {
  return JSON.stringify({
    laboratoryDate: prepared.plan.laboratory.date,
    allocations: prepared.plan.allocations.map((allocation) => ({
      date: allocation.date,
      studentCount: allocation.studentCount,
    })),
    members: prepared.plan.members.map((member) => ({
      studentNumber: member.studentNumber,
      sourceRowNumber: member.sourceRowNumber,
      allocationPosition: member.allocationPosition,
      assignedPhysicalExamDate: member.assignedPhysicalExamDate,
    })),
    replacements: (prepared.displacement?.plannedReplacements ?? [])
      .map((replacement) => ({
        schedulePairId: replacement.candidate.schedulePairId,
        laboratoryDate: replacement.laboratoryDate,
        physicalExamDate: replacement.physicalExamDate,
      }))
      .sort((left, right) => left.schedulePairId.localeCompare(right.schedulePairId)),
  });
}

export type FirstYearScheduleImportReview = FirstYearImportPlan & {
  sourceFilename: string;
  academicYearStart: number;
};

function normalizeComparable(value: string) {
  return value.trim().toLocaleLowerCase("en-US").replace(/\s+/g, " ");
}

function addDays(date: string, days: number) {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

function isWeekday(date: string) {
  const day = new Date(`${date}T00:00:00.000Z`).getUTCDay();
  return day >= 1 && day <= 5;
}

function importedStudentName(row: ImportedStudentRow) {
  return `${row.surname}, ${row.firstName}${row.middleName ? ` ${row.middleName}` : ""}${row.suffix ? ` (${row.suffix})` : ""}`;
}

function addFieldError(
  fields: Record<string, string[]>,
  field: string,
  message: string,
) {
  fields[field] = [...(fields[field] ?? []), message];
}

async function resolveRows(
  client: PoolClient,
  rows: ImportedStudentRow[],
): Promise<ResolvedFirstYearRow[]> {
  const [colleges, programs] = await Promise.all([
    client.query<{ id: string; name: string }>(
      "SELECT id::text,name FROM colleges WHERE is_active=TRUE",
    ),
    client.query<{ id: string; college_id: string; code: string; name: string }>(
      "SELECT id::text,college_id::text,code,name FROM programs WHERE is_active=TRUE",
    ),
  ]);
  const collegeByName = new Map(
    colleges.rows.map((college) => [normalizeComparable(college.name), college]),
  );
  const programByCollegeAndCode = new Map(
    programs.rows.map((program) => [
      `${program.college_id}:${normalizeComparable(program.code)}`,
      program,
    ]),
  );
  const fields: Record<string, string[]> = {};
  const resolved = rows.map((row) => {
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
      : undefined;
    if (college && !program) {
      addFieldError(
        fields,
        `rows.${row.rowNumber}.Course`,
        "Course must match an active code in the selected college.",
      );
    }
    return {
      ...row,
      collegeId: college?.id ?? "",
      resolvedCollegeName: college?.name ?? row.collegeName,
      programId: program?.id ?? "",
      resolvedProgramCode: program?.code ?? row.courseCode,
      resolvedProgramName: program?.name ?? row.courseCode,
    };
  });
  if (Object.keys(fields).length) {
    throw new AppError(
      "CSV_IMPORT_INVALID",
      "Please correct the CSV import errors.",
      422,
      fields,
    );
  }
  return resolved;
}

async function assertAcademicCycle(
  client: PoolClient,
  input: FirstYearScheduleImportInput,
) {
  const result = await client.query<{ today: string }>(
    `SELECT (clock_timestamp() AT TIME ZONE 'Asia/Manila')::date::text AS today
       FROM academic_years
      WHERE start_year=$1
        AND closing_date >= (clock_timestamp() AT TIME ZONE 'Asia/Manila')::date`,
    [input.academicYearStart],
  );
  if (!result.rowCount) {
    throw new AppError(
      "ACADEMIC_YEAR_NOT_CONFIGURED",
      "Select an open configured academic year.",
      409,
    );
  }
  const cycleStartDate = `${input.academicYearStart}-08-01`;
  const cycleEndDate = `${input.academicYearStart + 1}-07-31`;
  if (
    input.laboratoryDate < cycleStartDate
    || input.laboratoryDate > cycleEndDate
    || input.laboratoryDate < result.rows[0].today
  ) {
    throw new AppError(
      "CSV_IMPORT_INVALID",
      "Please correct the CSV import errors.",
      422,
      { firstYearLaboratoryDate: ["Choose a current or future date inside the selected academic year."] },
    );
  }
  return { cycleStartDate, cycleEndDate };
}

function virtualBatch(
  input: FirstYearScheduleImportInput,
  rows: ResolvedFirstYearRow[],
): StoredOvpsaBatch {
  return {
    batchId: "00000000-0000-4000-8000-000000000099",
    scheduleCycleStart: input.academicYearStart,
    collegeId: rows[0].collegeId,
    collegeName: rows[0].resolvedCollegeName,
    status: "DRAFT",
    optimisticToken: "00000000-0000-4000-8000-000000000098",
    revisionId: "00000000-0000-4000-8000-000000000097",
    revisionNumber: 1,
    revisionStatus: "DRAFT",
    laboratoryDate: input.laboratoryDate,
    physicalExamDate: addDays(input.laboratoryDate, 7),
    physicalExamExceptionReason: null,
  };
}

async function prepareFirstYearImport(
  client: PoolClient,
  input: FirstYearScheduleImportInput,
  forUpdate: boolean,
): Promise<PreparedFirstYearImport> {
  const rows = await resolveRows(client, input.rows);
  const boundary = await assertAcademicCycle(client, input);
  const capacity = await loadCpuPhysicalExamMaximumCapacity(client);
  const blocked = await loadSchedulingBlockedDates(client, {
    startDate: input.laboratoryDate < addDays(input.laboratoryDate, 7)
      ? input.laboratoryDate
      : addDays(input.laboratoryDate, 7),
    endDate: boundary.cycleEndDate,
  });
  const reservations = await client.query<{
    schedule_type: "LABORATORY" | "PHYSICAL_EXAM";
    reservation_date: string;
  }>(
    `SELECT schedule_type,reservation_date::text
       FROM ovpsa_first_year_service_reservations
      WHERE status IN ('ACTIVE','INVALIDATED')
        AND reservation_date BETWEEN $1::date AND $2::date`,
    [input.laboratoryDate, boundary.cycleEndDate],
  );
  const reservedLaboratory = new Set(
    reservations.rows
      .filter((reservation) => reservation.schedule_type === "LABORATORY")
      .map((reservation) => reservation.reservation_date),
  );
  const reservedPhysicalExam = new Set(
    reservations.rows
      .filter((reservation) => reservation.schedule_type === "PHYSICAL_EXAM")
      .map((reservation) => reservation.reservation_date),
  );
  const blockedLaboratory = new Set(blocked.laboratoryDates);
  const blockedPhysicalExam = new Set(blocked.physicalExamDates);
  const laboratoryUnavailableReasons: FirstYearUnavailableReason[] = [];
  if (reservedLaboratory.has(input.laboratoryDate)) {
    laboratoryUnavailableReasons.push("FIRST_YEAR_DATE_RESERVED");
  } else if (blockedLaboratory.has(input.laboratoryDate)) {
    laboratoryUnavailableReasons.push("OFFICIAL_CLOSURE");
  }
  const firstCandidate = addDays(input.laboratoryDate, 7);
  const candidates = [] as Array<{
    date: string;
    unavailableReasons: FirstYearUnavailableReason[];
    displacementCount: number;
  }>;
  for (
    let date = firstCandidate;
    date <= boundary.cycleEndDate;
    date = addDays(date, 1)
  ) {
    const unavailableReasons: FirstYearUnavailableReason[] = [];
    if (!isWeekday(date)) unavailableReasons.push("NON_SERVICE_DAY");
    if (reservedPhysicalExam.has(date)) {
      unavailableReasons.push("FIRST_YEAR_DATE_RESERVED");
    } else if (blockedPhysicalExam.has(date)) {
      unavailableReasons.push("CPU_CLINIC_UNAVAILABLE");
    }
    candidates.push({ date, unavailableReasons, displacementCount: 0 });
  }

  const planningMembers = rows.map((row) => ({
    studentNumber: row.studentNumber,
    sourceRowNumber: row.rowNumber,
  }));
  let plan = planFirstYearScheduleImport({
    laboratoryDate: input.laboratoryDate,
    cycleStartDate: boundary.cycleStartDate,
    cycleEndDate: boundary.cycleEndDate,
    physicalExamMaximumCapacity: capacity ?? 0,
    members: planningMembers,
    laboratoryUnavailableReasons,
    physicalExamCandidates: candidates,
  });
  let displacement: PreparedFirstYearImport["displacement"] = null;
  const batch = virtualBatch(input, rows);
  while (plan.canPublish) {
    displacement = await planOvpsaLowerPriorityDisplacementsForServiceDates(client, {
      batch,
      memberStudentNumbers: rows.map((row) => row.studentNumber),
      forUpdate,
      serviceDates: {
        laboratoryDates: [input.laboratoryDate],
        physicalExamDates: plan.allocations.map((allocation) => allocation.date),
      },
    });
    const protectedLaboratory = displacement.protectedServiceDates.some(
      (conflict) => conflict.scheduleType === "LABORATORY"
        && conflict.date === input.laboratoryDate,
    );
    if (protectedLaboratory) {
      laboratoryUnavailableReasons.push("PROTECTED_APPOINTMENT_CONFLICT");
    }
    for (const conflict of displacement.protectedServiceDates) {
      const candidate = candidates.find((item) => item.date === conflict.date);
      if (candidate && !candidate.unavailableReasons.includes("PROTECTED_APPOINTMENT_CONFLICT")) {
        candidate.unavailableReasons.push("PROTECTED_APPOINTMENT_CONFLICT");
      }
    }
    for (const conflict of displacement.replacementBlockedServiceDates) {
      if (conflict.scheduleType === "LABORATORY") {
        laboratoryUnavailableReasons.push("REPLACEMENT_CAPACITY_EXHAUSTED");
        continue;
      }
      const candidate = candidates.find((item) => item.date === conflict.date);
      if (candidate && !candidate.unavailableReasons.includes("REPLACEMENT_CAPACITY_EXHAUSTED")) {
        candidate.unavailableReasons.push("REPLACEMENT_CAPACITY_EXHAUSTED");
      }
    }
    if (
      !protectedLaboratory
      && displacement.protectedConflicts.length === 0
      && displacement.blockers.length === 0
    ) {
      const displacementByDate = new Map<string, number>();
      for (const candidate of displacement.candidates) {
        const date = candidate.displacementType === "PAIR"
          ? candidate.laboratory.appointmentDate
          : candidate.physicalExam.appointmentDate;
        displacementByDate.set(date, (displacementByDate.get(date) ?? 0) + 1);
      }
      for (const candidate of candidates) {
        candidate.displacementCount = displacementByDate.get(candidate.date) ?? 0;
      }
      plan = planFirstYearScheduleImport({
        laboratoryDate: input.laboratoryDate,
        cycleStartDate: boundary.cycleStartDate,
        cycleEndDate: boundary.cycleEndDate,
        physicalExamMaximumCapacity: capacity ?? 0,
        members: planningMembers,
        laboratoryUnavailableReasons,
        physicalExamCandidates: candidates,
      });
      plan.displacementTotal = displacement.candidates.length;
      break;
    }
    plan = planFirstYearScheduleImport({
      laboratoryDate: input.laboratoryDate,
      cycleStartDate: boundary.cycleStartDate,
      cycleEndDate: boundary.cycleEndDate,
      physicalExamMaximumCapacity: capacity ?? 0,
      members: planningMembers,
      laboratoryUnavailableReasons,
      physicalExamCandidates: candidates,
    });
  }
  return { rows, plan, displacement };
}

export async function reviewFirstYearScheduleImportPlan(
  input: FirstYearScheduleImportInput,
): Promise<FirstYearScheduleImportReview> {
  return transaction(async (client) => {
    const prepared = await prepareFirstYearImport(client, input, false);
    return {
      sourceFilename: input.sourceFilename,
      academicYearStart: input.academicYearStart,
      ...prepared.plan,
    };
  });
}

async function insertStudentProfiles(
  client: PoolClient,
  rows: ResolvedFirstYearRow[],
) {
  const existing = await client.query<{ student_number: string }>(
    "SELECT student_number FROM students WHERE student_number=ANY($1::varchar[])",
    [rows.map((row) => row.studentNumber)],
  );
  const existingNumbers = new Set(existing.rows.map((row) => row.student_number));
  await client.query(
    `INSERT INTO students (
       student_number,first_name,middle_name,last_name,suffix,college_id,
       program_id,year_level,date_of_birth
     ) SELECT row.student_number,row.first_name,row.middle_name,row.last_name,
              row.suffix,row.college_id,row.program_id,1,row.date_of_birth
         FROM jsonb_to_recordset($1::jsonb) AS row(
           student_number text,first_name text,middle_name text,last_name text,
           suffix text,college_id uuid,program_id uuid,date_of_birth date
         )
       ON CONFLICT (student_number) DO UPDATE SET
         first_name=EXCLUDED.first_name,middle_name=EXCLUDED.middle_name,
         last_name=EXCLUDED.last_name,suffix=EXCLUDED.suffix,
         college_id=EXCLUDED.college_id,program_id=EXCLUDED.program_id,
         year_level=1,date_of_birth=EXCLUDED.date_of_birth,updated_at=clock_timestamp()`,
    [JSON.stringify(rows.map((row) => ({
      student_number: row.studentNumber,
      first_name: row.firstName,
      middle_name: row.middleName,
      last_name: row.surname,
      suffix: row.suffix,
      college_id: row.collegeId,
      program_id: row.programId,
      date_of_birth: row.dateOfBirth,
    })))],
  );
  return {
    insertedStudentCount: rows.filter((row) => !existingNumbers.has(row.studentNumber)).length,
    updatedStudentCount: rows.filter((row) => existingNumbers.has(row.studentNumber)).length,
  };
}

export async function publishFirstYearScheduleImport(
  input: FirstYearScheduleImportInput,
  actorUserId: string,
) {
  try {
    return await transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('medclinic:schedule-import-queue'))");
      const preflight = await prepareFirstYearImport(client, input, false);
      if (!preflight.plan.canPublish || !preflight.displacement) {
        throw new AppError(
          "FIRST_YEAR_IMPORT_NOT_PUBLISHABLE",
          "The complete First Year import cannot be scheduled. Nothing was published.",
          409,
          undefined,
          preflight.plan,
        );
      }
      for (const key of [
        `LABORATORY:${input.laboratoryDate}`,
        ...preflight.plan.allocations.map((allocation) => `PHYSICAL_EXAM:${allocation.date}`),
      ].sort()) {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          `medclinic:ovpsa-service-date:v1:${key}`,
        ]);
      }
      await lockEffectiveAppointmentScopes(client, [
        ...preflight.rows.flatMap((row) => [
          { studentNumber: row.studentNumber, scheduleType: "LABORATORY" as const },
          { studentNumber: row.studentNumber, scheduleType: "PHYSICAL_EXAM" as const },
        ]),
        ...preflight.displacement.candidates.flatMap((candidate) =>
          candidate.displacementType === "PAIR"
            ? [
                { studentNumber: candidate.studentNumber, scheduleType: "LABORATORY" as const },
                { studentNumber: candidate.studentNumber, scheduleType: "PHYSICAL_EXAM" as const },
              ]
            : [{ studentNumber: candidate.studentNumber, scheduleType: "PHYSICAL_EXAM" as const }],
        ),
      ]);
      const prepared = await prepareFirstYearImport(client, input, true);
      if (!prepared.plan.canPublish || !prepared.displacement) {
        throw new AppError(
          "FIRST_YEAR_IMPORT_STALE",
          "Schedule availability changed after review. Nothing was published.",
          409,
          undefined,
          prepared.plan,
        );
      }
      if (publicationPlanFingerprint(prepared) !== publicationPlanFingerprint(preflight)) {
        throw new AppError(
          "FIRST_YEAR_IMPORT_STALE",
          "Schedule availability changed during confirmation. Nothing was published.",
          409,
          undefined,
          prepared.plan,
        );
      }

      const accepted = await client.query<{ accepted_at: Date }>(
        "SELECT clock_timestamp() AS accepted_at",
      );
      const acceptedAt = accepted.rows[0].accepted_at;
      const importId = randomUUID();
      const importName = Array.from(
        `First Year ${input.academicYearStart}-${input.academicYearStart + 1} - ${input.sourceFilename}`,
      ).slice(0, 150).join("");
      const counts = await insertStudentProfiles(client, prepared.rows);
      await client.query(
        `INSERT INTO schedule_import_groups (
           id,import_name,source_filename,total_rows,created_student_count,
           matched_student_count,created_by,student_category,academic_year_start,
           preferred_month,accepted_at,import_mode,first_year_laboratory_date
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,'REGULAR',$8,NULL,$9,
                   'FIRST_YEAR_OVPSA',$10)`,
        [
          importId,
          importName,
          input.sourceFilename,
          prepared.rows.length,
          counts.insertedStudentCount,
          counts.updatedStudentCount,
          actorUserId,
          input.academicYearStart,
          acceptedAt,
          input.laboratoryDate,
        ],
      );
      const snapshotResult = await ensureStudentAcademicSnapshotsWithClient(client, {
        actorUserId,
        candidates: prepared.rows.map((row) => ({
          studentNumber: row.studentNumber,
          academicYearStart: input.academicYearStart,
          studentName: importedStudentName(row),
          collegeId: row.collegeId,
          collegeName: row.resolvedCollegeName,
          programId: row.programId,
          programCode: row.resolvedProgramCode,
          programName: row.resolvedProgramName,
          yearLevel: 1,
          sourceImportGroupId: importId,
          sourceType: "OVPSA_PUBLICATION" as const,
          sourceMetadata: {
            importMode: "FIRST_YEAR_OVPSA",
            sourceFilename: input.sourceFilename,
            sourceRowNumber: row.rowNumber,
          },
        })),
      });
      if (snapshotResult.outcome === "CONFLICT") {
        throw new AppError(
          "SNAPSHOT_CONFLICT",
          "Publication conflicts with immutable academic history.",
          409,
          undefined,
          { conflicts: snapshotResult.conflicts },
        );
      }
      const snapshotRows = await client.query<{ id: string; student_number: string }>(
        `SELECT id::text,student_number FROM student_academic_snapshots
          WHERE academic_year_start=$1 AND student_number=ANY($2::varchar[])`,
        [input.academicYearStart, prepared.rows.map((row) => row.studentNumber)],
      );
      const snapshotIdByStudent = new Map(
        snapshotRows.rows.map((snapshot) => [snapshot.student_number, snapshot.id]),
      );
      const batch = await client.query<{ id: string }>(
        `INSERT INTO ovpsa_first_year_batches (
           schedule_cycle_start,college_id,status,created_by,updated_by,source_import_group_id
         ) VALUES ($1,NULL,'DRAFT',$2,$2,$3) RETURNING id::text`,
        [input.academicYearStart, actorUserId, importId],
      );
      const batchId = batch.rows[0].id;
      const revision = await client.query<{ id: string }>(
        `INSERT INTO ovpsa_first_year_batch_revisions (
           batch_id,revision_number,status,laboratory_date,physical_exam_date,
           validation_snapshot,validated_by,validated_at,published_by,published_at,created_by
         ) VALUES ($1,1,'PUBLISHED',$2,$3,$4::jsonb,$5,$6,$5,$6,$5)
         RETURNING id::text`,
        [
          batchId,
          input.laboratoryDate,
          prepared.plan.firstPhysicalExamCandidate,
          JSON.stringify(prepared.plan),
          actorUserId,
          acceptedAt,
        ],
      );
      const revisionId = revision.rows[0].id;
      const reservationInput = [
        { schedule_type: "LABORATORY", reservation_date: input.laboratoryDate },
        ...prepared.plan.allocations.map((allocation) => ({
          schedule_type: "PHYSICAL_EXAM",
          reservation_date: allocation.date,
        })),
      ];
      const reservations = await client.query<{
        id: string;
        schedule_type: "LABORATORY" | "PHYSICAL_EXAM";
        reservation_date: string;
      }>(
        `INSERT INTO ovpsa_first_year_service_reservations (
           batch_id,revision_id,schedule_type,reservation_date,status,created_by
         ) SELECT $1,$2,row.schedule_type,row.reservation_date,'ACTIVE',$3
             FROM jsonb_to_recordset($4::jsonb) AS row(schedule_type text,reservation_date date)
         RETURNING id::text,schedule_type,reservation_date::text`,
        [batchId, revisionId, actorUserId, JSON.stringify(reservationInput)],
      );
      const laboratoryReservationId = reservations.rows.find(
        (reservation) => reservation.schedule_type === "LABORATORY",
      )!.id;
      const physicalReservationByDate = Object.fromEntries(
        reservations.rows
          .filter((reservation) => reservation.schedule_type === "PHYSICAL_EXAM")
          .map((reservation) => [reservation.reservation_date, reservation.id]),
      );
      const resolvedByStudent = new Map(
        prepared.rows.map((row) => [row.studentNumber, row]),
      );
      await client.query(
        `INSERT INTO ovpsa_first_year_membership_snapshots (
           revision_id,batch_id,student_number,academic_snapshot_id,student_name,
           college_id,college_name,program_id,program_code,program_name,year_level,
           source_row_number,allocation_position,assigned_pe_reservation_id
         ) SELECT $1,$2,row.student_number,row.academic_snapshot_id,row.student_name,
                  row.college_id,row.college_name,row.program_id,row.program_code,
                  row.program_name,1,row.source_row_number,row.allocation_position,
                  row.assigned_pe_reservation_id
             FROM jsonb_to_recordset($3::jsonb) AS row(
               student_number text,academic_snapshot_id uuid,student_name text,
               college_id uuid,college_name text,program_id uuid,program_code text,
               program_name text,source_row_number integer,allocation_position integer,
               assigned_pe_reservation_id uuid
             )`,
        [
          revisionId,
          batchId,
          JSON.stringify(prepared.plan.members.map((member) => {
            const row = resolvedByStudent.get(member.studentNumber)!;
            return {
              student_number: member.studentNumber,
              academic_snapshot_id: snapshotIdByStudent.get(member.studentNumber),
              student_name: importedStudentName(row),
              college_id: row.collegeId,
              college_name: row.resolvedCollegeName,
              program_id: row.programId,
              program_code: row.resolvedProgramCode,
              program_name: row.resolvedProgramName,
              source_row_number: member.sourceRowNumber,
              allocation_position: member.allocationPosition,
              assigned_pe_reservation_id: physicalReservationByDate[member.assignedPhysicalExamDate],
            };
          })),
        ],
      );
      await client.query(
        `INSERT INTO ovpsa_first_year_active_memberships (
           batch_id,revision_id,student_number,schedule_cycle_start
         ) SELECT $1,$2,UNNEST($3::varchar[]),$4`,
        [batchId, revisionId, prepared.rows.map((row) => row.studentNumber), input.academicYearStart],
      );

      const clinicIds = await loadOvpsaClinicIds(client);
      const laboratoryClinicId = clinicIds.get("KABALAKA_CLINIC");
      const physicalExamClinicId = clinicIds.get("CPU_CLINIC");
      if (!laboratoryClinicId || !physicalExamClinicId) {
        throw new AppError("OVPSA_CLINIC_CONFIGURATION_MISSING", "Required clinics are missing.", 409);
      }
      const commonCollegeId = new Set(prepared.rows.map((row) => row.collegeId)).size === 1
        ? prepared.rows[0].collegeId
        : null;
      const commonProgramId = new Set(prepared.rows.map((row) => row.programId)).size === 1
        ? prepared.rows[0].programId
        : null;
      const insertBatch = async (clinicId: string, label: string) => {
        const result = await client.query<{ id: string }>(
          `INSERT INTO schedule_batches (
             clinic_id,batch_name,college_id,program_id,status,validation_summary,
             validated_by,validated_at,created_by,published_by,published_at,import_group_id
           ) VALUES ($1,$2,$3,$4,'PUBLISHED',$5::jsonb,$6,$7,$6,$6,$7,$8)
           RETURNING id::text`,
          [
            clinicId,
            Array.from(`${importName} - ${label}`).slice(0, 150).join(""),
            commonCollegeId,
            commonProgramId,
            JSON.stringify({ totalItems: prepared.rows.length, validCount: prepared.rows.length, conflictCount: 0 }),
            actorUserId,
            acceptedAt,
            importId,
          ],
        );
        return result.rows[0].id;
      };
      const laboratoryBatchId = await insertBatch(laboratoryClinicId, "Iloilo Mission Hospital Laboratory");
      const physicalExamBatchId = await insertBatch(physicalExamClinicId, "CPU Clinic Physical Examination");
      const batchForDisplacement: StoredOvpsaBatch = {
        ...virtualBatch(input, prepared.rows),
        batchId,
        revisionId,
        revisionStatus: "PUBLISHED",
      };
      const displacementResult = await applyOvpsaLowerPriorityDisplacements(client, {
        batch: batchForDisplacement,
        actorUserId,
        plannedReplacements: prepared.displacement.plannedReplacements,
        laboratoryReservationId,
        physicalExamReservationIdsByDate: physicalReservationByDate,
      });
      const pairs = prepared.plan.members.map((member) => ({
        ...member,
        schedulePairId: randomUUID(),
      }));
      const insertItems = async (
        batchIdValue: string,
        clinicId: string,
        scheduleType: "LABORATORY" | "PHYSICAL_EXAM",
        dates: string[],
      ) => {
        await client.query(
          `INSERT INTO coordinator_schedule_items (
             batch_id,clinic_id,student_number,schedule_type,priority_group_id,
             target_date,status,source_row_order,schedule_cycle_start
           ) SELECT $1,$2,row.student_number,$3,NULL,row.target_date,'SCHEDULED',
                    row.source_row_order,$4
               FROM UNNEST($5::varchar[],$6::date[],$7::integer[])
                 AS row(student_number,target_date,source_row_order)`,
          [
            batchIdValue,
            clinicId,
            scheduleType,
            input.academicYearStart,
            pairs.map((pair) => pair.studentNumber),
            dates,
            pairs.map((pair) => pair.sourceRowNumber - 1),
          ],
        );
      };
      await insertItems(
        laboratoryBatchId,
        laboratoryClinicId,
        "LABORATORY",
        pairs.map(() => input.laboratoryDate),
      );
      await insertItems(
        physicalExamBatchId,
        physicalExamClinicId,
        "PHYSICAL_EXAM",
        pairs.map((pair) => pair.assignedPhysicalExamDate),
      );
      const appointments = await client.query<{ id: string }>(
        `INSERT INTO appointments (
           batch_id,schedule_item_id,clinic_id,student_number,schedule_type,
           appointment_date,status,is_published,notes,created_by,updated_by,
           schedule_pair_id,schedule_cycle_start,ovpsa_batch_id,ovpsa_revision_id,
           ovpsa_service_reservation_id,scheduling_category,scheduling_accepted_at,
           scheduling_source_row_order
         )
         SELECT $1::uuid,item.id,$2::uuid,row.student_number,'LABORATORY',$3::date,'PENDING',TRUE,
                'External Laboratory at Iloilo Mission Hospital.',$8::uuid,$8::uuid,row.schedule_pair_id,
                $4::integer,$9::uuid,$10::uuid,$11::uuid,'REGULAR',$12::timestamptz,row.source_row_order
           FROM jsonb_to_recordset($7::jsonb) AS row(
             student_number text,schedule_pair_id uuid,physical_exam_date date,
             physical_reservation_id uuid,source_row_order integer
           )
           JOIN coordinator_schedule_items item ON item.batch_id=$1
            AND item.student_number=row.student_number AND item.schedule_type='LABORATORY'
         UNION ALL
         SELECT $5::uuid,item.id,$6::uuid,row.student_number,'PHYSICAL_EXAM',row.physical_exam_date,
                'PENDING',TRUE,'First Year OVPSA Physical Examination at CPU Clinic.',$8::uuid,$8::uuid,
                row.schedule_pair_id,$4::integer,$9::uuid,$10::uuid,row.physical_reservation_id,'REGULAR',$12::timestamptz,
                row.source_row_order
           FROM jsonb_to_recordset($7::jsonb) AS row(
             student_number text,schedule_pair_id uuid,physical_exam_date date,
             physical_reservation_id uuid,source_row_order integer
           )
           JOIN coordinator_schedule_items item ON item.batch_id=$5
            AND item.student_number=row.student_number AND item.schedule_type='PHYSICAL_EXAM'
         RETURNING id::text`,
        [
          laboratoryBatchId,
          laboratoryClinicId,
          input.laboratoryDate,
          input.academicYearStart,
          physicalExamBatchId,
          physicalExamClinicId,
          JSON.stringify(pairs.map((pair) => ({
            student_number: pair.studentNumber,
            schedule_pair_id: pair.schedulePairId,
            physical_exam_date: pair.assignedPhysicalExamDate,
            physical_reservation_id: physicalReservationByDate[pair.assignedPhysicalExamDate],
            source_row_order: pair.sourceRowNumber - 1,
          }))),
          actorUserId,
          batchId,
          revisionId,
          laboratoryReservationId,
          acceptedAt,
        ],
      );
      await client.query(
        `INSERT INTO appointment_status_logs (appointment_id,old_status,new_status,notes,changed_by)
         SELECT id,NULL,'PENDING','Published by First Year schedule import.',$2
           FROM UNNEST($1::uuid[]) row(id)`,
        [appointments.rows.map((appointment) => appointment.id), actorUserId],
      );
      for (const pair of pairs) {
        await queueAuthoritativeScheduleNotification(
          client,
          pair.studentNumber,
          (state) => buildInitialPublicationNotification({
            state,
            sourceType: "SCHEDULE_IMPORT_GROUP",
            sourceId: importId,
          }),
        );
      }
      const allDates = [
        input.laboratoryDate,
        ...prepared.plan.allocations.map((allocation) => allocation.date),
      ].sort();
      const auditMetadata = {
        importId,
        batchId,
        revisionId,
        sourceFilename: input.sourceFilename,
        academicYearStart: input.academicYearStart,
        laboratoryDate: input.laboratoryDate,
        allocations: prepared.plan.allocations,
        skippedDates: prepared.plan.skippedDates,
        displacedStudentCount: displacementResult.displacedCount,
        skippedStudentCount: 0,
        pairCountBeyondPreferredWindow: 0,
        generatedRange: { startDate: allDates[0], endDate: allDates.at(-1)! },
      };
      await writeAudit(actorUserId, "FIRST_YEAR_IMPORT_CONFIRMED", "schedule_import_group", importId, auditMetadata, client);
      await writeAudit(actorUserId, "OVPSA_FIRST_YEAR_BATCH_AUTOMATICALLY_PUBLISHED", "ovpsa_first_year_batch", batchId, auditMetadata, client);
      await writeAudit(actorUserId, "SCHEDULE_IMPORT_PUBLISHED", "schedule_import_group", importId, {
        ...auditMetadata,
        publishedAppointmentCount: appointments.rows.length,
        displacementTotal: displacementResult.displacedCount,
        firstYearSummary: prepared.plan,
      }, client);
      await client.query(
        `UPDATE ovpsa_first_year_batches
            SET status='PUBLISHED',current_revision_id=$2,published_by=$3,published_at=$4,
                optimistic_token=gen_random_uuid(),updated_by=$3
          WHERE id=$1`,
        [batchId, revisionId, actorUserId, acceptedAt],
      );
      return {
        importId,
        outcome: "PUBLISHED" as const,
        status: "PUBLISHED" as const,
        totalRows: prepared.rows.length,
        insertedStudentCount: counts.insertedStudentCount,
        updatedStudentCount: counts.updatedStudentCount,
        skippedStudentCount: 0,
        laboratoryItemCount: prepared.rows.length,
        physicalExaminationItemCount: prepared.rows.length,
        publishedAppointmentCount: appointments.rows.length,
        generatedRange: { startDate: allDates[0], endDate: allDates.at(-1)! },
        overflow: { pairCountBeyondPreferredWindow: 0, unscheduledStudentCount: 0 },
        displacementTotal: displacementResult.displacedCount,
        batchIds: [laboratoryBatchId, physicalExamBatchId],
        importMode: "FIRST_YEAR_OVPSA" as const,
        firstYearSummary: {
          laboratory: prepared.plan.laboratory,
          firstPhysicalExamCandidate: prepared.plan.firstPhysicalExamCandidate,
          physicalExamMaximumCapacity: prepared.plan.physicalExamMaximumCapacity,
          allocations: prepared.plan.allocations,
          skippedDates: prepared.plan.skippedDates,
          displacementTotal: displacementResult.displacedCount,
          appointmentCount: appointments.rows.length,
          batchId,
          revisionId,
        },
      };
    });
  } catch (error) {
    if (isPostgresUniqueViolation(error)) {
      throw new AppError(
        "FIRST_YEAR_PUBLICATION_CONFLICT",
        "Another First Year publication claimed a member or service date. Nothing was published.",
        409,
      );
    }
    throw error;
  }
}
