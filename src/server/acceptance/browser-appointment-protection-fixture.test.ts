import { describe, expect, it } from "vitest";
import {
  APPOINTMENT_PROTECTION_FIXTURE,
  assertAppointmentProtectionStorageTarget,
  assertMatchingAppointmentProtectionDatabaseIdentity,
  assertSafeAppointmentProtectionAcceptanceDatabase,
  assertZeroAppointmentProtectionResidue,
  normalizeAppointmentProtectionDatabaseIdentity,
} from "../../../scripts/browser-appointment-protection-fixture";

describe("appointment protection Browser acceptance fixture", () => {
  it("normalizes a credential-free loopback database identity", () => {
    expect(normalizeAppointmentProtectionDatabaseIdentity(
      "postgresql://fixture:secret@127.0.0.1:5433/appointment_protection?sslmode=disable",
    )).toEqual({ scheme: "postgresql", host: "127.0.0.1", port: "5433", database: "appointment_protection" });
  });

  it("requires a loopback PostgreSQL database and explicit exclusive opt-in", () => {
    expect(() => assertSafeAppointmentProtectionAcceptanceDatabase(
      "postgresql://fixture:secret@localhost/appointment_protection", "1",
    )).not.toThrow();
    expect(() => assertSafeAppointmentProtectionAcceptanceDatabase(
      "postgresql://fixture:secret@db.example.test/appointment_protection", "1",
    )).toThrow(/loopback/i);
    expect(() => assertSafeAppointmentProtectionAcceptanceDatabase(
      "postgresql://fixture:secret@localhost/appointment_protection", undefined,
    )).toThrow("APPOINTMENT_PROTECTION_ACCEPTANCE_EXCLUSIVE_DATABASE=1");
  });

  it("rejects a database identity change after prepare", () => {
    const persisted = normalizeAppointmentProtectionDatabaseIdentity(
      "postgresql://fixture:secret@localhost:5432/appointment_protection",
    );
    expect(() => assertMatchingAppointmentProtectionDatabaseIdentity(
      normalizeAppointmentProtectionDatabaseIdentity(
        "postgresql://fixture:secret@localhost:5432/different_database",
      ),
      persisted,
    )).toThrow(/does not match/i);
  });

  it("contains private-file cleanup within the configured storage root", () => {
    expect(assertAppointmentProtectionStorageTarget(
      "C:\\fixture\\private-results", "student-results/submission/file.pdf",
    )).toBe("C:\\fixture\\private-results\\student-results\\submission\\file.pdf");
    expect(() => assertAppointmentProtectionStorageTarget(
      "C:\\fixture\\private-results", "../outside.pdf",
    )).toThrow(/storage key/i);
    expect(() => assertAppointmentProtectionStorageTarget(
      "C:\\fixture\\private-results", "C:\\outside.pdf",
    )).toThrow(/storage key/i);
  });

  it("uses disjoint exact owned identifiers", () => {
    expect(new Set(APPOINTMENT_PROTECTION_FIXTURE.studentNumbers).size).toBe(2);
    expect(new Set(APPOINTMENT_PROTECTION_FIXTURE.appointmentIds).size).toBe(4);
    expect(new Set(APPOINTMENT_PROTECTION_FIXTURE.schedulePairIds).size).toBe(2);
  });

  it("requires zero database, storage, and state residue", () => {
    const zero = {
      students: 0, appointments: 0, submissions: 0, files: 0, manualCases: 0,
      rescheduleEvents: 0, closures: 0, notifications: 0, outbox: 0,
      auditLogs: 0, storageFiles: 0, stateFiles: 0,
    };
    expect(assertZeroAppointmentProtectionResidue(zero)).toBe(zero);
    expect(() => assertZeroAppointmentProtectionResidue({ ...zero, files: 1 }))
      .toThrow(/residue remains/i);
  });
});
