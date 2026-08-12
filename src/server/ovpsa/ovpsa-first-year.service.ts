import "server-only";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";

import { AppError, isPostgresUniqueViolation } from "@/lib/errors";
import { query, transaction } from "@/server/db/pool";
import { writeAudit } from "@/server/repositories/audit.repository";
import { lockEffectiveAppointmentScopes } from "@/server/repositories/effective-appointment-scope-lock.repository";
import { loadSchedulingBlockedDates } from "@/server/repositories/scheduling-blocked-dates.repository";
import { ensureStudentAcademicSnapshotsWithClient } from "@/server/repositories/student-academic-snapshots.repository";
import { loadAppointmentResultProtectionStates } from "@/server/repositories/student-result-submissions.repository";
import { createStudentNotifications } from "@/server/services/student-notifications.service";
import {
  buildOvpsaBatchPreview,
  type OvpsaBatchPreview,
  type OvpsaProtectedConflict,
} from "./ovpsa-first-year-planner";
import {
  loadCpuPhysicalExamMaximumCapacity,
  loadCurrentMemberAppointments,
  loadEligibleFirstYearStudents,
  loadOvpsaBatchWithCurrentRevision,
  loadOvpsaClinicIds,
  type OvpsaExistingAppointment,
  type StoredOvpsaBatch,
} from "./ovpsa-first-year.repository";
import {
  applyOvpsaLowerPriorityDisplacements,
  planOvpsaLowerPriorityDisplacements,
} from "./ovpsa-first-year-displacement";
import { restoreAppointmentsDisplacedByReservationsWithClient } from "./ovpsa-first-year-lifecycle";

export type CreateOvpsaFirstYearBatchInput = {
  scheduleCycleStart: number;
  collegeId: string;
  laboratoryDate: string;
  physicalExamDateOverride: string | null;
  physicalExamExceptionReason: string | null;
};

type TokenInput = { optimisticToken: string };
type PreviewWithToken = OvpsaBatchPreview & {
  batchId: string;
  revisionId: string;
  optimisticToken: string;
};

function addDays(date: string, days: number) {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days))
    .toISOString()
    .slice(0, 10);
}

function assertToken(batch: StoredOvpsaBatch, optimisticToken: string) {
  if (batch.optimisticToken !== optimisticToken) {
    throw new AppError(
      "OVPSA_BATCH_STALE",
      "This First Year batch changed. Refresh and try again.",
      409,
    );
  }
}

function cycleBoundary(scheduleCycleStart: number) {
  return {
    startDate: `${scheduleCycleStart}-08-01`,
    endDate: `${scheduleCycleStart + 1}-07-31`,
  };
}

function classifyMemberAppointments(
  appointments: OvpsaExistingAppointment[],
  protections: Awaited<
    ReturnType<typeof loadAppointmentResultProtectionStates>
  >,
) {
  const byStudent = new Map<string, OvpsaExistingAppointment[]>();
  for (const appointment of appointments) {
    byStudent.set(appointment.studentNumber, [
      ...(byStudent.get(appointment.studentNumber) ?? []),
      appointment,
    ]);
  }
  const supersededByStudent = new Map<
    string,
    {
      laboratory: OvpsaExistingAppointment;
      physicalExam: OvpsaExistingAppointment;
    }
  >();
  const protectedConflicts: OvpsaProtectedConflict[] = [];
  for (const [studentNumber, studentAppointments] of byStudent) {
    const addConflict = (
      appointment: OvpsaExistingAppointment,
      reasonCode: string,
      message: string,
    ) =>
      protectedConflicts.push({
        studentNumber,
        appointmentId: appointment.id,
        scheduleType: appointment.scheduleType,
        appointmentDate: appointment.appointmentDate,
        reasonCode,
        message,
      });
    const intrinsicallyProtected = studentAppointments.find(
      (appointment) =>
        appointment.status !== "PENDING" ||
        appointment.isManuallyLocked ||
        appointment.ovpsaBatchId !== null ||
        protections.get(appointment.id)?.type === "PROTECTED",
    );
    if (intrinsicallyProtected) {
      const protection = protections.get(intrinsicallyProtected.id);
      addConflict(
        intrinsicallyProtected,
        intrinsicallyProtected.ovpsaBatchId
          ? "ACTIVE_OVPSA_MEMBERSHIP"
          : intrinsicallyProtected.isManuallyLocked
            ? "APPOINTMENT_MANUALLY_LOCKED"
            : protection?.type === "PROTECTED"
              ? protection.reason
              : `APPOINTMENT_${intrinsicallyProtected.status}`,
        protection?.type === "PROTECTED"
          ? protection.message
          : "An existing completed, protected, or First Year appointment blocks publication.",
      );
      continue;
    }
    const laboratory = studentAppointments.filter(
      (appointment) => appointment.scheduleType === "LABORATORY",
    );
    const physicalExams = studentAppointments.filter(
      (appointment) => appointment.scheduleType === "PHYSICAL_EXAM",
    );
    if (
      laboratory.length !== 1 ||
      physicalExams.length !== 1 ||
      !laboratory[0].schedulePairId ||
      laboratory[0].schedulePairId !== physicalExams[0].schedulePairId
    ) {
      addConflict(
        studentAppointments[0],
        "INCONSISTENT_MEMBER_APPOINTMENTS",
        "The student's current Laboratory and Physical Examination pair is incomplete or inconsistent.",
      );
      continue;
    }
    supersededByStudent.set(studentNumber, {
      laboratory: laboratory[0],
      physicalExam: physicalExams[0],
    });
  }
  return { protectedConflicts, supersededByStudent };
}

async function planWithClient(
  client: PoolClient,
  batch: StoredOvpsaBatch,
  options: { forPublication: boolean },
) {
  const boundary = cycleBoundary(batch.scheduleCycleStart);
  const students = await loadEligibleFirstYearStudents(client, {
    collegeId: batch.collegeId,
  });
  const capacity = await loadCpuPhysicalExamMaximumCapacity(client);
  const blocked = await loadSchedulingBlockedDates(client, {
    startDate: boundary.startDate,
    endDate: boundary.endDate,
    excludeOvpsaBatchId: batch.batchId,
  });
  const todayRow = await client.query<{ today: string }>(
    "SELECT (clock_timestamp() AT TIME ZONE 'Asia/Manila')::date::text AS today",
  );
  const globalClosures = await client.query<{ date: string }>(
    `SELECT blocked_date::text AS date
       FROM clinic_unavailable_dates
      WHERE blocked_date BETWEEN $1::date AND $2::date
        AND reopened_at IS NULL
      ORDER BY blocked_date`,
    [boundary.startDate, boundary.endDate],
  );
  if (capacity === null) {
    throw new AppError(
      "SCHEDULE_CAPACITY_NOT_CONFIGURED",
      "CPU Clinic Physical Examination capacity is not configured.",
      409,
    );
  }
  const eligible = students.filter(
    (student) => student.isActive && student.yearLevel === 1,
  );
  const memberAppointments = await loadCurrentMemberAppointments(client, {
    studentNumbers: eligible.map((student) => student.studentNumber),
    scheduleCycleStart: batch.scheduleCycleStart,
    forUpdate: options.forPublication,
  });
  const protections = await loadAppointmentResultProtectionStates(
    client,
    memberAppointments.map((appointment) => appointment.id),
  );
  const memberState = classifyMemberAppointments(
    memberAppointments,
    protections,
  );
  const displacementState = await planOvpsaLowerPriorityDisplacements(client, {
    batch,
    memberStudentNumbers: eligible.map((student) => student.studentNumber),
    forUpdate: options.forPublication,
  });
  const globallyClosedDates = globalClosures.rows.map((row) => row.date);
  const preview = buildOvpsaBatchPreview({
    scheduleCycleStart: batch.scheduleCycleStart,
    cycleStartDate: boundary.startDate,
    cycleEndDate: boundary.endDate,
    collegeId: batch.collegeId,
    laboratoryDate: batch.laboratoryDate,
    physicalExamDateOverride:
      batch.physicalExamDate === addDays(batch.laboratoryDate, 7)
        ? null
        : batch.physicalExamDate,
    physicalExamExceptionReason: batch.physicalExamExceptionReason,
    today: todayRow.rows[0].today,
    students,
    cpuPhysicalExamMaximumCapacity: capacity,
    globallyClosedDates,
    reservedLaboratoryDates: blocked.laboratoryDates.filter(
      (date) => !globallyClosedDates.includes(date),
    ),
    reservedPhysicalExamDates: blocked.physicalExamDates.filter(
      (date) => !globallyClosedDates.includes(date),
    ),
    protectedConflicts: [
      ...memberState.protectedConflicts,
      ...displacementState.protectedConflicts,
    ],
    displacements: displacementState.displacements,
    proposedReplacements: displacementState.proposedReplacements,
    additionalBlockers: displacementState.blockers,
  });
  return { preview, ...memberState, ...displacementState };
}

