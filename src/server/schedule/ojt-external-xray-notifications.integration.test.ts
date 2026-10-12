// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { pool, transaction } from "@/server/db/pool";
import { acceptAndScheduleImport } from "@/server/services/schedule-imports.service";
import { updateAppointment } from "@/server/services/appointments.service";
import { saveClinicCalendarChanges, resolveClinicClosureManualCase } from "@/server/services/clinic-calendar.service";
import { requestStudentEmailVerification, verifyStudentEmail } from "@/server/services/student-email.service";
import { queueFirstVerificationCurrentStateCatchUp } from "@/server/services/student-verification-catch-up.service";
import { listStudentNotifications, markStudentNotificationRead } from "@/server/services/student-notifications.service";
import { claimEmailOutboxMessages, deliverClaimedEmail, deliverEmailOutboxBatch } from "@/server/services/email-outbox.service";
import { getAppointmentMutationContext, rescheduleAppointmentWithClient } from "@/server/repositories/appointments.repository";
import { cleanupTestFixtures, insertTestAcademicSnapshot, TEST_REFERENCE_IDS } from "@/test/integration-fixtures";
import { linkPublishedLaboratoryAppointments } from "@/server/laboratory/laboratory-checklist.repository";
import { startLoopbackSmtpSink } from "../../../scripts/loopback-smtp-sink";
import type { SessionUser } from "@/types/roles";
import type { OjtExternalXraySchedule } from "./ojt-external-xray";
import { buildAdministratorRescheduledNotification, buildInitialPublicationNotification } from "./schedule-notifications";
import { queueAuthoritativeScheduleNotification } from "./schedule-notification-hooks";

const cycle = 2092;
const admin: SessionUser = { userId: TEST_REFERENCE_IDS.adminUser, fullName: "Test Admin",
  email: "admin@medclinic.local", role: "ADMIN" };
let sequence = 0;
const calendarRequests: string[] = [];
const createdYears: number[] = [];
type Appointment = { id: string; scheduleType: "LABORATORY" | "PHYSICAL_EXAM"; date: string; status: string };
type Fixture = { studentNumber: string; importId: string; laboratory: Appointment; physicalExam: Appointment };

function shift(date: string, days: number) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

async function fixture(year = 4, category = "OJT", overrides: Record<string, unknown> = {}): Promise<Fixture> {
  const n = ++sequence;
  const studentNumber = `91-99${String(n).padStart(2, "0")}-90`;
  // The import UI accepts Year 4 only as OJT. Exercise saved non-OJT cohorts without changing that policy.
  if (year === 4 && category !== "OJT") {
    return transaction(async (client) => {
      await client.query(`INSERT INTO students
        (student_number,first_name,middle_name,last_name,college_id,program_id,year_level,date_of_birth)
        VALUES ($1,'Notice','Fixture','Xray',$2,$3,4,'2004-01-01')`,
      [studentNumber, TEST_REFERENCE_IDS.college, TEST_REFERENCE_IDS.program]);
      const snapshotId = await insertTestAcademicSnapshot(client, { studentNumber, academicYearStart: cycle,
        importName: `OJT-XRAY saved ${n}`, actor: admin.userId });
      const importId = (await client.query<{ id: string }>(
        "SELECT source_import_group_id::text AS id FROM student_academic_snapshots WHERE id=$1", [snapshotId])).rows[0].id;
      const pairId = randomUUID();
      const rows = (await client.query<Appointment>(`INSERT INTO appointments
        (clinic_id,student_number,schedule_type,appointment_date,status,is_published,
         schedule_pair_id,schedule_cycle_start,scheduling_category,created_by,updated_by)
        VALUES ($1,$3,'LABORATORY','2092-11-03','PENDING',TRUE,$4,$5,$6,$7,$7),
               ($2,$3,'PHYSICAL_EXAM','2092-11-04','PENDING',TRUE,$4,$5,$6,$7,$7)
        RETURNING id::text,schedule_type AS "scheduleType",appointment_date::text AS date,status`,
      [TEST_REFERENCE_IDS.laboratoryClinic, TEST_REFERENCE_IDS.physicalExamClinic, studentNumber,
        pairId, cycle, category, admin.userId])).rows;
      const laboratory = rows.find((row) => row.scheduleType === "LABORATORY")!;
      await linkPublishedLaboratoryAppointments(client, [laboratory.id]);
      await queueAuthoritativeScheduleNotification(client, studentNumber,
        (state) => buildInitialPublicationNotification({ state, sourceType: "SCHEDULE_IMPORT_GROUP", sourceId: importId }));
      return { studentNumber, importId, laboratory,
        physicalExam: rows.find((row) => row.scheduleType === "PHYSICAL_EXAM")! };
    });
  }
  const contents = `Student ID,Surname,First Name,Middle Name,Suffix,College,Course,Year,Date of Birth\n${studentNumber},Xray,Notice,Fixture,,College of Computer Studies,BSIT,${year},2004-01-01`;
  const result = await acceptAndScheduleImport({ fileName: `OJT-XRAY-${n}.csv`,
    fileSize: Buffer.byteLength(contents), contents, studentCategory: category,
    academicYearStart: cycle, preferredMonth: category === "REGULAR" ? null : 11, ...overrides }, admin);
  const rows = (await pool.query<Appointment>(`SELECT id::text,schedule_type AS "scheduleType",
    appointment_date::text AS date,status FROM appointments WHERE student_number=$1 AND is_published=TRUE`,
  [studentNumber])).rows;
  return { studentNumber, importId: result.importId,
    laboratory: rows.find((row) => row.scheduleType === "LABORATORY")!,
    physicalExam: rows.find((row) => row.scheduleType === "PHYSICAL_EXAM")! };
}

