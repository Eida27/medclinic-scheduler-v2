import { describe, expect, it } from "vitest";
import {
  buildAdministratorRescheduledNotification,
  buildAwaitingResolutionNotification,
  buildCancellationNotification,
  buildClosureRescheduledNotification,
  buildCurrentStateNotification,
  buildInitialPublicationNotification,
  buildManualResolutionCompletedNotification,
  buildPriorityDisplacementNotification,
  buildRestorationNotification,
  fingerprintScheduleState,
  type AuthoritativeScheduleState,
} from "./schedule-notifications";
import { SCHEDULE_NOTICE } from "@/lib/schedule-notice";

const currentState: AuthoritativeScheduleState = {
  studentNumber: "24-0001",
  studentName: "Santos, Ana M.",
  laboratory: {
    id: "lab-1",
    scheduleType: "LABORATORY",
    status: "PENDING",
    date: "2026-09-10",
    affectedDate: null,
    location: "CPU Medical Center",
  },
  physicalExam: {
    id: "pe-1",
    scheduleType: "PHYSICAL_EXAM",
    status: "PENDING",
    date: "2026-09-17",
    affectedDate: null,
    location: "CPU Clinic",
  },
  openManualResolutionIds: [],
};

describe("authoritative schedule fingerprints", () => {
  it("uses a stable literal SHA-256 value and ignores display object insertion order", () => {
    expect(fingerprintScheduleState(currentState)).toBe(
      "fd13b94a7f23689f836e5c616d7346e74be98e22b4b87f1b88bc0fbbe7aa3cd4",
    );
    expect(fingerprintScheduleState({
      openManualResolutionIds: [],
      physicalExam: currentState.physicalExam,
      laboratory: currentState.laboratory,
      studentName: currentState.studentName,
      studentNumber: currentState.studentNumber,
    })).toBe("fd13b94a7f23689f836e5c616d7346e74be98e22b4b87f1b88bc0fbbe7aa3cd4");
  });

  it("changes for affected-state and open Manual Resolution identity changes", () => {
    const awaiting = {
      ...currentState,
      laboratory: {
        ...currentState.laboratory!,
        status: "AWAITING_RESCHEDULE" as const,
        date: null,
        affectedDate: "2026-09-10",
      },
      openManualResolutionIds: ["manual-case-1"],
    };
    expect(fingerprintScheduleState(awaiting)).toBe(
      "94c1d33fb642b00707a6054c346ceae171a12cb56e76f524b61599d6ca8b0f99",
    );
    expect(fingerprintScheduleState({
      ...awaiting,
      openManualResolutionIds: ["manual-case-2"],
    })).not.toBe(fingerprintScheduleState(awaiting));

    const everyOpenCase = {
      ...currentState,
      openManualResolutionIds: ["manual-case-2", "manual-case-1"],
    };
    expect(fingerprintScheduleState(everyOpenCase)).toBe(
      "dda730cb20989fd87b1a3d3ad3c389d867fb3b2bcf8648b44b364d07cb10bfee",
    );
    expect(fingerprintScheduleState({
      ...everyOpenCase,
      openManualResolutionIds: ["manual-case-1", "manual-case-2"],
    })).toBe(fingerprintScheduleState(everyOpenCase));
    expect(fingerprintScheduleState({
      ...everyOpenCase,
      openManualResolutionIds: ["manual-case-1"],
    })).not.toBe(fingerprintScheduleState(everyOpenCase));
  });
});