export async function createOvpsaFirstYearBatch(
  input: CreateOvpsaFirstYearBatchInput,
  actorUserId: string,
) {
  const defaultPhysicalExamDate = addDays(input.laboratoryDate, 7);
  const physicalExamDate =
    input.physicalExamDateOverride ?? defaultPhysicalExamDate;
  const exceptionReason = input.physicalExamExceptionReason?.trim() || null;
  if (physicalExamDate < defaultPhysicalExamDate) {
    throw new AppError(
      "OVPSA_PHYSICAL_EXAM_OVERRIDE_TOO_EARLY",
      "A Physical Examination exception cannot be earlier than Laboratory plus seven days.",
      422,
    );
  }
  if (physicalExamDate > defaultPhysicalExamDate && !exceptionReason) {
    throw new AppError(
      "OVPSA_PHYSICAL_EXAM_EXCEPTION_REASON_REQUIRED",
      "A later Physical Examination date requires a reason.",
      422,
    );
  }
  return transaction(async (client) => {
    const valid = await client.query(
      `SELECT 1
         FROM academic_years year
         JOIN colleges college ON college.id=$2 AND college.is_active=TRUE
        WHERE year.start_year=$1
          AND year.closing_date >= (clock_timestamp() AT TIME ZONE 'Asia/Manila')::date`,
      [input.scheduleCycleStart, input.collegeId],
    );
    if (!valid.rowCount) {
      throw new AppError(
        "OVPSA_ACADEMIC_YEAR_OR_COLLEGE_UNAVAILABLE",
        "Select an open configured academic year and active college.",
        409,
      );
    }
    const batch = await client.query<{ id: string; optimistic_token: string }>(
      `INSERT INTO ovpsa_first_year_batches (
         schedule_cycle_start,college_id,status,created_by,updated_by
       ) VALUES ($1,$2,'DRAFT',$3,$3)
       RETURNING id::text,optimistic_token::text`,
      [input.scheduleCycleStart, input.collegeId, actorUserId],
    );
    const revision = await client.query<{ id: string }>(
      `INSERT INTO ovpsa_first_year_batch_revisions (
         batch_id,revision_number,status,laboratory_date,physical_exam_date,
         physical_exam_exception_reason,created_by
       ) VALUES ($1,1,'DRAFT',$2,$3,$4,$5)
       RETURNING id::text`,
      [
        batch.rows[0].id,
        input.laboratoryDate,
        physicalExamDate,
        physicalExamDate === defaultPhysicalExamDate ? null : exceptionReason,
        actorUserId,
      ],
    );
    await client.query(
      "UPDATE ovpsa_first_year_batches SET current_revision_id=$2 WHERE id=$1",
      [batch.rows[0].id, revision.rows[0].id],
    );
    await writeAudit(
      actorUserId,
      "OVPSA_FIRST_YEAR_BATCH_CREATED",
      "ovpsa_first_year_batch",
      batch.rows[0].id,
      { ...input, revisionId: revision.rows[0].id, physicalExamDate },
      client,
    );
    return {
      batchId: batch.rows[0].id,
      revisionId: revision.rows[0].id,
      status: "DRAFT" as const,
      optimisticToken: batch.rows[0].optimistic_token,
    };
  });
}

export async function validateOvpsaFirstYearBatch(
  batchId: string,
  input: TokenInput,
  actorUserId: string,
): Promise<PreviewWithToken> {
  return transaction(async (client) => {
    const batch = await loadOvpsaBatchWithCurrentRevision(
      client,
      batchId,
      true,
    );
    if (!batch)
      throw new AppError(
        "OVPSA_BATCH_NOT_FOUND",
        "First Year batch not found.",
        404,
      );
    assertToken(batch, input.optimisticToken);
    if (
      batch.status !== "DRAFT" ||
      !["DRAFT", "VALIDATED"].includes(batch.revisionStatus)
    ) {
      throw new AppError(
        "OVPSA_BATCH_NOT_EDITABLE",
        "Only a draft First Year batch can be validated.",
        409,
      );
    }
    const { preview } = await planWithClient(client, batch, {
      forPublication: false,
    });
    const nextToken = randomUUID();
    if (preview.canPublish) {
      await client.query(
        `UPDATE ovpsa_first_year_batch_revisions
            SET status='VALIDATED',validation_snapshot=$2::jsonb,
                validated_by=$3,validated_at=clock_timestamp()
          WHERE id=$1`,
        [batch.revisionId, JSON.stringify(preview), actorUserId],
      );
    }
    await client.query(
      "UPDATE ovpsa_first_year_batches SET optimistic_token=$2,updated_by=$3 WHERE id=$1",
      [batchId, nextToken, actorUserId],
    );
    await writeAudit(
      actorUserId,
      "OVPSA_FIRST_YEAR_BATCH_VALIDATED",
      "ovpsa_first_year_batch",
      batchId,
      {
        revisionId: batch.revisionId,
        canPublish: preview.canPublish,
        blockers: preview.blockers,
      },
      client,
    );
    return {
      ...preview,
      batchId,
      revisionId: batch.revisionId,
      optimisticToken: nextToken,
    };
  });
}

async function lockPublicationKeys(
  client: PoolClient,
  batch: StoredOvpsaBatch,
) {
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtext('medclinic:schedule-import-queue'))",
  );
  for (const key of [
    `LABORATORY:${batch.laboratoryDate}`,
    `PHYSICAL_EXAM:${batch.physicalExamDate}`,
  ].sort()) {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `medclinic:ovpsa-service-date:v1:${key}`,
    ]);
  }
}