async function notices(f: Fixture) {
  return (await listStudentNotifications(f.studentNumber)).items;
}

function expectDated(notice: Awaited<ReturnType<typeof notices>>[number], lab: Appointment) {
  const xrayDate = shift(lab.date, -7); // Independent calendar arithmetic; never use the production resolver for expectations.
  const expected: OjtExternalXraySchedule = { anchorLaboratoryAppointmentId: lab.id,
    laboratoryDate: lab.date, xrayDate, provider: "Iloilo Mission Hospital", offsetCalendarDays: 7 };
  expect(notice.metadata.externalXraySchedule).toEqual(expected);
  expect(notice.message).toContain(`X-ray schedule: ${xrayDate} at Iloilo Mission Hospital`);
  expect(notice.message).toContain(`appointment on ${lab.date}.`);
  expect(notice.message).toContain("Contact CPU Clinic for instructions if this date has passed.");
  return expected;
}

async function clinicalSnapshot(f: Fixture) {
  const appointments = (await pool.query(`SELECT id::text,schedule_type,status,is_published,appointment_date::text
    FROM appointments WHERE student_number=$1 ORDER BY id`, [f.studentNumber])).rows;
  const items = (await pool.query(`SELECT item.test_code,item.verified_at,item.verified_by,item.verification_source
    FROM laboratory_checklists checklist JOIN laboratory_checklist_items item ON item.checklist_id=checklist.id
    WHERE checklist.student_number=$1 ORDER BY item.test_code`, [f.studentNumber])).rows;
  const counts = (await pool.query(`SELECT
    (SELECT count(*)::int FROM ovpsa_first_year_service_reservations) AS reservations,
    (SELECT count(*)::int FROM laboratory_results WHERE student_number=$1) AS results,
    (SELECT count(*)::int FROM student_result_submissions WHERE student_number=$1) AS submissions,
    (SELECT count(*)::int FROM medical_certificate_revisions WHERE student_number=$1) AS certificates,
    (SELECT jsonb_agg(to_jsonb(setting) ORDER BY setting.id) FROM clinic_capacity_settings setting) AS capacity`,
  [f.studentNumber])).rows[0];
  return { appointments, items, counts };
}

async function verify(f: Fixture) {
  const request = await requestStudentEmailVerification(f.studentNumber, `ojt.${sequence}@notifications.test`);
  await verifyStudentEmail(request.token);
}

async function awaitResolution(f: Fixture) {
  const requestId = randomUUID();
  calendarRequests.push(requestId);
  const result = await saveClinicCalendarChanges({ requestId, emergencyAcknowledged: false,
    recoveryMode: "MANUAL_ALL", changes: [{ action: "BLOCK", date: f.laboratory.date,
      category: "CLOSURE", reason: "OJT-XRAY owned closure" }] }, admin);
  expect(result.manualCaseCount).toBe(1);
  return (await pool.query<{ id: string; token: string }>(`SELECT id::text,optimistic_token::text AS token
    FROM clinic_closure_manual_cases WHERE student_number=$1 AND status='OPEN'`, [f.studentNumber])).rows[0];
}

