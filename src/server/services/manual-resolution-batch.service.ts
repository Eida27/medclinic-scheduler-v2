import "server-only";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";
import { AppError } from "@/lib/errors";
import { serverEnv } from "@/lib/env";
import { manilaCalendarDate } from "@/lib/academic-year";
import { transaction } from "@/server/db/pool";
import { lockAcademicYearSchedulingBoundary } from "@/server/repositories/academic-years.repository";
import { lockSchedulingMutationQueue } from "@/server/repositories/effective-appointment-scope-lock.repository";
import { getManualRescheduleDestinationState } from "@/server/repositories/appointments.repository";
import { getInternalOccupancy, internalOccupancyPredicate } from "@/server/schedule/scheduling-occupancy.repository";
import { isSchedulingDateBlocked } from "@/server/repositories/scheduling-blocked-dates.repository";
import { assertManualAppointmentDestination, assertReplacementPairOrder } from "@/server/appointments/manual-appointment-destination";
import { lockClinicManualResolutionCases } from "./clinic-manual-resolution-locks";
import { loadAppointmentStates, currentAssignmentBlock, resolveClinicClosureManualCaseWithClient, type AppointmentState } from "./clinic-calendar.service";
import type { SessionUser } from "@/types/roles";
import type { ClinicManualCaseResolutionRequest } from "@/types/clinic-calendar";

const casesSchema = z.array(z.object({ caseId: z.uuid(), expectedOptimisticToken: z.uuid() }).strict()).min(1).max(100)
  .refine((rows) => new Set(rows.map((row) => row.caseId)).size === rows.length, "Select each case only once.");
export const manualResolutionBatchSchema = z.object({
  cases: casesSchema,
  laboratoryDate: z.iso.date().optional(), physicalExamDate: z.iso.date().optional(),
  replaceRelatedServices: z.boolean(), preservationAcknowledged: z.literal(true),
  reason: z.string().trim().min(3).max(500),
}).strict();
export type ManualResolutionBatchPayload = z.infer<typeof manualResolutionBatchSchema>;
const resolveSchema = manualResolutionBatchSchema.extend({ requestId: z.uuid(), previewToken: z.string().min(20).max(10000) });
const availabilitySchema = z.object({ cases: casesSchema, replaceRelatedServices: z.boolean(),
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).refine((value) => Number(value.slice(0,4)) >= 2020 && Number(value.slice(0,4)) <= 2101), service: z.enum(["LABORATORY", "PHYSICAL_EXAM"]) }).strict();
const selectionSchema = z.object({ academicYearStart: z.coerce.number().int().min(2020).max(2100),
  closureGroupId: z.uuid().optional(), importGroupId: z.uuid().optional(), search: z.string().trim().max(100).optional(),
  service: z.enum(["LABORATORY", "PHYSICAL_EXAM"]).optional(), status: z.enum(["OPEN", "RESOLVED"]).optional(),
  reasonCode: z.string().max(100).optional(), date: z.iso.date().optional(),
}).strict();
type Issue = { code: string; message: string };
type Service = "LABORATORY" | "PHYSICAL_EXAM";
type Case = { id: string; studentNumber: string; academicYearStart: number; status: string;
  optimisticToken: string; reasonCode: string; laboratoryId: string | null; physicalExamId: string | null; schedulePairId: string | null };
type ServicePlan = { sourceId: string; clinicId: string; oldDate: string; newDate: string; action: "MOVE" | "PRESERVE"; status: string };
type Row = { caseId: string; studentNumber: string; academicYearStart: number; laboratory: ServicePlan | null;
  physicalExam: ServicePlan | null; retainedTests: string[]; issues: Issue[] };
type Capacity = { clinicId: string; service: Service; date: string; used: number; maximum: number | null;
  available: number; required: number; departing: number; projected: number };