export async function publishOvpsaFirstYearBatch(
  batchId: string,
  input: TokenInput,
  actorUserId: string,
) {
  try {
    return await transaction(async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext('medclinic:schedule-import-queue'))",
      );
      const batch = await loadOvpsaBatchWithCurrentRevision(
        client,
        batchId,
        true,
      );
      if (!batch)
        throw new AppError(
          "OVPSA_BATCH_NOT_FOUND",
          "First Year batch not found.",
          404,
        );
      assertToken(batch, input.optimisticToken);
      if (batch.status !== "DRAFT" || batch.revisionStatus !== "VALIDATED") {
        throw new AppError(
          "OVPSA_BATCH_NOT_VALIDATED",
          "Validate the current draft before publication.",
          409,
        );
      }
      const eligibleStudents = await loadEligibleFirstYearStudents(client, {
        collegeId: batch.collegeId,
      });
      const studentNumbers = eligibleStudents
        .filter((student) => student.isActive && student.yearLevel === 1)
        .map((student) => student.studentNumber);
      await lockPublicationKeys(client, batch);
      const preflight = await planWithClient(client, batch, {
        forPublication: false,
      });
      await lockEffectiveAppointmentScopes(client, [
        ...studentNumbers.flatMap((studentNumber) => [
          { studentNumber, scheduleType: "LABORATORY" },
          { studentNumber, scheduleType: "PHYSICAL_EXAM" },
        ]),
        ...preflight.candidates.flatMap((candidate) =>
          candidate.displacementType === "PAIR"
            ? [
                {
                  studentNumber: candidate.studentNumber,
                  scheduleType: "LABORATORY",
                },
                {
                  studentNumber: candidate.studentNumber,
                  scheduleType: "PHYSICAL_EXAM",
                },
              ]
            : [
                {
                  studentNumber: candidate.studentNumber,
                  scheduleType: "PHYSICAL_EXAM",
                },
              ],
        ),
      ]);
      const { preview, supersededByStudent, plannedReplacements } =
        await planWithClient(client, batch, { forPublication: true });
      if (!preview.canPublish) {
        throw new AppError(
          "OVPSA_BATCH_NOT_PUBLISHABLE",
          "The First Year batch has conflicts that must be resolved.",
          409,
          undefined,
          preview,
        );
      }
      const members = preview.members;
      const snapshotResult = await ensureStudentAcademicSnapshotsWithClient(
        client,
        {
          actorUserId,
          candidates: members.map((member) => ({
            studentNumber: member.studentNumber,
            academicYearStart: batch.scheduleCycleStart,
            studentName: member.studentName,
            collegeId: member.collegeId,
            collegeName: member.collegeName,
            programId: member.programId,
            programCode: member.programCode,
            programName: member.programName,
            yearLevel: member.yearLevel,
            sourceImportGroupId: null,
            sourceType: "OVPSA_PUBLICATION" as const,
            sourceMetadata: {
              provenance: "OVPSA_PUBLICATION",
              batchId,
              revisionId: batch.revisionId,
            },
          })),
        },
      );
      if (snapshotResult.outcome === "CONFLICT") {
        throw new AppError(
          "SNAPSHOT_CONFLICT",
          "Publication conflicts with immutable academic history.",
          409,
          undefined,
          { conflicts: snapshotResult.conflicts },
        );
      }
      const academicSnapshots = await client.query<{
        id: string;
        student_number: string;
      }>(
        `SELECT id::text,student_number
           FROM student_academic_snapshots
          WHERE academic_year_start=$1
            AND student_number=ANY($2::varchar[])
          ORDER BY student_number
          FOR KEY SHARE`,
        [
          batch.scheduleCycleStart,
          members.map((member) => member.studentNumber),
        ],
      );
      const snapshotIdByStudent = new Map(
        academicSnapshots.rows.map((snapshot) => [
          snapshot.student_number,
          snapshot.id,
        ]),
      );
      await client.query(
        `INSERT INTO ovpsa_first_year_membership_snapshots (
           revision_id,batch_id,student_number,academic_snapshot_id,student_name,
           college_id,college_name,program_id,program_code,program_name,year_level
         )
         SELECT $1,$2,member.student_number,member.academic_snapshot_id,
                member.student_name,member.college_id,member.college_name,
                member.program_id,member.program_code,member.program_name,member.year_level
           FROM jsonb_to_recordset($3::jsonb) AS member(
             student_number text,academic_snapshot_id uuid,student_name text,
             college_id uuid,college_name text,program_id uuid,program_code text,
             program_name text,year_level integer
           )`,
        [
          batch.revisionId,
          batchId,
          JSON.stringify(
            members.map((member) => ({
              student_number: member.studentNumber,
              academic_snapshot_id: snapshotIdByStudent.get(
                member.studentNumber,
              ),
              student_name: member.studentName,
              college_id: member.collegeId,
              college_name: member.collegeName,
              program_id: member.programId,
              program_code: member.programCode,
              program_name: member.programName,
              year_level: member.yearLevel,
            })),
          ),
        ],
      );
      await client.query(
        `INSERT INTO ovpsa_first_year_active_memberships (
           batch_id,revision_id,student_number,schedule_cycle_start
         ) SELECT $1,$2,UNNEST($3::varchar[]),$4`,
        [
          batchId,
          batch.revisionId,
          members.map((member) => member.studentNumber),
          batch.scheduleCycleStart,
        ],
      );
      const reservations = await client.query<{
        id: string;
        schedule_type: "LABORATORY" | "PHYSICAL_EXAM";
      }>(
        `INSERT INTO ovpsa_first_year_service_reservations (
           batch_id,revision_id,schedule_type,reservation_date,status,created_by
         ) VALUES
           ($1,$2,'LABORATORY',$3,'ACTIVE',$5),
           ($1,$2,'PHYSICAL_EXAM',$4,'ACTIVE',$5)
         RETURNING id::text,schedule_type`,
        [
          batchId,
          batch.revisionId,
          batch.laboratoryDate,
          batch.physicalExamDate,
          actorUserId,
        ],
      );
      const reservationByService = new Map(
        reservations.rows.map((reservation) => [
          reservation.schedule_type,
          reservation.id,
        ]),
      );
      const displacementResult = await applyOvpsaLowerPriorityDisplacements(
        client,
        {
          batch,
          actorUserId,
          plannedReplacements,
          laboratoryReservationId: reservationByService.get("LABORATORY")!,
          physicalExamReservationId: reservationByService.get("PHYSICAL_EXAM")!,
        },
      );
      if (displacementResult.displacedCount) {
        await writeAudit(
          actorUserId,
          "OVPSA_DISPLACEMENT_APPLIED",
          "ovpsa_first_year_batch",
          batchId,
          {
            revisionId: batch.revisionId,
            displacedStudentCount: displacementResult.displacedCount,
            displacements: preview.displacements,
            proposedReplacements: preview.proposedReplacements,
          },
          client,
        );
      }
      const oldIds = [...supersededByStudent.values()].flatMap((pair) => [
        pair.laboratory.id,
        pair.physicalExam.id,
      ]);
      if (oldIds.length) {
        await client.query(
          `UPDATE appointments
              SET status='RESCHEDULED',is_published=FALSE,updated_by=$2
            WHERE id=ANY($1::uuid[])`,
          [oldIds, actorUserId],
        );
        await client.query(
          `INSERT INTO appointment_status_logs (
             appointment_id,old_status,new_status,notes,changed_by
           ) SELECT id,'PENDING','RESCHEDULED',
                    'Superseded by the published First Year OVPSA schedule.',$2
               FROM UNNEST($1::uuid[]) fixture(id)`,
          [oldIds, actorUserId],
        );
      }
      const clinicIds = await loadOvpsaClinicIds(client);
      const laboratoryClinicId = clinicIds.get("KABALAKA_CLINIC");
      const physicalExamClinicId = clinicIds.get("CPU_CLINIC");
      if (!laboratoryClinicId || !physicalExamClinicId) {
        throw new AppError(
          "OVPSA_CLINIC_CONFIGURATION_MISSING",
          "Required clinics are missing.",
          409,
        );
      }
      const memberPairs = members.map((member) => {
        const prior = supersededByStudent.get(member.studentNumber);
        return {
          studentNumber: member.studentNumber,
          schedulePairId: randomUUID(),
          oldLaboratoryId: prior?.laboratory.id ?? null,
          oldPhysicalExamId: prior?.physicalExam.id ?? null,
        };
      });
      const appointments = await client.query<{
        id: string;
        student_number: string;
        schedule_type: "LABORATORY" | "PHYSICAL_EXAM";
      }>(
        `INSERT INTO appointments (
           clinic_id,student_number,schedule_type,appointment_date,status,is_published,
           notes,rescheduled_from,created_by,updated_by,schedule_pair_id,
           schedule_cycle_start,ovpsa_batch_id,ovpsa_revision_id,
           ovpsa_service_reservation_id
         )
         SELECT $1::uuid,member.student_number,'LABORATORY',$3::date,'PENDING',TRUE,
                'External Laboratory at Iloilo Mission Hospital.',member.old_laboratory_id,
                $7::uuid,$7::uuid,member.schedule_pair_id,$5::integer,$8::uuid,$9::uuid,$10::uuid
           FROM jsonb_to_recordset($6::jsonb) AS member(
             student_number text,schedule_pair_id uuid,old_laboratory_id uuid,old_physical_exam_id uuid
           )
         UNION ALL
         SELECT $2::uuid,member.student_number,'PHYSICAL_EXAM',$4::date,'PENDING',TRUE,
                'First Year OVPSA Physical Examination at CPU Clinic.',member.old_physical_exam_id,
                $7::uuid,$7::uuid,member.schedule_pair_id,$5::integer,$8::uuid,$9::uuid,$11::uuid
           FROM jsonb_to_recordset($6::jsonb) AS member(
             student_number text,schedule_pair_id uuid,old_laboratory_id uuid,old_physical_exam_id uuid
           )
         RETURNING id::text,student_number,schedule_type`,
        [
          laboratoryClinicId,
          physicalExamClinicId,
          batch.laboratoryDate,
          batch.physicalExamDate,
          batch.scheduleCycleStart,
          JSON.stringify(
            memberPairs.map((member) => ({
              student_number: member.studentNumber,
              schedule_pair_id: member.schedulePairId,
              old_laboratory_id: member.oldLaboratoryId,
              old_physical_exam_id: member.oldPhysicalExamId,
            })),
          ),
          actorUserId,
          batchId,
          batch.revisionId,
          reservationByService.get("LABORATORY"),
          reservationByService.get("PHYSICAL_EXAM"),
        ],
      );
      await client.query(
        `INSERT INTO appointment_status_logs (
           appointment_id,old_status,new_status,notes,changed_by
         ) SELECT id,NULL,'PENDING','Published by First Year OVPSA scheduling.',$2
             FROM UNNEST($1::uuid[]) fixture(id)`,
        [appointments.rows.map((appointment) => appointment.id), actorUserId],
      );
      const appointmentByMemberService = new Map(
        appointments.rows.map((appointment) => [
          `${appointment.student_number}:${appointment.schedule_type}`,
          appointment.id,
        ]),
      );
      const memberReplacementEvents = memberPairs
        .filter((member) => member.oldLaboratoryId || member.oldPhysicalExamId)
        .map((member) => {
          const newLaboratoryId = appointmentByMemberService.get(
            `${member.studentNumber}:LABORATORY`,
          );
          const newPhysicalExamId = appointmentByMemberService.get(
            `${member.studentNumber}:PHYSICAL_EXAM`,
          );
          if (!newLaboratoryId || !newPhysicalExamId) {
            throw new Error("OVPSA publication is missing a member appointment.");
          }
          return {
            student_number: member.studentNumber,
            schedule_pair_id: member.schedulePairId,
            old_laboratory_id: member.oldLaboratoryId,
            new_laboratory_id: newLaboratoryId,
            old_physical_exam_id: member.oldPhysicalExamId,
            new_physical_exam_id: newPhysicalExamId,
          };
        });
      if (memberReplacementEvents.length) {
        await client.query(
          `INSERT INTO appointment_reschedule_events (
             student_number,schedule_pair_id,cause,schedule_cycle_start,
             old_laboratory_appointment_id,new_laboratory_appointment_id,
             old_physical_exam_appointment_id,new_physical_exam_appointment_id,
             actor_user_id,ovpsa_batch_id,ovpsa_source_reservation_id,
             ovpsa_target_revision_id
           ) SELECT event.student_number,event.schedule_pair_id,'OVPSA_PUBLICATION',$2,
                    event.old_laboratory_id,event.new_laboratory_id,
                    event.old_physical_exam_id,event.new_physical_exam_id,
                    $3,$4,$5,$6
               FROM jsonb_to_recordset($1::jsonb) AS event(
                 student_number text,schedule_pair_id uuid,
                 old_laboratory_id uuid,new_laboratory_id uuid,
                 old_physical_exam_id uuid,new_physical_exam_id uuid
               )`,
          [
            JSON.stringify(memberReplacementEvents),
            batch.scheduleCycleStart,
            actorUserId,
            batchId,
            reservationByService.get("LABORATORY"),
            batch.revisionId,
          ],
        );
      }
      await createStudentNotifications(
        client,
        memberPairs.map((member) => ({
          studentNumber: member.studentNumber,
          notificationType: "SCHEDULE_PUBLISHED",
          title: "First Year OVPSA schedule published",
          message: `Your Laboratory is at Iloilo Mission Hospital on ${batch.laboratoryDate}. Your Physical Examination is at CPU Clinic on ${batch.physicalExamDate}.`,
          metadata: {
            reason: "OVPSA_FIRST_YEAR_PUBLICATION",
            batchId,
            revisionId: batch.revisionId,
            laboratoryDate: batch.laboratoryDate,
            physicalExamDate: batch.physicalExamDate,
          },
        })),
      );
      await client.query(
        `UPDATE ovpsa_first_year_batch_revisions
            SET status='PUBLISHED',published_by=$2,published_at=clock_timestamp()
          WHERE id=$1 AND status='VALIDATED'`,
        [batch.revisionId, actorUserId],
      );
      const optimisticToken = randomUUID();
      await client.query(
        `UPDATE ovpsa_first_year_batches
            SET status='PUBLISHED',published_by=$2,published_at=clock_timestamp(),
                optimistic_token=$3,updated_by=$2
          WHERE id=$1 AND status='DRAFT'`,
        [batchId, actorUserId, optimisticToken],
      );
      await writeAudit(
        actorUserId,
        "OVPSA_FIRST_YEAR_BATCH_PUBLISHED",
        "ovpsa_first_year_batch",
        batchId,
        {
          revisionId: batch.revisionId,
          scheduleCycleStart: batch.scheduleCycleStart,
          collegeId: batch.collegeId,
          laboratoryDate: batch.laboratoryDate,
          physicalExamDate: batch.physicalExamDate,
          memberCount: members.length,
          supersededMemberAppointmentCount: oldIds.length,
          displacedStudentCount: displacementResult.displacedCount,
        },
        client,
      );
      return {
        batchId,
        revisionId: batch.revisionId,
        status: "PUBLISHED" as const,
        optimisticToken,
        memberCount: members.length,
      };
    });
  } catch (error) {
    if (isPostgresUniqueViolation(error)) {
      throw new AppError(
        "OVPSA_PUBLICATION_CONFLICT",
        "Another First Year publication claimed a member or service date.",
        409,
      );
    }
    throw error;
  }
}