async function cleanup() {
  await pool.query("DELETE FROM appointment_reschedule_events WHERE student_number LIKE '91-99%'");
  await pool.query("DELETE FROM clinic_closure_manual_cases WHERE student_number LIKE '91-99%'");
  await cleanupTestFixtures("91-99%", "%OJT-XRAY%", "%OJT-XRAY%");
  await pool.query("DELETE FROM clinic_calendar_requests WHERE request_id=ANY($1::uuid[])", [calendarRequests]);
  await pool.query(`DELETE FROM clinic_unavailable_dates WHERE closure_group_id IN
    (SELECT id FROM clinic_closure_groups WHERE reason='OJT-XRAY owned closure')`);
  await pool.query("DELETE FROM clinic_closure_groups WHERE reason='OJT-XRAY owned closure'");
  calendarRequests.length = 0;
}
beforeAll(async () => {
  for (const year of [cycle]) {
    const result = await pool.query(`INSERT INTO academic_years(start_year,closing_date,created_by,updated_by)
      VALUES ($1,$2,$3,$3) ON CONFLICT (start_year) DO NOTHING RETURNING start_year`,
    [year, `${year + 1}-07-31`, admin.userId]);
    if (result.rowCount) createdYears.push(year);
  }
});
afterEach(async () => { vi.useRealTimers(); vi.unstubAllEnvs(); await cleanup(); });
afterAll(async () => {
  await cleanup();
  for (const year of createdYears) await pool.query("DELETE FROM academic_years WHERE start_year=$1", [year]);
  await pool.end();
});

