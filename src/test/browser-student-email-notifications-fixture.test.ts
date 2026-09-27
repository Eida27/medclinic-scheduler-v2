import { describe, expect, it } from "vitest";
import {
  assertSafeStudentEmailNotificationsAcceptanceDatabase,
  assertZeroStudentEmailNotificationsResidue,
  normalizeStudentEmailNotificationsDatabaseIdentity,
} from "../../scripts/browser-student-email-notifications-fixture";
const EXCLUSIVE_FLAG = "STUDENT_EMAIL_NOTIFICATIONS_ACCEPTANCE_EXCLUSIVE_DATABASE";
describe("student email notifications Browser acceptance fixture guards", () => {
  it("rejects remote databases and requires explicit exclusive-database consent", () => {
    expect(() => assertSafeStudentEmailNotificationsAcceptanceDatabase(
      "postgresql://fixture:secret@db.example.com:5432/student_email_notifications",
      "1",
    )).toThrow(/loopback/i);
    expect(() => assertSafeStudentEmailNotificationsAcceptanceDatabase(
      "postgresql://fixture:secret@localhost:5432/student_email_notifications",
      undefined,
    )).toThrow(new RegExp(`${EXCLUSIVE_FLAG}=1`));
  });

  it("returns a credential-free identity and rejects destination overrides", () => {
    expect(normalizeStudentEmailNotificationsDatabaseIdentity(
      "postgresql://secret-user:secret-password@LOCALHOST:5433/student%5Femail?sslmode=disable",
    )).toEqual({
      scheme: "postgresql",
      host: "localhost",
      port: "5433",
      database: "student_email",
    });
    expect(() => assertSafeStudentEmailNotificationsAcceptanceDatabase(
      "postgresql://fixture:secret@localhost:5432/student_email?host=remote.example",
      "1",
    )).toThrow(/host or port query parameters/i);
    expect(() => assertSafeStudentEmailNotificationsAcceptanceDatabase(
      "postgresql://fixture:secret@localhost:5432/student_email?options=-c%20search_path%3Dprivate",
      "1",
    )).toThrow(/namespace-changing|options/i);
  });

  it("accepts only exhaustive zero cleanup residue", () => {
    const zero = {
      users: 0,
      colleges: 0,
      programs: 0,
      academicYears: 0,
      importGroups: 0,
      academicSnapshots: 0,
      students: 0,
      loginAttempts: 0,
      emailVerifications: 0,
      appointments: 0,
      closureGroups: 0,
      unavailableDates: 0,
      manualCases: 0,
      rescheduleEvents: 0,
      eventUnavailableDates: 0,
      notifications: 0,
      outbox: 0,
      audits: 0,
      triggers: 0,
      triggerFunctions: 0,
      appointmentStatusLogs: 0,
      resultSubmissions: 0,
      resultFiles: 0,
      laboratoryResults: 0,
      examResults: 0,
      storageCleanupIntents: 0,
      laboratoryChecklists: 0,
      laboratoryChecklistItems: 0,
      laboratoryChecklistLinks: 0,
      laboratoryChecklistEvents: 0,
      storageObjects: 0,
      stateFiles: 0,
    };
    expect(assertZeroStudentEmailNotificationsResidue(zero)).toBe(zero);
    expect(() => assertZeroStudentEmailNotificationsResidue({
      ...zero,
      eventUnavailableDates: 1,
    })).toThrow(/cleanup residue/i);
  });
});