type RescheduleOvpsaInput = TokenInput & {
  laboratoryDate?: string | null;
  physicalExamDateOverride?: string | null;
  physicalExamExceptionReason?: string | null;
  reason: string;
};

async function loadPublishedMembershipForRevision(
  client: PoolClient,
  revisionId: string,
) {
  const result = await client.query<{
    student_number: string;
    student_name: string;
    college_id: string;
    college_name: string;
    program_id: string;
    program_code: string;
    program_name: string;
    year_level: number;
  }>(
    `SELECT student_number,student_name,college_id::text,college_name,
            program_id::text,program_code,program_name,year_level
       FROM ovpsa_first_year_membership_snapshots
      WHERE revision_id=$1
      ORDER BY student_name,student_number`,
    [revisionId],
  );
  return result.rows.map((row) => ({
    studentNumber: row.student_number,
    studentName: row.student_name,
    collegeId: row.college_id,
    collegeName: row.college_name,
    programId: row.program_id,
    programCode: row.program_code,
    programName: row.program_name,
    yearLevel: row.year_level,
    isActive: true,
  }));
}

async function buildReplacementRevisionPreview(
  client: PoolClient,
  batch: StoredOvpsaBatch,
  members: Awaited<ReturnType<typeof loadPublishedMembershipForRevision>>,
  forUpdate: boolean,
) {
  const boundary = cycleBoundary(batch.scheduleCycleStart);
  const capacity = await loadCpuPhysicalExamMaximumCapacity(client);
  if (capacity === null) {
    throw new AppError(
      "SCHEDULE_CAPACITY_NOT_CONFIGURED",
      "CPU Clinic capacity is not configured.",
      409,
    );
  }
  const blocked = await loadSchedulingBlockedDates(client, {
    startDate: boundary.startDate,
    endDate: boundary.endDate,
    excludeOvpsaBatchId: batch.batchId,
  });
  const closed = await client.query<{ date: string }>(
    `SELECT blocked_date::text AS date FROM clinic_unavailable_dates
      WHERE blocked_date BETWEEN $1::date AND $2::date AND reopened_at IS NULL
      ORDER BY blocked_date`,
    [boundary.startDate, boundary.endDate],
  );
  const today = await client.query<{ date: string }>(
    "SELECT (clock_timestamp() AT TIME ZONE 'Asia/Manila')::date::text AS date",
  );
  const displacement = await planOvpsaLowerPriorityDisplacements(client, {
    batch,
    memberStudentNumbers: members.map((member) => member.studentNumber),
    forUpdate,
  });
  const globallyClosedDates = closed.rows.map((row) => row.date);
  const preview = buildOvpsaBatchPreview({
    scheduleCycleStart: batch.scheduleCycleStart,
    cycleStartDate: boundary.startDate,
    cycleEndDate: boundary.endDate,
    collegeId: batch.collegeId,
    laboratoryDate: batch.laboratoryDate,
    physicalExamDateOverride:
      batch.physicalExamDate === addDays(batch.laboratoryDate, 7)
        ? null
        : batch.physicalExamDate,
    physicalExamExceptionReason: batch.physicalExamExceptionReason,
    today: today.rows[0].date,
    students: members,
    cpuPhysicalExamMaximumCapacity: capacity,
    globallyClosedDates,
    reservedLaboratoryDates: blocked.laboratoryDates.filter(
      (date) => !globallyClosedDates.includes(date),
    ),
    reservedPhysicalExamDates: blocked.physicalExamDates.filter(
      (date) => !globallyClosedDates.includes(date),
    ),
    protectedConflicts: displacement.protectedConflicts,
    displacements: displacement.displacements,
    proposedReplacements: displacement.proposedReplacements,
    additionalBlockers: displacement.blockers,
  });
  return { preview, ...displacement };
}