const fail = (code: string, message: string): never => { throw new AppError(code, message, 409); };
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function payloadHash(payload: ManualResolutionBatchPayload) {
  return digest({ cases: [...payload.cases].sort((a,b) => a.caseId.localeCompare(b.caseId)),
    laboratoryDate: payload.laboratoryDate ?? null, physicalExamDate: payload.physicalExamDate ?? null,
    replaceRelatedServices: payload.replaceRelatedServices, preservationAcknowledged: payload.preservationAcknowledged,
    reason: payload.reason.trim() });
}
function mac(body: string, secret: string) {
  const key = createHmac("sha256", secret).update("medclinic:manual-resolution-preview:v1").digest();
  return createHmac("sha256", key).update(body).digest("base64url");
}
type Proof = { actorId: string; payloadHash: string; fingerprint: string; expiresAt: number };
export function signManualResolutionPreview(input: { actorId: string; payload: ManualResolutionBatchPayload; fingerprint: string; now?: number; secret?: string }) {
  const body = Buffer.from(JSON.stringify({ actorId: input.actorId, payloadHash: payloadHash(input.payload),
    fingerprint: input.fingerprint, expiresAt: (input.now ?? Date.now()) + 600000 })).toString("base64url");
  return `${body}.${mac(body, input.secret ?? serverEnv().JWT_SECRET)}`;
}
export function verifyManualResolutionPreview(token: string, input: { actorId: string; payload: ManualResolutionBatchPayload; now?: number; secret?: string }): Proof {
  const [body, signature, extra] = token.split(".");
  if (!body || !signature || extra || body.length > 9000) return fail("MANUAL_PREVIEW_INVALID", "Preview this selection again.");
  const expected = Buffer.from(mac(body, input.secret ?? serverEnv().JWT_SECRET));
  const supplied = Buffer.from(signature);
  if (supplied.length !== expected.length || !timingSafeEqual(expected, supplied)) return fail("MANUAL_PREVIEW_INVALID", "Preview this selection again.");
  let proof: Proof;
  try { proof = JSON.parse(Buffer.from(body, "base64url").toString("utf8")); }
  catch { return fail("MANUAL_PREVIEW_INVALID", "Preview this selection again."); }
  if (!proof || proof.actorId !== input.actorId || proof.payloadHash !== payloadHash(input.payload) || typeof proof.fingerprint !== "string") return fail("MANUAL_PREVIEW_INVALID", "Preview this selection again.");
  if (!Number.isFinite(proof.expiresAt) || (input.now ?? Date.now()) >= proof.expiresAt) return fail("MANUAL_PREVIEW_EXPIRED", "The preview expired. Review this selection again.");
  return proof;
}
export function projectedManualCapacity(used: number, sources: Array<{ id: string; consumes: boolean }>, replacements: number) {
  return used - new Set(sources.filter((source) => source.consumes).map((source) => source.id)).size + replacements;
}
async function authorize(client: PoolClient, actor: SessionUser) {
  const row = (await client.query<{ role: string; credentialVersion: number; verified: boolean; mustChangePassword: boolean }>(
    `SELECT role,credential_version AS "credentialVersion",email_verified_at IS NOT NULL AS verified,
       must_change_password AS "mustChangePassword" FROM users WHERE id=$1 AND deleted_at IS NULL FOR SHARE`, [actor.userId])).rows[0];
  if (!row || (actor.credentialVersion !== undefined && row.credentialVersion !== actor.credentialVersion)) throw new AppError("SESSION_EXPIRED", "Your session is no longer active.", 401);
  if (row.role !== "ADMIN" || !row.verified || row.mustChangePassword) throw new AppError("FORBIDDEN", "Only an active Administrator may resolve manual cases.", 403);
}
async function loadCases(client: PoolClient, ids: string[]) {
  return (await client.query<Case>(`SELECT id::text,student_number AS "studentNumber",schedule_cycle_start AS "academicYearStart",
    status,optimistic_token::text AS "optimisticToken",reason_code AS "reasonCode",schedule_pair_id::text AS "schedulePairId",
    affected_laboratory_appointment_id::text AS "laboratoryId",affected_physical_exam_appointment_id::text AS "physicalExamId"
    FROM clinic_closure_manual_cases WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE`, [ids])).rows;
}
function moves(appointment: AppointmentState, related: boolean) {
  return appointment.status === "AWAITING_RESCHEDULE" || (related && appointment.status !== "COMPLETED");
}
function baseIssues(manual: Case, appointments: AppointmentState[], closingDate?: string): Issue[] {
  const issues: Issue[] = [];
  const add = (code: string, message: string) => issues.push({ code, message });
  if (manual.status !== "OPEN") add("MANUAL_CASE_ALREADY_RESOLVED", "This case is already resolved.");
  if (!closingDate || closingDate < manilaCalendarDate(new Date())) add("ACADEMIC_YEAR_ENDED", "The academic year is missing or closed.");
  if (manual.reasonCode === "OVPSA_LABORATORY_PROTECTED" || appointments.some((a) => a.ovpsaBatchId && a.scheduleType === "LABORATORY" && a.status === "AWAITING_RESCHEDULE")) add("OVPSA_BATCH_RECOVERY_REQUIRED", "Use coordinated OVPSA Laboratory recovery for the entire batch.");
  if (!appointments.some((a) => a.status === "AWAITING_RESCHEDULE")) add("MANUAL_CASE_NO_AWAITING_APPOINTMENT", "No service is awaiting replacement.");
  if (appointments.some((a) => ["CANCELLED","RESCHEDULED"].includes(a.status))) add("MANUAL_SOURCE_CHANGED", "The stored pair includes a cancelled or superseded service. Review the individual case.");
  if (appointments.length !== 2 || !manual.schedulePairId || appointments.some((a) => a.studentNumber !== manual.studentNumber || a.scheduleCycleStart !== manual.academicYearStart || a.schedulePairId !== manual.schedulePairId)) add("PAIR_MISSING_OR_INCONSISTENT", "The stored appointment pair is incomplete or inconsistent.");
  return issues;
}
async function plan(client: PoolClient, payload: ManualResolutionBatchPayload) {
  await lockClinicManualResolutionCases(client, payload.cases.map((row) => row.caseId));
  const cases = await loadCases(client, payload.cases.map((row) => row.caseId));
  const appointments = await loadAppointmentStates(client, cases.flatMap((row) => [row.laboratoryId, row.physicalExamId].filter((id): id is string => !!id)));
  const byId = new Map(appointments.map((row) => [row.id, row]));
  const rows: Row[] = [], requests: Array<{ caseId: string; request: ClinicManualCaseResolutionRequest }> = [];
  const boundaries = new Map<number, string | undefined>();
  for (const year of [...new Set(cases.map((row) => row.academicYearStart))].sort()) boundaries.set(year, (await lockAcademicYearSchedulingBoundary(client, year))?.closingDate);
  const selectedScopes = new Set<string>(), selectedSources = new Set<string>();
  const moving: Array<{ appointment: AppointmentState; date: string; row: Row }> = [];
  const versions = (await client.query(`SELECT * FROM appointments WHERE id=ANY($1::uuid[]) ORDER BY id`, [appointments.map((row) => row.id)])).rows;
  const successors = (await client.query<{ rescheduled_from: string }>(`SELECT rescheduled_from::text FROM appointments
    WHERE rescheduled_from=ANY($1::uuid[]) AND status NOT IN ('CANCELLED','RESCHEDULED') ORDER BY id`, [appointments.map((row) => row.id)])).rows;
  const checklist = (await client.query<{ appointment_id: string; version: number; test_code: string | null }>(
    `SELECT link.appointment_id::text,checklist.version,item.test_code FROM laboratory_checklist_appointments link
      JOIN laboratory_checklists checklist ON checklist.id=link.checklist_id
      LEFT JOIN laboratory_checklist_items item ON item.checklist_id=checklist.id AND item.verified_at IS NOT NULL
      WHERE link.appointment_id=ANY($1::uuid[]) ORDER BY link.appointment_id,item.test_code`, [appointments.map((row) => row.id)])).rows;
  for (const selected of [...payload.cases].sort((a,b) => a.caseId.localeCompare(b.caseId))) {
    const manual = cases.find((row) => row.id === selected.caseId);
    const row: Row = { caseId: selected.caseId, studentNumber: manual?.studentNumber ?? "", academicYearStart: manual?.academicYearStart ?? 0, laboratory: null, physicalExam: null, retainedTests: [], issues: [] };
    rows.push(row);
    if (!manual) { row.issues.push({ code: "MANUAL_CASE_NOT_FOUND", message: "This case is no longer available." }); continue; }
    const pair = [manual.laboratoryId, manual.physicalExamId].flatMap((id) => id && byId.has(id) ? [byId.get(id)!] : []);
    row.issues.push(...baseIssues(manual, pair, boundaries.get(manual.academicYearStart)));
    if (pair.some((a) => successors.some((successor) => successor.rescheduled_from === a.id))) row.issues.push({ code: "MANUAL_SOURCE_CHANGED", message: "An appointment already has a current replacement. Review the individual case." });
    if (manual.optimisticToken !== selected.expectedOptimisticToken) row.issues.push({ code: "MANUAL_CASE_STALE", message: "The case changed. Reload it." });
    if (boundaries.size !== 1) row.issues.push({ code: "MANUAL_CROSS_CYCLE", message: "Select cases from one academic year." });
    const scope = `${manual.studentNumber}:${manual.academicYearStart}`;
    if (selectedScopes.has(scope) || pair.some((a) => selectedSources.has(a.id))) row.issues.push({ code: "MANUAL_SELECTION_OVERLAP", message: "Cases overlap the same student/cycle or source appointment." });
    selectedScopes.add(scope); pair.forEach((a) => selectedSources.add(a.id));
    const request: ClinicManualCaseResolutionRequest = { action: "ASSIGN_REPLACEMENT", expectedOptimisticToken: selected.expectedOptimisticToken, reason: payload.reason, preserveLaboratory: true, preservePhysicalExam: true };
    for (const appointment of pair) {
      const move = moves(appointment, payload.replaceRelatedServices);
      const date = appointment.scheduleType === "LABORATORY" ? payload.laboratoryDate : payload.physicalExamDate;
      const servicePlan: ServicePlan = { sourceId: appointment.id, clinicId: appointment.clinicId, oldDate: appointment.appointmentDate, newDate: move && date ? date : appointment.appointmentDate, action: move ? "MOVE" : "PRESERVE", status: appointment.status };
      if (appointment.scheduleType === "LABORATORY") row.laboratory = servicePlan; else row.physicalExam = servicePlan;
      if (!move) continue;
      const block = currentAssignmentBlock([appointment]);
      if (block) row.issues.push(block);
      if (!["DRAFT", "PENDING", "AWAITING_RESCHEDULE"].includes(appointment.status)) row.issues.push({ code: "MANUAL_SOURCE_CHANGED", message: "This service cannot be moved in its current state." });
      if (!date) { row.issues.push({ code: "MANUAL_DATE_REQUIRED", message: `Choose a replacement ${appointment.scheduleType} date.` }); continue; }
      moving.push({ appointment, date, row });
      if (appointment.scheduleType === "LABORATORY") { request.laboratoryDate = date; request.preserveLaboratory = false; }
      else { request.physicalExamDate = date; request.preservePhysicalExam = false; }
    }
    row.retainedTests = checklist.filter((item) => item.appointment_id === manual.laboratoryId && item.test_code).map((item) => item.test_code!);
    if (row.laboratory && row.physicalExam) {
      try { assertReplacementPairOrder(row.laboratory.newDate, row.physicalExam.newDate, pair.some((a) => a.ovpsaBatchId) ? 7 : 1); }
      catch (error) { if (error instanceof AppError) row.issues.push({ code: error.code, message: error.message }); else throw error; }
    }
    requests.push({ caseId: manual.id, request });
  }
  for (const service of ["LABORATORY", "PHYSICAL_EXAM"] as const) {
    if ((service === "LABORATORY" ? payload.laboratoryDate : payload.physicalExamDate) && !moving.some((move) => move.appointment.scheduleType === service)) rows.forEach((row) => row.issues.push({ code: "MANUAL_DATE_NOT_APPLICABLE", message: `No selected ${service} service is being replaced.` }));
  }
  const consumingIds = new Set((await client.query<{ id: string }>(`SELECT appointment.id::text FROM appointments appointment WHERE appointment.id=ANY($1::uuid[]) AND ${internalOccupancyPredicate("appointment")}`, [moving.map((move) => move.appointment.id)])).rows.map((row) => row.id));
  const capacity: Capacity[] = [], rules: unknown[] = [];
  const groups = new Map<string, typeof moving>();
  for (const move of moving) {
    const key = `${move.appointment.clinicId}:${move.appointment.scheduleType}:${move.date}`;
    groups.set(key, [...(groups.get(key) ?? []), move]);
  }
  for (const key of [...groups.keys()].sort()) {
    const group = groups.get(key)!, { appointment, date } = group[0];
    const state = await getManualRescheduleDestinationState(client, { appointmentId: appointment.id, clinicId: appointment.clinicId, scheduleType: appointment.scheduleType, appointmentDate: date, scheduleCycleStart: appointment.scheduleCycleStart });
    const used = await getInternalOccupancy(client, date, appointment.clinicId, appointment.scheduleType);
    const departures = moving.filter((move) => move.appointment.clinicId === appointment.clinicId && move.appointment.scheduleType === appointment.scheduleType && move.appointment.appointmentDate === date).map((move) => ({ id: move.appointment.id, consumes: consumingIds.has(move.appointment.id) }));
    const required = new Set(group.map((move) => move.appointment.id)).size;
    const projected = projectedManualCapacity(used, departures, required);
    const blocked = await isSchedulingDateBlocked(client, { scheduleType: appointment.scheduleType, date });
    rules.push({ key, blocked, closingDate: state.cycleClosingDate });
    capacity.push({ clinicId: appointment.clinicId, service: appointment.scheduleType, date, used, maximum: state.maxDailyCapacity, available: Math.max(0, (state.maxDailyCapacity ?? 0) - used), required, departing: used + required - projected, projected });
    try {
      if (state.maxDailyCapacity === null) fail("SCHEDULE_CAPACITY_NOT_CONFIGURED", "Daily capacity is not configured for this service.");
      assertManualAppointmentDestination({ appointment, pair: { laboratory: null, physicalExam: null }, destinationDate: date, manilaToday: manilaCalendarDate(new Date()), cycleStartDate: `${appointment.scheduleCycleStart}-08-01`, cycleClosingDate: state.cycleClosingDate ?? "", isBlocked: blocked, usedCapacity: projected - 1, maxDailyCapacity: state.maxDailyCapacity! });
    } catch (error) { if (!(error instanceof AppError)) throw error; group.forEach((move) => move.row.issues.push({ code: error.code, message: error.message })); }
  }
  return { rows, requests, capacity, fingerprint: digest({ cases, appointments, versions, successors, checklist, boundaries: [...boundaries], capacity, rules, today: manilaCalendarDate(new Date()) }) };
}
export async function previewManualResolutionBatch(raw: unknown, actor: SessionUser) {
  const payload = manualResolutionBatchSchema.parse(raw);
  return transaction(async (client) => {
    await authorize(client, actor);
    const reviewed = await plan(client, payload);
    const valid = reviewed.rows.every((row) => !row.issues.length);
    return { rows: reviewed.rows, capacity: reviewed.capacity, studentCount: reviewed.rows.length,
      appointmentCount: reviewed.capacity.reduce((sum, item) => sum + item.required, 0),
      expiresAt: valid ? new Date(Date.now() + 600000).toISOString() : null,
      previewToken: valid ? signManualResolutionPreview({ actorId: actor.userId, payload, fingerprint: reviewed.fingerprint }) : null };
  });
}
export async function resolveManualResolutionBatch(raw: unknown, actor: SessionUser) {
  const input = resolveSchema.parse(raw);
  const { requestId, previewToken, ...payload } = input;
  return transaction(async (client) => {
    await authorize(client, actor);
    await lockSchedulingMutationQueue(client);
    const prior = (await client.query<{ action: string; payload_hash: string; outcome: unknown }>(`SELECT action,payload_hash,outcome FROM clinical_mutation_requests WHERE actor_user_id=$1 AND request_id=$2 FOR UPDATE`, [actor.userId, requestId])).rows[0];
    if (prior) {
      if (prior.action !== "BULK_MANUAL_RESOLUTION" || prior.payload_hash !== payloadHash(payload)) fail("CLINICAL_REQUEST_CONFLICT", "This request ID was used with different details.");
      return prior.outcome;
    }
    const proof = verifyManualResolutionPreview(previewToken, { actorId: actor.userId, payload });
    const reviewed = await plan(client, payload);
    if (reviewed.rows.some((row) => row.issues.length) || reviewed.fingerprint !== proof.fingerprint) fail("MANUAL_PREVIEW_STALE", "Cases, clinical state or capacity changed. Preview again.");
    let notificationWarningCount = 0;
    for (const item of reviewed.requests) {
      const row = reviewed.rows.find((row) => row.caseId === item.caseId)!;
      const projectedUsedCapacity = new Map<string, number>();
      for (const service of [row.laboratory, row.physicalExam]) if (service?.action === "MOVE") {
        const destination = reviewed.capacity.find((capacity) => capacity.clinicId === service.clinicId && capacity.service === (service === row.laboratory ? "LABORATORY" : "PHYSICAL_EXAM") && capacity.date === service.newDate)!;
        projectedUsedCapacity.set(service.sourceId, destination.projected - 1);
      }
      const outcome = await resolveClinicClosureManualCaseWithClient(client, item.caseId, item.request, actor, { projectedUsedCapacity });
      notificationWarningCount += outcome.notificationWarningCount;
      await client.query(`UPDATE clinic_closure_manual_cases SET resolution_details=resolution_details || jsonb_build_object('bulkRequestId',$2::text) WHERE id=$1`, [item.caseId, requestId]);
      await client.query(`INSERT INTO audit_logs(actor_user_id,action,entity_type,entity_id,metadata)
        VALUES ($1,'BULK_MANUAL_CASE_RESOLVED','clinic_closure_manual_case',$2,$3::jsonb)`, [actor.userId,item.caseId,JSON.stringify({ requestId,reason:payload.reason,laboratory:row.laboratory,physicalExam:row.physicalExam })]);
    }
    const mappings = (await client.query(`SELECT manual_case_id::text AS "caseId",old_laboratory_appointment_id::text AS "sourceLaboratoryId",new_laboratory_appointment_id::text AS "laboratoryAppointmentId",old_physical_exam_appointment_id::text AS "sourcePhysicalExamId",new_physical_exam_appointment_id::text AS "physicalExamAppointmentId" FROM appointment_reschedule_events WHERE manual_case_id=ANY($1::uuid[]) ORDER BY manual_case_id,id`, [payload.cases.map((row) => row.caseId)])).rows;
    const outcome = { caseIds: reviewed.rows.map((row) => row.caseId), mappings, studentCount: reviewed.rows.length, appointmentCount: reviewed.capacity.reduce((sum, item) => sum + item.required, 0), notificationWarningCount };
    await client.query(`INSERT INTO audit_logs(actor_user_id,action,entity_type,entity_id,metadata) VALUES ($1,'BULK_MANUAL_RESOLUTION','manual_resolution_batch',$2,$3::jsonb)`, [actor.userId, requestId, JSON.stringify({ ...outcome, reason: payload.reason, requestId })]);
    await client.query(`INSERT INTO clinical_mutation_requests(actor_user_id,request_id,action,payload_hash,outcome) VALUES ($1,$2,'BULK_MANUAL_RESOLUTION',$3,$4::jsonb)`, [actor.userId, requestId, payloadHash(payload), JSON.stringify(outcome)]);
    return outcome;
  });
}