describe("persisted OJT X-ray notification lifecycle", () => {
  it("publishes an immediate X-ray notice for an unverified OJT student", async () => {
    const f = await fixture();
    const initial = await notices(f);
    expect(initial).toHaveLength(1);
    expect(initial[0].notificationType).toBe("SCHEDULE_INITIAL_PUBLICATION");
    expectDated(initial[0], f.laboratory);
    expect((await pool.query("SELECT id FROM email_outbox WHERE student_number=$1", [f.studentNumber])).rows).toHaveLength(0);
    const before = await clinicalSnapshot(f);
    expect(before.appointments).toHaveLength(2);
    expect(before.items).toHaveLength(4);
    expect(before.items.every((item) => item.verified_at === null)).toBe(true);
    await transaction((client) => queueAuthoritativeScheduleNotification(client, f.studentNumber,
      (state) => buildInitialPublicationNotification({ state, sourceType: "SCHEDULE_IMPORT_GROUP", sourceId: f.importId })));
    await markStudentNotificationRead(f.studentNumber, initial[0].id);
    await notices(f);
    expect(await clinicalSnapshot(f)).toEqual(before);
    expect((await notices(f))[0].readAt).not.toBeNull();
  });

  it("updates the X-ray notice after a Laboratory replacement", async () => {
    const f = await fixture();
    const original = (await notices(f))[0];
    await markStudentNotificationRead(f.studentNumber, original.id);
    const readAt = (await notices(f))[0].readAt;
    const replacement = await updateAppointment(f.laboratory.id, { appointmentDate: shift(f.laboratory.date, -7) }, admin);
    const lab = { ...f.laboratory, id: replacement!.id, date: shift(f.laboratory.date, -7) };
    const updated = (await notices(f)).find((notice) => notice.notificationType === "SCHEDULE_ADMINISTRATOR_RESCHEDULED")!;
    expectDated(updated, lab);
    expect((await notices(f)).find((notice) => notice.id === original.id)?.readAt).toEqual(readAt);
    await transaction((client) => queueAuthoritativeScheduleNotification(client, f.studentNumber,
      (state) => buildAdministratorRescheduledNotification({ state, eventId: String(updated.metadata.sourceId),
        reason: "Administrator-authorized reschedule" })));
    expect((await notices(f)).filter((notice) => notice.id === updated.id)).toHaveLength(1);
    expect((await notices(f))).toHaveLength(2);
  });

  it("retains the anchor after a PE-only replacement", async () => {
    const f = await fixture();
    await updateAppointment(f.physicalExam.id, { appointmentDate: shift(f.physicalExam.date, 7) }, admin);
    expectDated((await notices(f))[0], f.laboratory);
  });

  it("clears the current X-ray date while Laboratory awaits resolution", async () => {
    const f = await fixture();
    await awaitResolution(f);
    const pending = (await notices(f))[0];
    expect(pending.notificationType).toBe("SCHEDULE_AWAITING_RESOLUTION");
    expect(pending.metadata.externalXraySchedule).toMatchObject({ laboratoryDate: null, xrayDate: null });
    expect(pending.message).toContain("X-ray schedule at Iloilo Mission Hospital: awaiting an authorized KABALAKA appointment date.");
    expect(pending.message).not.toContain(`X-ray schedule: ${shift(f.laboratory.date, -7)}`);
  });

  it("recalculates after Manual Resolution completes", async () => {
    const f = await fixture();
    const manual = await awaitResolution(f);
    const date = shift(f.laboratory.date, -7);
    await resolveClinicClosureManualCase(manual.id, { action: "ASSIGN_REPLACEMENT",
      expectedOptimisticToken: manual.token, laboratoryDate: date, preservePhysicalExam: true,
      reason: "OJT-XRAY authorized replacement" }, admin);
    const lab = (await pool.query<Appointment>(`SELECT id::text,schedule_type AS "scheduleType",
      appointment_date::text AS date,status FROM appointments WHERE student_number=$1
      AND schedule_type='LABORATORY' AND is_published=TRUE AND status='PENDING'`, [f.studentNumber])).rows[0];
    const resolved = (await notices(f))[0];
    expect(resolved.notificationType).toBe("SCHEDULE_MANUAL_RESOLUTION_COMPLETED");
    expectDated(resolved, lab);
  });

  it("omits a cancelled Laboratory date", async () => {
    const f = await fixture();
    await updateAppointment(f.laboratory.id, { status: "CANCELLED" }, admin);
    const cancelled = (await notices(f))[0];
    expect(cancelled.notificationType).toBe("SCHEDULE_CANCELLED");
    expect(cancelled.metadata).not.toHaveProperty("externalXraySchedule");
    expect(cancelled.message).not.toContain("X-ray schedule");
  });

  it("catches up only the current X-ray state on first verification", async () => {
    const f = await fixture();
    const date = shift(f.laboratory.date, -7);
    const replacement = await updateAppointment(f.laboratory.id, { appointmentDate: date }, admin);
    await verify(f);
    await transaction((client) => queueFirstVerificationCurrentStateCatchUp(client, f.studentNumber));
    const caughtUp = (await notices(f)).filter((notice) => notice.notificationType === "SCHEDULE_CURRENT_STATE");
    expect(caughtUp).toHaveLength(1);
    const detail = expectDated(caughtUp[0], { ...f.laboratory, id: replacement!.id, date });
    const rows = (await pool.query<{ text_body: string }>(`SELECT text_body FROM email_outbox
      WHERE student_number=$1 AND message_kind='SCHEDULE'`, [f.studentNumber])).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].text_body).toContain(`X-ray schedule: ${detail.xrayDate} at Iloilo Mission Hospital`);
    expect(rows[0].text_body).toContain(`appointment on ${date}.`);
    const sink = await startLoopbackSmtpSink({ port: 0 });
    try {
      vi.stubEnv("SMTP_HOST", sink.host); vi.stubEnv("SMTP_PORT", String(sink.port));
      vi.stubEnv("SMTP_FROM", "clinic@notifications.test");
      await deliverEmailOutboxBatch();
      const mail = sink.messages.find((message) => message.raw.toString("utf8").includes("X-ray schedule:"));
      expect(mail?.raw.toString("utf8")).toContain(`X-ray schedule: ${detail.xrayDate} at Iloilo Mission Hospital`);
    } finally { await sink.close(); }
  });

  it("rolls notification work back with its scheduling transaction", async () => {
    const f = await fixture();
    await verify(f);
    const before = await clinicalSnapshot(f);
    const previousNotices = await notices(f);
    const previousEmails = (await pool.query("SELECT id FROM email_outbox WHERE student_number=$1", [f.studentNumber])).rows;
    await expect(transaction(async (client) => {
      const context = await getAppointmentMutationContext(f.laboratory.id, client);
      await rescheduleAppointmentWithClient(client, context!, shift(f.laboratory.date, -7), null, admin.userId);
      const written = await queueAuthoritativeScheduleNotification(client, f.studentNumber,
        (state) => buildAdministratorRescheduledNotification({ state, eventId: randomUUID(), reason: "Rollback proof" }));
      expect(written.id).not.toBeNull();
      throw new Error("OJT-XRAY rollback");
    })).rejects.toThrow("OJT-XRAY rollback");
    expect(await clinicalSnapshot(f)).toEqual(before);
    expect(await notices(f)).toEqual(previousNotices);
    expect((await pool.query("SELECT id FROM email_outbox WHERE student_number=$1", [f.studentNumber])).rows).toEqual(previousEmails);
  });

  it("keeps the portal readable when email enqueue fails", async () => {
    const f = await fixture();
    await verify(f);
    const eventId = randomUUID();
    const written = await transaction(async (client) => {
      await client.query(`ALTER TABLE email_outbox ADD CONSTRAINT ojt_xray_test_email_failure
        CHECK (student_number NOT LIKE '91-99%') NOT VALID`);
      const result = await queueAuthoritativeScheduleNotification(client, f.studentNumber,
        (state) => buildAdministratorRescheduledNotification({ state, eventId, reason: "Isolated enqueue proof" }));
      await client.query("ALTER TABLE email_outbox DROP CONSTRAINT ojt_xray_test_email_failure");
      return result;
    });
    expect(written.warnings).toEqual([{ channel: "EMAIL_OUTBOX" }]);
    expectDated((await notices(f)).find((notice) => notice.id === written.id)!, f.laboratory);
    expect((await pool.query("SELECT id FROM email_outbox WHERE event_key=$1",
      [`schedule:event:${eventId}:${f.studentNumber}`])).rows).toHaveLength(0);
  });

  it("keeps the X-ray portal notice readable during an SMTP outage and preserves outbox retry", async () => {
    const f = await fixture();
    await verify(f);
    const before = await notices(f);
    const message = (await claimEmailOutboxMessages(25)).find((row) => row.studentNumber === f.studentNumber && row.messageKind === "SCHEDULE")!;
    expect(message).toBeDefined();
    const outcome = await deliverClaimedEmail(message, {
      sendMail: async () => { throw new Error("Synthetic SMTP outage"); },
    }, new Date(), "clinic@notifications.test");
    expect(outcome.status).toBe("PENDING");
    expect((await pool.query("SELECT status,attempts FROM email_outbox WHERE id=$1", [message.id])).rows)
      .toEqual([{ status: "PENDING", attempts: 1 }]);
    expect(await notices(f)).toEqual(before);
    expectDated(before.find((notice) => notice.notificationType === "SCHEDULE_CURRENT_STATE")!, f.laboratory);
  });

  it.each([[4, "REGULAR"], [4, "TOUR"], [1, "REGULAR"]] as const)
    ("omits the OJT instruction for a published year %s %s cohort", async (year, category) => {
      const f = await fixture(year, category, year === 1 ? { importMode: "FIRST_YEAR_OVPSA",
        preferredMonth: null, firstYearLaboratoryDate: "2092-11-03" } : {});
      expect((await notices(f))[0].metadata).not.toHaveProperty("externalXraySchedule");
      expect((await notices(f))[0].message).not.toContain("X-ray schedule");
    });

  it("retains the exact past hospital date after a late authorized replacement", async () => {
    // Keep this proof in our own academic year instead of creating/deleting another suite's current-year fixture.
    const today = "2092-10-30";
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(`${today}T12:00:00Z`));
    const f = await fixture();
    let destination = shift(today, 1);
    while ([0, 6].includes(new Date(`${destination}T00:00:00Z`).getUTCDay())) destination = shift(destination, 1);
    const replacement = await updateAppointment(f.laboratory.id, { appointmentDate: destination }, admin);
    expect(shift(destination, -7) < today).toBe(true);
    expectDated((await notices(f))[0], { ...f.laboratory, id: replacement!.id, date: destination });
  });
});