export async function rescheduleOvpsaFirstYearBatch(
  batchId: string,
  input: RescheduleOvpsaInput,
  actorUserId: string,
) {
  const reason = input.reason?.trim();
  if (!reason || reason.length < 3) {
    throw new AppError(
      "OVPSA_RESCHEDULE_REASON_REQUIRED",
      "Enter the OVPSA reschedule reason.",
      422,
    );
  }
  return transaction(async (client) => {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('medclinic:schedule-import-queue'))",
    );
    const current = await loadOvpsaBatchWithCurrentRevision(
      client,
      batchId,
      true,
    );
    if (!current)
      throw new AppError(
        "OVPSA_BATCH_NOT_FOUND",
        "First Year batch not found.",
        404,
      );
    assertToken(current, input.optimisticToken);
    if (
      current.status !== "RESCHEDULE_REQUIRED" ||
      current.revisionStatus !== "PUBLISHED"
    ) {
      throw new AppError(
        "OVPSA_RESCHEDULE_NOT_REQUIRED",
        "Only a First Year batch invalidated by an official closure can be rescheduled.",
        409,
      );
    }
    const invalidated = await client.query<{
      id: string;
      schedule_type: "LABORATORY" | "PHYSICAL_EXAM";
    }>(
      `SELECT id::text,schedule_type
         FROM ovpsa_first_year_service_reservations
        WHERE batch_id=$1 AND status='INVALIDATED'
        ORDER BY schedule_type
        FOR UPDATE`,
      [batchId],
    );
    const invalidatedServices = new Set(
      invalidated.rows.map((reservation) => reservation.schedule_type),
    );
    const laboratoryMoves = invalidatedServices.has("LABORATORY");
    const laboratoryDate = laboratoryMoves
      ? input.laboratoryDate?.trim() || null
      : current.laboratoryDate;
    if (!laboratoryDate) {
      throw new AppError(
        "OVPSA_LABORATORY_REPLACEMENT_REQUIRED",
        "Approve a replacement Mission Hospital Laboratory date.",
        422,
      );
    }
    const defaultPhysicalExamDate = addDays(laboratoryDate, 7);
    const physicalExamDate = laboratoryMoves
      ? (input.physicalExamDateOverride ?? defaultPhysicalExamDate)
      : input.physicalExamDateOverride;
    if (!physicalExamDate) {
      throw new AppError(
        "OVPSA_PHYSICAL_EXAM_REPLACEMENT_REQUIRED",
        "Approve a replacement CPU Clinic Physical Examination date.",
        422,
      );
    }
    const exceptionReason =
      physicalExamDate === defaultPhysicalExamDate
        ? null
        : input.physicalExamExceptionReason?.trim() || reason;
    const synthetic: StoredOvpsaBatch = {
      ...current,
      laboratoryDate,
      physicalExamDate,
      physicalExamExceptionReason: exceptionReason,
      revisionNumber: current.revisionNumber + 1,
      revisionStatus: "VALIDATED",
    };
    for (const key of [
      `LABORATORY:${laboratoryDate}`,
      `PHYSICAL_EXAM:${physicalExamDate}`,
    ].sort()) {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        [`medclinic:ovpsa-service-date:v1:${key}`],
      );
    }
    const members = await loadPublishedMembershipForRevision(
      client,
      current.revisionId,
    );
    const preflight = await buildReplacementRevisionPreview(
      client,
      synthetic,
      members,
      false,
    );
    await lockEffectiveAppointmentScopes(client, [
      ...members.flatMap((member) => [
        { studentNumber: member.studentNumber, scheduleType: "LABORATORY" },
        { studentNumber: member.studentNumber, scheduleType: "PHYSICAL_EXAM" },
      ]),
      ...preflight.candidates.flatMap((candidate) =>
        candidate.displacementType === "PAIR"
          ? [
              {
                studentNumber: candidate.studentNumber,
                scheduleType: "LABORATORY",
              },
              {
                studentNumber: candidate.studentNumber,
                scheduleType: "PHYSICAL_EXAM",
              },
            ]
          : [
              {
                studentNumber: candidate.studentNumber,
                scheduleType: "PHYSICAL_EXAM",
              },
            ],
      ),
    ]);
    const planned = await buildReplacementRevisionPreview(
      client,
      synthetic,
      members,
      true,
    );
    if (!planned.preview.canPublish) {
      throw new AppError(
        "OVPSA_BATCH_NOT_PUBLISHABLE",
        "The replacement revision has conflicts that must be resolved.",
        409,
        undefined,
        planned.preview,
      );
    }
    const currentAppointments = await client.query<{
      id: string;
      student_number: string;
      schedule_type: "LABORATORY" | "PHYSICAL_EXAM";
      status: string;
      schedule_pair_id: string;
      is_manually_locked: boolean;
    }>(
      `SELECT id::text,student_number,schedule_type,status,schedule_pair_id::text,
              is_manually_locked
         FROM appointments
        WHERE ovpsa_batch_id=$1
          AND is_published=TRUE
          AND status NOT IN ('RESCHEDULED','CANCELLED')
        ORDER BY student_number,schedule_type,id
        FOR UPDATE`,
      [batchId],
    );
    const affectedStudentNumbers = new Set(
      currentAppointments.rows
        .filter(
          (appointment) =>
            invalidatedServices.has(appointment.schedule_type) &&
            appointment.status === "AWAITING_RESCHEDULE",
        )
        .map((appointment) => appointment.student_number),
    );
    const affectedMembers = members.filter((member) =>
      affectedStudentNumbers.has(member.studentNumber),
    );
    const moving = currentAppointments.rows.filter(
      (appointment) =>
        affectedStudentNumbers.has(appointment.student_number) &&
        (laboratoryMoves || appointment.schedule_type === "PHYSICAL_EXAM"),
    );
    const movingProtections = await loadAppointmentResultProtectionStates(
      client,
      moving.map((appointment) => appointment.id),
    );
    const unsafe = moving.find(
      (appointment) =>
        !["PENDING", "AWAITING_RESCHEDULE"].includes(appointment.status) ||
        appointment.is_manually_locked ||
        movingProtections.get(appointment.id)?.type === "PROTECTED",
    );
    if (unsafe) {
      throw new AppError(
        "OVPSA_PROTECTED_APPOINTMENT_CONFLICT",
        "A completed or protected First Year appointment prevents this replacement.",
        409,
        undefined,
        { appointmentId: unsafe.id, status: unsafe.status },
      );
    }
    const revision = await client.query<{ id: string }>(
      `INSERT INTO ovpsa_first_year_batch_revisions (
         batch_id,revision_number,status,laboratory_date,physical_exam_date,
         physical_exam_exception_reason,validation_snapshot,validated_by,validated_at,
         created_by
       ) VALUES ($1,$2,'VALIDATED',$3,$4,$5,$6::jsonb,$7,clock_timestamp(),$7)
       RETURNING id::text`,
      [
        batchId,
        current.revisionNumber + 1,
        laboratoryDate,
        physicalExamDate,
        exceptionReason,
        JSON.stringify(planned.preview),
        actorUserId,
      ],
    );
    const revisionId = revision.rows[0].id;
    const replacementBatch: StoredOvpsaBatch = { ...synthetic, revisionId };
    await client.query(
      `INSERT INTO ovpsa_first_year_membership_snapshots (
         revision_id,batch_id,student_number,academic_snapshot_id,student_name,
         college_id,college_name,program_id,program_code,program_name,year_level
       ) SELECT $1,batch_id,student_number,academic_snapshot_id,student_name,
                college_id,college_name,program_id,program_code,program_name,year_level
           FROM ovpsa_first_year_membership_snapshots WHERE revision_id=$2`,
      [revisionId, current.revisionId],
    );
    const reservationRows = laboratoryMoves
      ? [
          { schedule_type: "LABORATORY", date: laboratoryDate },
          { schedule_type: "PHYSICAL_EXAM", date: physicalExamDate },
        ]
      : [{ schedule_type: "PHYSICAL_EXAM", date: physicalExamDate }];
    const reservations = await client.query<{
      id: string;
      schedule_type: "LABORATORY" | "PHYSICAL_EXAM";
    }>(
      `INSERT INTO ovpsa_first_year_service_reservations (
         batch_id,revision_id,schedule_type,reservation_date,status,created_by
       ) SELECT $1,$2,row.schedule_type,row.date,'ACTIVE',$4
           FROM jsonb_to_recordset($3::jsonb) AS row(schedule_type text,date date)
       RETURNING id::text,schedule_type`,
      [batchId, revisionId, JSON.stringify(reservationRows), actorUserId],
    );
    const reservationByService = new Map(
      reservations.rows.map((reservation) => [
        reservation.schedule_type,
        reservation.id,
      ]),
    );
    const retainedLaboratoryReservation = laboratoryMoves
      ? null
      : await client.query<{ id: string }>(
          `SELECT id::text FROM ovpsa_first_year_service_reservations
            WHERE batch_id=$1 AND schedule_type='LABORATORY'
              AND status IN ('ACTIVE','INVALIDATED')
            ORDER BY created_at DESC LIMIT 1`,
          [batchId],
        );
    const laboratoryReservationId =
      reservationByService.get("LABORATORY") ??
      retainedLaboratoryReservation?.rows[0]?.id;
    const physicalExamReservationId = reservationByService.get("PHYSICAL_EXAM");
    if (!laboratoryReservationId || !physicalExamReservationId) {
      throw new Error(
        "OVPSA replacement revision is missing a required service reservation.",
      );
    }
    await applyOvpsaLowerPriorityDisplacements(client, {
      batch: replacementBatch,
      actorUserId,
      plannedReplacements: planned.plannedReplacements,
      laboratoryReservationId,
      physicalExamReservationId,
    });
    await client.query(
      `UPDATE appointments
          SET status='RESCHEDULED',is_published=FALSE,updated_by=$2
        WHERE id=ANY($1::uuid[])`,
      [moving.map((appointment) => appointment.id), actorUserId],
    );
    await client.query(
      `INSERT INTO appointment_status_logs (
         appointment_id,old_status,new_status,notes,changed_by
       ) SELECT row.id,row.old_status,'RESCHEDULED',$2,$3
           FROM jsonb_to_recordset($1::jsonb) AS row(id uuid,old_status text)`,
      [
        JSON.stringify(
          moving.map((appointment) => ({
            id: appointment.id,
            old_status: appointment.status,
          })),
        ),
        reason,
        actorUserId,
      ],
    );
    const byStudent = new Map<string, typeof currentAppointments.rows>();
    for (const appointment of currentAppointments.rows) {
      byStudent.set(appointment.student_number, [
        ...(byStudent.get(appointment.student_number) ?? []),
        appointment,
      ]);
    }
    const newAppointmentRows = affectedMembers.flatMap((member) => {
      const currentRows = byStudent.get(member.studentNumber) ?? [];
      const laboratory = currentRows.find(
        (appointment) => appointment.schedule_type === "LABORATORY",
      )!;
      const physical = currentRows.find(
        (appointment) => appointment.schedule_type === "PHYSICAL_EXAM",
      )!;
      const schedulePairId = laboratoryMoves
        ? randomUUID()
        : physical.schedule_pair_id;
      return laboratoryMoves
        ? [
            {
              student_number: member.studentNumber,
              schedule_type: "LABORATORY",
              date: laboratoryDate,
              pair_id: schedulePairId,
              old_id: laboratory.id,
              reservation_id: reservationByService.get("LABORATORY"),
            },
            {
              student_number: member.studentNumber,
              schedule_type: "PHYSICAL_EXAM",
              date: physicalExamDate,
              pair_id: schedulePairId,
              old_id: physical.id,
              reservation_id: reservationByService.get("PHYSICAL_EXAM"),
            },
          ]
        : [
            {
              student_number: member.studentNumber,
              schedule_type: "PHYSICAL_EXAM",
              date: physicalExamDate,
              pair_id: schedulePairId,
              old_id: physical.id,
              reservation_id: reservationByService.get("PHYSICAL_EXAM"),
            },
          ];
    });
    const clinics = await loadOvpsaClinicIds(client);
    const inserted = await client.query<{
      id: string;
      student_number: string;
      schedule_type: "LABORATORY" | "PHYSICAL_EXAM";
      rescheduled_from: string;
    }>(
      `INSERT INTO appointments (
         clinic_id,student_number,schedule_type,appointment_date,status,is_published,
         notes,rescheduled_from,created_by,updated_by,schedule_pair_id,
         schedule_cycle_start,ovpsa_batch_id,ovpsa_revision_id,
         ovpsa_service_reservation_id
       )
       SELECT CASE row.schedule_type
                WHEN 'LABORATORY' THEN $2::uuid ELSE $3::uuid END,
              row.student_number,row.schedule_type,row.date,'PENDING',TRUE,$4,
              row.old_id,$5,$5,row.pair_id,$6,$7,$8,row.reservation_id
         FROM jsonb_to_recordset($1::jsonb) AS row(
           student_number text,schedule_type text,date date,pair_id uuid,
           old_id uuid,reservation_id uuid
         )
       RETURNING id::text,student_number,schedule_type,rescheduled_from::text`,
      [
        JSON.stringify(newAppointmentRows),
        clinics.get("KABALAKA_CLINIC"),
        clinics.get("CPU_CLINIC"),
        reason,
        actorUserId,
        current.scheduleCycleStart,
        batchId,
        revisionId,
      ],
    );
    await client.query(
      `INSERT INTO appointment_status_logs (
         appointment_id,old_status,new_status,notes,changed_by
       ) SELECT id,NULL,'PENDING',$2,$3 FROM UNNEST($1::uuid[]) row(id)`,
      [inserted.rows.map((appointment) => appointment.id), reason, actorUserId],
    );
    const newByOld = new Map(
      inserted.rows.map((appointment) => [
        appointment.rescheduled_from,
        appointment.id,
      ]),
    );
    const eventRows = affectedMembers.map((member) => {
      const rows = byStudent.get(member.studentNumber) ?? [];
      const laboratory = rows.find(
        (appointment) => appointment.schedule_type === "LABORATORY",
      )!;
      const physical = rows.find(
        (appointment) => appointment.schedule_type === "PHYSICAL_EXAM",
      )!;
      return {
        student_number: member.studentNumber,
        schedule_pair_id: laboratoryMoves
          ? newAppointmentRows.find(
              (row) => row.student_number === member.studentNumber,
            )!.pair_id
          : physical.schedule_pair_id,
        old_laboratory_id: laboratory.id,
        new_laboratory_id: laboratoryMoves
          ? newByOld.get(laboratory.id)
          : laboratory.id,
        old_physical_id: physical.id,
        new_physical_id: newByOld.get(physical.id),
        source_reservation_id: invalidated.rows.find(
          (reservation) =>
            reservation.schedule_type ===
            (laboratoryMoves ? "LABORATORY" : "PHYSICAL_EXAM"),
        )?.id,
      };
    });
    await client.query(
      `INSERT INTO appointment_reschedule_events (
         student_number,schedule_pair_id,cause,schedule_cycle_start,
         old_laboratory_appointment_id,new_laboratory_appointment_id,
         old_physical_exam_appointment_id,new_physical_exam_appointment_id,
         actor_user_id,ovpsa_batch_id,ovpsa_source_reservation_id,
         ovpsa_target_revision_id
       ) SELECT row.student_number,row.schedule_pair_id,'OVPSA_RESCHEDULE',$2,
                row.old_laboratory_id,row.new_laboratory_id,row.old_physical_id,
                row.new_physical_id,$3,$4,row.source_reservation_id,$5
           FROM jsonb_to_recordset($1::jsonb) AS row(
             student_number text,schedule_pair_id uuid,old_laboratory_id uuid,
             new_laboratory_id uuid,old_physical_id uuid,new_physical_id uuid,
             source_reservation_id uuid
           )`,
      [
        eventRows.length ? JSON.stringify(eventRows) : "[]",
        current.scheduleCycleStart,
        actorUserId,
        batchId,
        revisionId,
      ],
    );
    const releasedServices = laboratoryMoves
      ? ["LABORATORY", "PHYSICAL_EXAM"]
      : ["PHYSICAL_EXAM"];
    const releasedReservations = await client.query<{ id: string }>(
      `UPDATE ovpsa_first_year_service_reservations
          SET status='RELEASED',released_at=clock_timestamp(),released_by=$3,
              release_reason=$4
        WHERE batch_id=$1 AND revision_id=$2
          AND schedule_type=ANY($5::text[])
          AND status IN ('ACTIVE','INVALIDATED')
        RETURNING id::text`,
      [batchId, current.revisionId, actorUserId, reason, releasedServices],
    );
    await restoreAppointmentsDisplacedByReservationsWithClient(client, {
      reservationIds: releasedReservations.rows.map(
        (reservation) => reservation.id,
      ),
      actorUserId,
      reason,
    });
    await client.query(
      `UPDATE ovpsa_first_year_active_memberships
          SET released_at=clock_timestamp(),released_by=$3,release_reason=$4
        WHERE batch_id=$1 AND revision_id=$2 AND released_at IS NULL`,
      [batchId, current.revisionId, actorUserId, reason],
    );
    await client.query(
      `INSERT INTO ovpsa_first_year_active_memberships (
         batch_id,revision_id,student_number,schedule_cycle_start
       ) SELECT $1,$2,UNNEST($3::varchar[]),$4`,
      [
        batchId,
        revisionId,
        members.map((member) => member.studentNumber),
        current.scheduleCycleStart,
      ],
    );
    await client.query(
      `UPDATE ovpsa_first_year_batch_revisions
          SET status='SUPERSEDED',superseded_by_revision_id=$2,
              superseded_at=clock_timestamp()
        WHERE id=$1 AND status='PUBLISHED'`,
      [current.revisionId, revisionId],
    );
    await client.query(
      `UPDATE ovpsa_first_year_batch_revisions
          SET status='PUBLISHED',published_by=$2,published_at=clock_timestamp()
        WHERE id=$1 AND status='VALIDATED'`,
      [revisionId, actorUserId],
    );
    const nextToken = randomUUID();
    await client.query(
      `UPDATE ovpsa_first_year_batches
          SET status='PUBLISHED',current_revision_id=$2,optimistic_token=$3,
              updated_by=$4
        WHERE id=$1 AND status='RESCHEDULE_REQUIRED'`,
      [batchId, revisionId, nextToken, actorUserId],
    );
    await createStudentNotifications(
      client,
      affectedMembers.map((member) => ({
        studentNumber: member.studentNumber,
        notificationType: "SCHEDULE_RESCHEDULED",
        title: "First Year OVPSA schedule replaced",
        message: `Your updated Laboratory date is ${laboratoryDate} and Physical Examination date is ${physicalExamDate}.`,
        metadata: {
          reason: "OVPSA_RESCHEDULE",
          batchId,
          revisionId,
          previousRevisionId: current.revisionId,
          laboratoryDate,
          physicalExamDate,
        },
      })),
    );
    await writeAudit(
      actorUserId,
      "OVPSA_FIRST_YEAR_BATCH_RESCHEDULED",
      "ovpsa_first_year_batch",
      batchId,
      {
        previousRevisionId: current.revisionId,
        revisionId,
        oldLaboratoryDate: current.laboratoryDate,
        newLaboratoryDate: laboratoryDate,
        oldPhysicalExamDate: current.physicalExamDate,
        newPhysicalExamDate: physicalExamDate,
        affectedStudentCount: affectedMembers.length,
        reason,
      },
      client,
    );
    return {
      batchId,
      revisionId,
      revisionNumber: current.revisionNumber + 1,
      status: "PUBLISHED" as const,
      optimisticToken: nextToken,
      memberCount: members.length,
    };
  });
}