/** Group membership follows stored source lineage, including verified OVPSA imports. */
export async function selectManualResolutionCases(raw: unknown, actor: SessionUser) {
  const input = selectionSchema.parse(raw);
  return transaction(async (client) => {
    await authorize(client, actor);
    await lockSchedulingMutationQueue(client);
    const boundary = await lockAcademicYearSchedulingBoundary(client, input.academicYearStart);
    const items: Array<{ caseId: string; expectedOptimisticToken: string; studentNumber: string; academicYearStart: number; laboratory: AppointmentState | null; physicalExam: AppointmentState | null }> = [];
    const blockedReasons: Record<string, number> = {};
    let cursor: string | null = null, total = 0, eligibleCount = 0, blockedCount = 0;
    // Bound every database page and the response independently of group size.
    for (;;) {
      const page: Array<{ id: string }> = (await client.query<{ id: string }>(`SELECT manual.id::text FROM clinic_closure_manual_cases manual
        WHERE manual.schedule_cycle_start=$1 AND ($2::uuid IS NULL OR manual.closure_group_id=$2)
          AND ($3::uuid IS NULL OR EXISTS (
            SELECT 1 FROM appointments source LEFT JOIN schedule_batches batch ON batch.id=source.batch_id
              LEFT JOIN ovpsa_first_year_batches ovpsa ON ovpsa.id=source.ovpsa_batch_id
              JOIN schedule_import_groups import_group ON import_group.id=COALESCE(batch.import_group_id,ovpsa.source_import_group_id)
            WHERE source.id IN (manual.affected_laboratory_appointment_id,manual.affected_physical_exam_appointment_id)
              AND import_group.id=$3 AND import_group.academic_year_start=manual.schedule_cycle_start))
          AND ($4::text IS NULL OR manual.student_number ILIKE '%' || $4 || '%' OR EXISTS (
            SELECT 1 FROM students student WHERE student.student_number=manual.student_number
              AND concat_ws(' ',student.first_name,student.middle_name,student.last_name) ILIKE '%' || $4 || '%'))
          AND ($5::text IS NULL OR EXISTS (SELECT 1 FROM appointments source WHERE source.id IN
            (manual.affected_laboratory_appointment_id,manual.affected_physical_exam_appointment_id) AND source.schedule_type=$5))
          AND ($6::text IS NULL OR manual.status=$6) AND ($7::text IS NULL OR manual.reason_code=$7)
          AND ($8::date IS NULL OR EXISTS (SELECT 1 FROM appointments source WHERE source.id IN
            (manual.affected_laboratory_appointment_id,manual.affected_physical_exam_appointment_id) AND source.appointment_date=$8)
            OR EXISTS (SELECT 1 FROM clinic_closure_groups closure WHERE closure.id=manual.closure_group_id AND $8 BETWEEN closure.start_date AND closure.end_date))
          AND ($9::uuid IS NULL OR manual.id>$9) ORDER BY manual.id LIMIT 100`,
      [input.academicYearStart,input.closureGroupId ?? null,input.importGroupId ?? null,input.search ?? null,input.service ?? null,input.status ?? "OPEN",input.reasonCode ?? null,input.date ?? null,cursor])).rows;
      if (!page.length) break;
      const cases = await loadCases(client, page.map((row) => row.id));
      const appointments = await loadAppointmentStates(client, cases.flatMap((row) => [row.laboratoryId,row.physicalExamId].filter((id): id is string => !!id)));
      for (const manual of cases) {
        total++;
        const pair = appointments.filter((a) => a.id === manual.laboratoryId || a.id === manual.physicalExamId);
        const issues = baseIssues(manual, pair, boundary?.closingDate);
        const block = currentAssignmentBlock(pair.filter((a) => moves(a, false)));
        if (block) issues.push(block);
        if (issues.length) { blockedCount++; for (const issue of issues) blockedReasons[issue.code] = (blockedReasons[issue.code] ?? 0) + 1; }
        else {
          eligibleCount++;
          if (items.length < 100) items.push({ caseId: manual.id, expectedOptimisticToken: manual.optimisticToken,
            studentNumber: manual.studentNumber, academicYearStart: manual.academicYearStart,
            laboratory: pair.find((a) => a.scheduleType === "LABORATORY") ?? null,
            physicalExam: pair.find((a) => a.scheduleType === "PHYSICAL_EXAM") ?? null });
        }
      }
      cursor = page[page.length - 1].id;
      if (page.length < 100) break;
    }
    return { items: eligibleCount > 100 ? [] : items, total, eligibleCount, blockedCount, blockedReasons, tooMany: eligibleCount > 100 };
  });
}