describe("typed schedule notification builders", () => {
  it("builds initial and current-state messages with exact deterministic key families", () => {
    const initial = buildInitialPublicationNotification({
      state: currentState,
      sourceType: "SCHEDULE_IMPORT",
      sourceId: "import-9",
    });
    const current = buildCurrentStateNotification(currentState);

    expect(initial).toMatchObject({
      eventKey: "schedule:initial:SCHEDULE_IMPORT:import-9:24-0001",
      notificationType: "SCHEDULE_INITIAL_PUBLICATION",
      emailSubject: "Your MedClinic schedule is ready",
      messageKind: "SCHEDULE",
      sourceType: "SCHEDULE_IMPORT",
      sourceId: "import-9",
      scheduleFingerprint: "fd13b94a7f23689f836e5c616d7346e74be98e22b4b87f1b88bc0fbbe7aa3cd4",
    });
    expect(current).toMatchObject({
      eventKey: "schedule:current:24-0001:fd13b94a7f23689f836e5c616d7346e74be98e22b4b87f1b88bc0fbbe7aa3cd4",
      notificationType: "SCHEDULE_CURRENT_STATE",
      emailSubject: "Your current MedClinic schedule",
      messageKind: "SCHEDULE",
      sourceType: "CURRENT_SCHEDULE_STATE",
      sourceId: "fd13b94a7f23689f836e5c616d7346e74be98e22b4b87f1b88bc0fbbe7aa3cd4",
    });
    expect(initial.emailTextBody).toContain("Laboratory: 2026-09-10 at CPU Medical Center (Pending).");
    expect(initial.emailTextBody).toContain("Physical Examination: 2026-09-17 at CPU Clinic (Pending).");
    expect(initial.emailTextBody).toContain(SCHEDULE_NOTICE);
    expect(current.emailTextBody).toContain(SCHEDULE_NOTICE);
  });

  it.each([
    [
      "priority displacement",
      buildPriorityDisplacementNotification,
      "SCHEDULE_PRIORITY_DISPLACEMENT",
      "Your MedClinic schedule changed due to priority scheduling",
      "APPOINTMENT_RESCHEDULE_EVENT",
    ],
    [
      "closure rescheduling",
      buildClosureRescheduledNotification,
      "SCHEDULE_CLOSURE_RESCHEDULED",
      "Your MedClinic schedule changed due to a clinic closure",
      "APPOINTMENT_RESCHEDULE_EVENT",
    ],
    [
      "Manual Resolution completion",
      buildManualResolutionCompletedNotification,
      "SCHEDULE_MANUAL_RESOLUTION_COMPLETED",
      "Your MedClinic replacement schedule is ready",
      "CLINIC_CLOSURE_MANUAL_CASE",
    ],
    [
      "administrator rescheduling",
      buildAdministratorRescheduledNotification,
      "SCHEDULE_ADMINISTRATOR_RESCHEDULED",
      "Your MedClinic schedule was updated by an administrator",
      "APPOINTMENT_RESCHEDULE_EVENT",
    ],
    [
      "restoration",
      buildRestorationNotification,
      "SCHEDULE_RESTORED",
      "Your earlier MedClinic schedule was restored",
      "APPOINTMENT_RESCHEDULE_EVENT",
    ],
    [
      "cancellation",
      buildCancellationNotification,
      "SCHEDULE_CANCELLED",
      "Your MedClinic schedule was cancelled",
      "OVPSA_FIRST_YEAR_BATCH",
    ],
  ] as const)("builds a typed %s event message", (
    _label,
    builder,
    notificationType,
    emailSubject,
    sourceType,
  ) => {
    const notification = builder({
      state: currentState,
      eventId: "event-77",
      reason: "Authorized scheduling change",
      previous: {
        laboratory: { date: "2026-09-03", location: "CPU Medical Center" },
        physicalExam: { date: "2026-09-10", location: "CPU Clinic" },
      },
    });
    expect(notification).toMatchObject({
      eventKey: "schedule:event:event-77:24-0001",
      notificationType,
      emailSubject,
      messageKind: "SCHEDULE",
      sourceType,
      sourceId: "event-77",
      scheduleFingerprint: "fd13b94a7f23689f836e5c616d7346e74be98e22b4b87f1b88bc0fbbe7aa3cd4",
    });
    expect(notification.emailTextBody).toContain("Previous Laboratory: 2026-09-03 at CPU Medical Center.");
    expect(notification.emailTextBody).toContain("Authorized scheduling change");
    expect(notification.emailTextBody).toContain(SCHEDULE_NOTICE);
  });

  it("communicates awaiting resolution without presenting the affected date as active", () => {
    const notification = buildAwaitingResolutionNotification({
      state: {
        ...currentState,
        laboratory: {
          ...currentState.laboratory!,
          status: "AWAITING_RESCHEDULE",
          date: null,
          affectedDate: "2026-09-10",
        },
        openManualResolutionIds: ["manual-case-1"],
      },
      eventId: "event-awaiting",
      reason: "Emergency closure",
    });
    expect(notification).toMatchObject({
      eventKey: "schedule:event:event-awaiting:24-0001",
      notificationType: "SCHEDULE_AWAITING_RESOLUTION",
      emailSubject: "Your MedClinic schedule needs administrator resolution",
      sourceType: "CLINIC_CLOSURE_MANUAL_CASE",
    });
    expect(notification.emailTextBody).toContain(
      "Laboratory: the prior 2026-09-10 appointment at CPU Medical Center was affected; a replacement date is pending administrator resolution.",
    );
    expect(notification.emailTextBody).not.toContain("Laboratory: 2026-09-10 at");
    expect(notification.emailTextBody).not.toMatch(/replacement[^.]*2026-09-1[1-9]/i);
  });

  it("excludes prohibited student and medical data from every email body", () => {
    const secretState = {
      ...currentState,
      dateOfBirth: "2004-02-03",
      laboratoryResult: "reactive",
      physicalExamResult: "medical detail",
      documentName: "private-result.pdf",
    } as AuthoritativeScheduleState & Record<string, unknown>;
    const serialized = [
      buildInitialPublicationNotification({ state: secretState, sourceType: "IMPORT", sourceId: "1" }),
      buildCurrentStateNotification(secretState),
      buildPriorityDisplacementNotification({ state: secretState, eventId: "2", reason: "Tour priority" }),
      buildClosureRescheduledNotification({ state: secretState, eventId: "3", reason: "Closure" }),
      buildAwaitingResolutionNotification({ state: secretState, eventId: "4", reason: "Emergency" }),
      buildManualResolutionCompletedNotification({ state: secretState, eventId: "5", reason: "Resolved" }),
      buildAdministratorRescheduledNotification({ state: secretState, eventId: "6", reason: "Authorized" }),
      buildRestorationNotification({ state: secretState, eventId: "7", reason: "Restored" }),
      buildCancellationNotification({ state: secretState, eventId: "8", reason: "Cancelled" }),
    ].map((notification) => notification.emailTextBody).join("\n");
    expect(serialized).not.toContain("2004-02-03");
    expect(serialized).not.toContain("reactive");
    expect(serialized).not.toContain("medical detail");
    expect(serialized).not.toContain("private-result.pdf");
  });
});