export async function cancelOvpsaFirstYearBatch(
  batchId: string,
  input: TokenInput & { reason: string },
  actorUserId: string,
) {
  const reason = input.reason?.trim();
  if (!reason || reason.length < 3) {
    throw new AppError(
      "OVPSA_CANCELLATION_REASON_REQUIRED",
      "Enter the OVPSA cancellation reason.",
      422,
    );
  }
  return transaction(async (client) => {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('medclinic:schedule-import-queue'))",
    );
    const batch = await loadOvpsaBatchWithCurrentRevision(
      client,
      batchId,
      true,
    );
    if (!batch)
      throw new AppError(
        "OVPSA_BATCH_NOT_FOUND",
        "First Year batch not found.",
        404,
      );
    assertToken(batch, input.optimisticToken);
    if (!["PUBLISHED", "RESCHEDULE_REQUIRED"].includes(batch.status)) {
      throw new AppError(
        "OVPSA_BATCH_NOT_CANCELLABLE",
        "This First Year batch cannot be cancelled.",
        409,
      );
    }
    const memberships = await client.query<{ student_number: string }>(
      `SELECT student_number FROM ovpsa_first_year_active_memberships
        WHERE batch_id=$1 AND released_at IS NULL ORDER BY student_number FOR UPDATE`,
      [batchId],
    );
    await lockEffectiveAppointmentScopes(
      client,
      memberships.rows.flatMap((membership) => [
        {
          studentNumber: membership.student_number,
          scheduleType: "LABORATORY",
        },
        {
          studentNumber: membership.student_number,
          scheduleType: "PHYSICAL_EXAM",
        },
      ]),
    );
    const cancelled = await client.query<{
      id: string;
      student_number: string;
      old_status: string;
    }>(
      `WITH target AS (
         SELECT id,status AS old_status FROM appointments
          WHERE ovpsa_batch_id=$1 AND is_published=TRUE
            AND status IN ('PENDING','AWAITING_RESCHEDULE')
          FOR UPDATE
       )
       UPDATE appointments appointment
          SET status='CANCELLED',updated_by=$2,updated_at=clock_timestamp()
         FROM target
        WHERE appointment.id=target.id
        RETURNING appointment.id::text,appointment.student_number,target.old_status`,
      [batchId, actorUserId],
    );
    if (cancelled.rowCount) {
      await client.query(
        `INSERT INTO appointment_status_logs (
           appointment_id,old_status,new_status,notes,changed_by
         ) SELECT row.id,row.old_status,'CANCELLED',$2,$3
             FROM jsonb_to_recordset($1::jsonb) AS row(id uuid,old_status text)`,
        [
          JSON.stringify(
            cancelled.rows.map((appointment) => ({
              id: appointment.id,
              old_status: appointment.old_status,
            })),
          ),
          reason,
          actorUserId,
        ],
      );
    }
    await client.query(
      `UPDATE ovpsa_first_year_active_memberships
          SET released_at=clock_timestamp(),released_by=$2,release_reason=$3
        WHERE batch_id=$1 AND released_at IS NULL`,
      [batchId, actorUserId, reason],
    );
    const releasedReservations = await client.query<{ id: string }>(
      `UPDATE ovpsa_first_year_service_reservations
          SET status='RELEASED',released_at=clock_timestamp(),released_by=$2,
              release_reason=$3
        WHERE batch_id=$1 AND status IN ('ACTIVE','INVALIDATED')
        RETURNING id::text`,
      [batchId, actorUserId, reason],
    );
    const restoration =
      await restoreAppointmentsDisplacedByReservationsWithClient(client, {
        reservationIds: releasedReservations.rows.map(
          (reservation) => reservation.id,
        ),
        actorUserId,
        reason,
      });
    await client.query(
      `UPDATE ovpsa_first_year_batch_revisions
          SET status='CANCELLED',cancelled_at=clock_timestamp()
        WHERE id=$1 AND status='PUBLISHED'`,
      [batch.revisionId],
    );
    const nextToken = randomUUID();
    await client.query(
      `UPDATE ovpsa_first_year_batches
          SET status='CANCELLED',cancelled_by=$2,cancelled_at=clock_timestamp(),
              cancellation_reason=$3,optimistic_token=$4,updated_by=$2
        WHERE id=$1`,
      [batchId, actorUserId, reason, nextToken],
    );
    await createStudentNotifications(
      client,
      memberships.rows.map((membership) => ({
        studentNumber: membership.student_number,
        notificationType: "OVPSA_BATCH_CANCELLED",
        title: "First Year OVPSA schedule cancelled",
        message: `The unfinished First Year OVPSA schedule was cancelled: ${reason}`,
        metadata: {
          reason: "OVPSA_CANCELLATION",
          batchId,
          cancellationReason: reason,
        },
      })),
    );
    await writeAudit(
      actorUserId,
      "OVPSA_FIRST_YEAR_BATCH_CANCELLED",
      "ovpsa_first_year_batch",
      batchId,
      {
        revisionId: batch.revisionId,
        reason,
        cancelledAppointmentIds: cancelled.rows.map(
          (appointment) => appointment.id,
        ),
        preservedCompletedHistory: true,
        restoration,
      },
      client,
    );
    return {
      batchId,
      status: "CANCELLED" as const,
      optimisticToken: nextToken,
      cancelledAppointmentCount: cancelled.rowCount ?? 0,
    };
  });
}