export async function getManualResolutionAvailability(raw: unknown, actor: SessionUser) {
  const input = availabilitySchema.parse(raw);
  return transaction(async (client) => {
    await authorize(client, actor);
    await lockClinicManualResolutionCases(client, input.cases.map((row) => row.caseId));
    const cases = await loadCases(client, input.cases.map((row) => row.caseId));
    if (cases.length !== input.cases.length || cases.some((row) => row.optimisticToken !== input.cases.find((item) => item.caseId === row.id)?.expectedOptimisticToken)) fail("MANUAL_CASE_STALE", "The selection changed. Refresh it.");
    const years = [...new Set(cases.map((row) => row.academicYearStart))];
    if (years.length !== 1) fail("MANUAL_CROSS_CYCLE", "Select cases from one academic year.");
    if (new Set(cases.map((row) => row.studentNumber)).size !== cases.length) fail("MANUAL_SELECTION_OVERLAP", "Select only one case per student and cycle.");
    const boundary = await lockAcademicYearSchedulingBoundary(client, years[0]);
    const appointments = await loadAppointmentStates(client, cases.flatMap((row) => [row.laboratoryId,row.physicalExamId].filter((id): id is string => !!id)));
    for (const manual of cases) {
      const pair = appointments.filter((a) => a.id === manual.laboratoryId || a.id === manual.physicalExamId);
      const issues = baseIssues(manual, pair, boundary?.closingDate);
      const block = currentAssignmentBlock(pair.filter((a) => moves(a, input.replaceRelatedServices)));
      if (issues.length || block) fail(issues[0]?.code ?? block!.code, issues[0]?.message ?? block!.message);
    }
    const moving = appointments.filter((a) => a.scheduleType === input.service && moves(a,input.replaceRelatedServices));
    if (!moving.length) fail("MANUAL_DATE_NOT_APPLICABLE", "No selected service requires a date.");
    const consumingIds = new Set((await client.query<{ id: string }>(`SELECT appointment.id::text FROM appointments appointment WHERE appointment.id=ANY($1::uuid[]) AND ${internalOccupancyPredicate("appointment")}`, [moving.map((row) => row.id)])).rows.map((row) => row.id));
    const [year,month] = input.month.split("-").map(Number);
    const dayCount = new Date(Date.UTC(year,month,0)).getUTCDate();
    const days: Array<{ date: string; state: "AVAILABLE" | "FULL" | "INSUFFICIENT" | "UNAVAILABLE"; issues: Issue[]; capacity: Capacity[] }> = [];
    for (let day=1; day<=dayCount; day++) {
      const date = `${input.month}-${String(day).padStart(2,"0")}`;
      const capacity: Capacity[] = [], issues: Issue[] = [];
      const blocked = await isSchedulingDateBlocked(client, { scheduleType: input.service, date });
      for (const clinicId of [...new Set(moving.map((row) => row.clinicId))].sort()) {
        const group = moving.filter((row) => row.clinicId === clinicId), appointment = group[0];
        const destination = await getManualRescheduleDestinationState(client, { appointmentId: appointment.id, clinicId, scheduleType: input.service, appointmentDate: date, scheduleCycleStart: years[0] });
        const used = await getInternalOccupancy(client,date,clinicId,input.service);
        const projected = projectedManualCapacity(used, group.filter((row) => row.appointmentDate === date).map((row) => ({ id: row.id, consumes: consumingIds.has(row.id) })),group.length);
        capacity.push({ clinicId, service: input.service, date, used, maximum: destination.maxDailyCapacity, available: Math.max(0,(destination.maxDailyCapacity ?? 0)-used), required: group.length, departing: used+group.length-projected, projected });
        try {
          if (destination.maxDailyCapacity === null) fail("SCHEDULE_CAPACITY_NOT_CONFIGURED", "Daily capacity is not configured for this service.");
          assertManualAppointmentDestination({ appointment, pair: { laboratory: null, physicalExam: null }, destinationDate: date, manilaToday: manilaCalendarDate(new Date()), cycleStartDate: `${years[0]}-08-01`, cycleClosingDate: boundary?.closingDate ?? "", isBlocked: blocked, usedCapacity: projected-1, maxDailyCapacity: destination.maxDailyCapacity! });
        } catch (error) { if (error instanceof AppError) issues.push({ code: error.code, message: error.message }); else throw error; }
      }
      const dateIssue = issues.some((issue) => issue.code !== "DAILY_CAPACITY_EXCEEDED");
      const state = dateIssue ? "UNAVAILABLE" : capacity.some((item) => item.projected > (item.maximum ?? 0))
        ? capacity.some((item) => item.available + item.departing <= 0) ? "FULL" : "INSUFFICIENT" : "AVAILABLE";
      days.push({ date, state, issues, capacity });
    }
    return { month: input.month, service: input.service, required: moving.length, days };
  });
}
