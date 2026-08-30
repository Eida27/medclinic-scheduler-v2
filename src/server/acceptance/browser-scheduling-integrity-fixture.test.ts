import { describe, expect, it } from "vitest";
import {
  SCHEDULING_INTEGRITY_FIXTURE,
  assertMatchingSchedulingIntegrityDatabaseIdentity,
  assertRetiredRouteSentinelUnchanged,
  assertSafeSchedulingIntegrityAcceptanceDatabase,
  assertSafeSchedulingIntegrityStatus,
  assertSchedulingIntegrityPreparedCounts,
  assertSchedulingIntegrityStorageTarget,
  assertZeroSchedulingIntegrityResidue,
  normalizeSchedulingIntegrityDatabaseIdentity,
} from "../../../scripts/browser-scheduling-integrity-fixture";

describe("scheduling integrity Browser acceptance fixture", () => {
  it("normalizes a credential-free loopback database identity", () => {
    expect(normalizeSchedulingIntegrityDatabaseIdentity(
      "postgresql://fixture:secret@127.0.0.1:5433/scheduling_integrity?sslmode=disable",
    )).toEqual({
      scheme: "postgresql",
      host: "127.0.0.1",
      port: "5433",
      database: "scheduling_integrity",
    });
  });

  it("requires loopback PostgreSQL and the explicit exclusive-database flag", () => {
    expect(() => assertSafeSchedulingIntegrityAcceptanceDatabase(
      "postgresql://fixture:secret@localhost/scheduling_integrity",
      "1",
    )).not.toThrow();
    expect(() => assertSafeSchedulingIntegrityAcceptanceDatabase(
      "postgresql://fixture:secret@db.example.test/scheduling_integrity",
      "1",
    )).toThrow(/loopback/i);
    expect(() => assertSafeSchedulingIntegrityAcceptanceDatabase(
      "postgresql://fixture:secret@localhost/scheduling_integrity",
      undefined,
    )).toThrow("SCHEDULING_INTEGRITY_ACCEPTANCE_EXCLUSIVE_DATABASE=1");
  });

  it("rejects changing database identity after setup", () => {
    const persisted = normalizeSchedulingIntegrityDatabaseIdentity(
      "postgresql://fixture:secret@localhost:5432/scheduling_integrity",
    );
    expect(() => assertMatchingSchedulingIntegrityDatabaseIdentity(
      normalizeSchedulingIntegrityDatabaseIdentity(
        "postgresql://fixture:secret@localhost:5432/different_database",
      ),
      persisted,
    )).toThrow(/does not match/i);
  });

  it("defines disjoint scenario identities and strictly ordered pair dates", () => {
    const fixture = SCHEDULING_INTEGRITY_FIXTURE;
    expect(new Set(Object.values(fixture.students).map((student) => student.studentNumber)).size)
      .toBe(Object.keys(fixture.students).length);
    expect(new Set(Object.values(fixture.appointmentIds)).size)
      .toBe(Object.keys(fixture.appointmentIds).length);
    expect(fixture.dates.lifecycleLaboratory < fixture.dates.lifecyclePhysicalExam).toBe(true);
    expect(fixture.dates.manualLaboratory < fixture.dates.manualPhysicalExam).toBe(true);
    expect(fixture.dates.displacementLaboratory < fixture.dates.displacementPhysicalExam).toBe(true);
    expect(fixture.dates.displacementReplacementLaboratory
      < fixture.dates.displacementReplacementPhysicalExam).toBe(true);
    expect(new Set([
      fixture.dates.blockedClosure,
      fixture.dates.exclusiveReservation,
      fixture.dates.capacityFull,
      fixture.dates.manualValidReplacement,
    ]).size).toBe(4);
    expect(fixture.routes.studentPortal).toBe("/student");
  });

  it("lists representative removed scheduling routes for 404 acceptance", () => {
    const requests = new Map(
      SCHEDULING_INTEGRITY_FIXTURE.retiredRequests.map((request) => [
        `${request.method} ${request.path}`,
        request,
      ]),
    );
    const requestBody = (key: string) => {
      const request = requests.get(key);
      return request && "body" in request ? request.body : undefined;
    };
    expect(requestBody("POST /api/coordinator-schedules")).toEqual({});
    expect(requestBody("POST /api/coordinator-schedules/validate"))
      .toEqual({});
    expect(requestBody(
      `PATCH /api/coordinator-schedules/${SCHEDULING_INTEGRITY_FIXTURE.ids.removedRouteTarget}`,
    )).toEqual({});
    expect(requestBody("POST /api/appointments/generate"))
      .toEqual({});
    expect(requestBody("POST /api/appointments/publish"))
      .toEqual({});
    expect(requests.has("GET /api/priority-groups")).toBe(true);
    expect(requests.has(
      `POST /api/schedule-imports/${SCHEDULING_INTEGRITY_FIXTURE.ids.removedRouteTarget}/publish`,
    )).toBe(true);
  });

  it("rejects any credential field in status output", () => {
    const safe = {
      mode: "status",
      fixture: {
        identities: {
          adminEmail: SCHEDULING_INTEGRITY_FIXTURE.admin.email,
          portalStudentNumber: SCHEDULING_INTEGRITY_FIXTURE.students.portal.studentNumber,
        },
      },
    };
    expect(assertSafeSchedulingIntegrityStatus(safe)).toBe(safe);
    expect(() => assertSafeSchedulingIntegrityStatus({
      ...safe,
      login: { password: "must-never-ship" },
    })).toThrow(/credential field/i);
    expect(() => assertSafeSchedulingIntegrityStatus({
      ...safe,
      student: { dateOfBirth: "2004-01-02" },
    })).toThrow(/credential field/i);
    expect(() => assertSafeSchedulingIntegrityStatus({
      ...safe,
      manualCase: { optimisticToken: "00000000-0000-4000-8000-000000000000" },
    })).toThrow(/credential field/i);
  });

  it("detects a retired-route sentinel mutation", () => {
    const baseline = {
      importGroups: 1,
      batches: 3,
      items: 3,
      appointments: 1,
      importGroupStates: ["import-baseline"],
      batchStates: ["batch-baseline"],
      itemStates: ["item-baseline"],
      appointmentStates: ["appointment-baseline"],
    };
    expect(assertRetiredRouteSentinelUnchanged(baseline, { ...baseline })).toEqual(baseline);
    expect(() => assertRetiredRouteSentinelUnchanged(baseline, {
      ...baseline,
      batches: 4,
      batchStates: [...baseline.batchStates, "dynamic-batch"],
    })).toThrow(/retired scheduling sentinel changed/i);
  });

  it("requires the complete deterministic prepared state", () => {
    const expected = {
      users: 2,
      coreStudents: 4,
      capacityStudents: 150,
      pairAppointments: 8,
      capacityAppointments: 150,
      importGroups: 1,
      scheduleBatches: 0,
      scheduleItems: 0,
      manualCases: 1,
      rescheduleEvents: 1,
      closureGroups: 1,
      unavailableDates: 1,
      ovpsaBatches: 1,
      ovpsaRevisions: 1,
      reservations: 1,
    };
    expect(assertSchedulingIntegrityPreparedCounts({ ...expected })).toEqual(expected);
    expect(() => assertSchedulingIntegrityPreparedCounts({
      ...expected,
      pairAppointments: 7,
    })).toThrow(/prepared state is incomplete/i);
  });

  it("contains storage cleanup within the configured private-results root", () => {
    expect(assertSchedulingIntegrityStorageTarget(
      "C:\\fixture\\private-results",
      "student-results/submission/file.pdf",
    )).toBe("C:\\fixture\\private-results\\student-results\\submission\\file.pdf");
    expect(() => assertSchedulingIntegrityStorageTarget(
      "C:\\fixture\\private-results",
      "../outside.pdf",
    )).toThrow(/storage key/i);
    expect(() => assertSchedulingIntegrityStorageTarget(
      "C:\\fixture\\private-results",
      "C:\\outside.pdf",
    )).toThrow(/storage key/i);
  });

  it("requires zero residue across every owned database, storage, and state category", () => {
    const zero = {
      users: 0,
      students: 0,
      colleges: 0,
      programs: 0,
      appointments: 0,
      appointmentStatusLogs: 0,
      laboratoryResults: 0,
      examResults: 0,
      resultSubmissions: 0,
      resultFiles: 0,
      storageCleanupIntents: 0,
      importGroups: 0,
      scheduleBatches: 0,
      scheduleItems: 0,
      manualCases: 0,
      rescheduleEvents: 0,
      closureGroups: 0,
      unavailableDates: 0,
      ovpsaBatches: 0,
      ovpsaRevisions: 0,
      reservations: 0,
      calendarRequests: 0,
      studentLoginAttempts: 0,
      studentEmailVerifications: 0,
      staffEmailVerifications: 0,
      staffPasswordResets: 0,
      notifications: 0,
      outbox: 0,
      auditLogs: 0,
      storageFiles: 0,
      stateFiles: 0,
    };
    expect(assertZeroSchedulingIntegrityResidue(zero)).toBe(zero);
    expect(() => assertZeroSchedulingIntegrityResidue({ ...zero, auditLogs: 1 }))
      .toThrow(/residue remains/i);
  });
});