export async function listOvpsaFirstYearBatches() {
  const result = await query<{
    batchId: string;
    scheduleCycleStart: number;
    collegeId: string;
    collegeName: string;
    status: StoredOvpsaBatch["status"];
    optimisticToken: string;
    revisionId: string;
    revisionNumber: number;
    revisionStatus: StoredOvpsaBatch["revisionStatus"];
    laboratoryDate: string;
    physicalExamDate: string;
    memberCount: number;
    createdAt: Date;
    updatedAt: Date;
  }>(
    `SELECT batch.id::text AS "batchId",batch.schedule_cycle_start AS "scheduleCycleStart",
            batch.college_id::text AS "collegeId",college.name AS "collegeName",
            batch.status,batch.optimistic_token::text AS "optimisticToken",
            revision.id::text AS "revisionId",revision.revision_number AS "revisionNumber",
            revision.status AS "revisionStatus",revision.laboratory_date::text AS "laboratoryDate",
            revision.physical_exam_date::text AS "physicalExamDate",
            COALESCE((
              SELECT COUNT(*)::int FROM ovpsa_first_year_membership_snapshots membership
               WHERE membership.revision_id=revision.id
            ),0) AS "memberCount",
            batch.created_at AS "createdAt",batch.updated_at AS "updatedAt"
       FROM ovpsa_first_year_batches batch
       JOIN colleges college ON college.id=batch.college_id
       JOIN ovpsa_first_year_batch_revisions revision ON revision.id=batch.current_revision_id
      ORDER BY batch.schedule_cycle_start DESC,batch.created_at DESC,batch.id DESC`,
  );
  return {
    items: result.rows.map((row) => ({
      ...row,
      laboratoryLocationName: "Iloilo Mission Hospital" as const,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    })),
  };
}

export async function getOvpsaFirstYearBatch(batchId: string) {
  const batch = await query<{
    batchId: string;
    scheduleCycleStart: number;
    collegeId: string;
    collegeName: string;
    status: StoredOvpsaBatch["status"];
    optimisticToken: string;
    revisionId: string;
    revisionNumber: number;
    revisionStatus: StoredOvpsaBatch["revisionStatus"];
    laboratoryDate: string;
    physicalExamDate: string;
    physicalExamExceptionReason: string | null;
    cancellationReason: string | null;
    createdAt: Date;
    updatedAt: Date;
  }>(
    `SELECT batch.id::text AS "batchId",batch.schedule_cycle_start AS "scheduleCycleStart",
            batch.college_id::text AS "collegeId",college.name AS "collegeName",
            batch.status,batch.optimistic_token::text AS "optimisticToken",
            revision.id::text AS "revisionId",revision.revision_number AS "revisionNumber",
            revision.status AS "revisionStatus",revision.laboratory_date::text AS "laboratoryDate",
            revision.physical_exam_date::text AS "physicalExamDate",
            revision.physical_exam_exception_reason AS "physicalExamExceptionReason",
            batch.cancellation_reason AS "cancellationReason",
            batch.created_at AS "createdAt",batch.updated_at AS "updatedAt"
       FROM ovpsa_first_year_batches batch
       JOIN colleges college ON college.id=batch.college_id
       JOIN ovpsa_first_year_batch_revisions revision ON revision.id=batch.current_revision_id
      WHERE batch.id=$1`,
    [batchId],
  );
  const item = batch.rows[0];
  if (!item)
    throw new AppError(
      "OVPSA_BATCH_NOT_FOUND",
      "First Year batch not found.",
      404,
    );
  const [members, revisions, reservations, appointments, audits] =
    await Promise.all([
      query<{
        studentNumber: string;
        studentName: string;
        programCode: string | null;
        programName: string;
        yearLevel: number;
      }>(
        `SELECT student_number AS "studentNumber",student_name AS "studentName",
              program_code AS "programCode",program_name AS "programName",
              year_level AS "yearLevel"
         FROM ovpsa_first_year_membership_snapshots
        WHERE revision_id=$1 ORDER BY student_name,student_number`,
        [item.revisionId],
      ),
      query<{
        id: string;
        revisionNumber: number;
        status: string;
        laboratoryDate: string;
        physicalExamDate: string;
        physicalExamExceptionReason: string | null;
        createdAt: Date;
        publishedAt: Date | null;
      }>(
        `SELECT id::text,revision_number AS "revisionNumber",status,
              laboratory_date::text AS "laboratoryDate",
              physical_exam_date::text AS "physicalExamDate",
              physical_exam_exception_reason AS "physicalExamExceptionReason",
              created_at AS "createdAt",published_at AS "publishedAt"
         FROM ovpsa_first_year_batch_revisions
        WHERE batch_id=$1 ORDER BY revision_number DESC`,
        [batchId],
      ),
      query<{
        id: string;
        revisionId: string;
        scheduleType: string;
        reservationDate: string;
        status: string;
        invalidatedAt: Date | null;
        releasedAt: Date | null;
      }>(
        `SELECT id::text,revision_id::text AS "revisionId",schedule_type AS "scheduleType",
              reservation_date::text AS "reservationDate",status,
              invalidated_at AS "invalidatedAt",released_at AS "releasedAt"
         FROM ovpsa_first_year_service_reservations
        WHERE batch_id=$1 ORDER BY created_at DESC,schedule_type`,
        [batchId],
      ),
      query<{
        id: string;
        studentNumber: string;
        scheduleType: "LABORATORY" | "PHYSICAL_EXAM";
        appointmentDate: string;
        status: string;
        isPublished: boolean;
        isVerified: boolean;
      }>(
        `SELECT appointment.id::text,appointment.student_number AS "studentNumber",
              appointment.schedule_type AS "scheduleType",
              appointment.appointment_date::text AS "appointmentDate",
              appointment.status,appointment.is_published AS "isPublished",
              (verification.id IS NOT NULL) AS "isVerified"
         FROM appointments appointment
         LEFT JOIN ovpsa_external_laboratory_verifications verification
           ON verification.appointment_id=appointment.id
        WHERE appointment.ovpsa_batch_id=$1
        ORDER BY appointment.student_number,appointment.appointment_date,appointment.id`,
        [batchId],
      ),
      query<{
        action: string;
        metadata: Record<string, unknown>;
        createdAt: Date;
        actorName: string | null;
      }>(
        `SELECT audit.action,audit.metadata,audit.created_at AS "createdAt",
              actor.full_name AS "actorName"
         FROM audit_logs audit
         LEFT JOIN users actor ON actor.id=audit.actor_user_id
        WHERE audit.entity_type='ovpsa_first_year_batch' AND audit.entity_id=$1
        ORDER BY audit.created_at DESC,audit.id DESC`,
        [batchId],
      ),
    ]);
  return {
    ...item,
    laboratoryLocationName: "Iloilo Mission Hospital" as const,
    memberCount: members.rowCount ?? 0,
    members: members.rows,
    revisions: revisions.rows.map((revision) => ({
      ...revision,
      createdAt: revision.createdAt.toISOString(),
      publishedAt: revision.publishedAt?.toISOString() ?? null,
    })),
    reservations: reservations.rows.map((reservation) => ({
      ...reservation,
      invalidatedAt: reservation.invalidatedAt?.toISOString() ?? null,
      releasedAt: reservation.releasedAt?.toISOString() ?? null,
    })),
    appointments: appointments.rows.map((appointment) => ({
      ...appointment,
      locationName:
        appointment.scheduleType === "LABORATORY"
          ? "Iloilo Mission Hospital"
          : "CPU Clinic",
      displayStatus:
        appointment.scheduleType === "LABORATORY" &&
        appointment.status === "PENDING" &&
        !appointment.isVerified
          ? "Awaiting External Laboratory Result"
          : appointment.status,
    })),
    history: audits.rows.map((audit) => ({
      ...audit,
      createdAt: audit.createdAt.toISOString(),
    })),
    createdAt: item.createdAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
  };
}

export async function updateOvpsaFirstYearDraft(
  batchId: string,
  input: TokenInput & {
    laboratoryDate: string;
    physicalExamDateOverride: string | null;
    physicalExamExceptionReason: string | null;
  },
  actorUserId: string,
) {
  const defaultPhysicalExamDate = addDays(input.laboratoryDate, 7);
  const physicalExamDate =
    input.physicalExamDateOverride ?? defaultPhysicalExamDate;
  const reason = input.physicalExamExceptionReason?.trim() || null;
  if (physicalExamDate < defaultPhysicalExamDate) {
    throw new AppError(
      "OVPSA_PHYSICAL_EXAM_OVERRIDE_TOO_EARLY",
      "The PE date cannot be earlier than +7.",
      422,
    );
  }
  if (physicalExamDate > defaultPhysicalExamDate && !reason) {
    throw new AppError(
      "OVPSA_PHYSICAL_EXAM_EXCEPTION_REASON_REQUIRED",
      "Enter the PE exception reason.",
      422,
    );
  }
  return transaction(async (client) => {
    const batch = await loadOvpsaBatchWithCurrentRevision(
      client,
      batchId,
      true,
    );
    if (!batch)
      throw new AppError(
        "OVPSA_BATCH_NOT_FOUND",
        "First Year batch not found.",
        404,
      );
    assertToken(batch, input.optimisticToken);
    if (
      batch.status !== "DRAFT" ||
      !["DRAFT", "VALIDATED"].includes(batch.revisionStatus)
    ) {
      throw new AppError(
        "OVPSA_BATCH_NOT_EDITABLE",
        "Only a draft batch can be edited.",
        409,
      );
    }
    await client.query(
      `UPDATE ovpsa_first_year_batch_revisions
          SET status='DRAFT',laboratory_date=$2,physical_exam_date=$3,
              physical_exam_exception_reason=$4,validation_snapshot=NULL,
              validated_by=NULL,validated_at=NULL
        WHERE id=$1`,
      [
        batch.revisionId,
        input.laboratoryDate,
        physicalExamDate,
        physicalExamDate === defaultPhysicalExamDate ? null : reason,
      ],
    );
    const optimisticToken = randomUUID();
    await client.query(
      "UPDATE ovpsa_first_year_batches SET optimistic_token=$2,updated_by=$3 WHERE id=$1",
      [batchId, optimisticToken, actorUserId],
    );
    await writeAudit(
      actorUserId,
      "OVPSA_FIRST_YEAR_DRAFT_UPDATED",
      "ovpsa_first_year_batch",
      batchId,
      {
        revisionId: batch.revisionId,
        laboratoryDate: input.laboratoryDate,
        physicalExamDate,
      },
      client,
    );
    return {
      batchId,
      revisionId: batch.revisionId,
      optimisticToken,
      status: "DRAFT" as const,
    };
  });
}
