import { describe, expect, it } from "vitest";
import { assertManualAppointmentDestination } from "./manual-appointment-destination";

const baseInput = {
  appointment: {
    id: "11111111-1111-4111-8111-111111111111",
    scheduleType: "LABORATORY" as const,
  },
  pair: {
    laboratory: {
      id: "11111111-1111-4111-8111-111111111111",
      scheduleType: "LABORATORY" as const,
      appointmentDate: "2094-09-13",
      status: "PENDING" as const,
    },
    physicalExam: {
      id: "22222222-2222-4222-8222-222222222222",
      scheduleType: "PHYSICAL_EXAM" as const,
      appointmentDate: "2094-09-17",
      status: "PENDING" as const,
    },
  },
  destinationDate: "2094-09-14",
  manilaToday: "2094-09-08",
  cycleStartDate: "2094-08-01",
  cycleClosingDate: "2095-07-31",
  isBlocked: false,
  usedCapacity: 4,
  maxDailyCapacity: 5,
};

describe("manual appointment destination policy", () => {
  it.each(["2094-09-07", "2094-09-08"])(
    "rejects a destination that is not strictly after Manila today (%s)",
    (destinationDate) => {
      expect(() => assertManualAppointmentDestination({
        ...baseInput,
        destinationDate,
      })).toThrow(expect.objectContaining({
        code: "APPOINTMENT_DATE_IN_PAST",
        status: 422,
      }));
    },
  );

  it("rejects a weekend destination", () => {
    expect(() => assertManualAppointmentDestination({
      ...baseInput,
      destinationDate: "2094-09-12",
    })).toThrow(expect.objectContaining({
      code: "APPOINTMENT_DATE_BLOCKED",
      status: 422,
    }));
  });

  it("rejects an unavailable destination for the selected service", () => {
    expect(() => assertManualAppointmentDestination({
      ...baseInput,
      isBlocked: true,
    })).toThrow(expect.objectContaining({
      code: "APPOINTMENT_DATE_BLOCKED",
      status: 409,
    }));
  });

  it.each(["2094-07-30", "2095-08-01"])(
    "rejects a destination outside the appointment scheduling cycle (%s)",
    (destinationDate) => {
      expect(() => assertManualAppointmentDestination({
        ...baseInput,
        manilaToday: "2094-01-01",
        destinationDate,
      })).toThrow(expect.objectContaining({
        code: "OUTSIDE_SCHEDULING_CYCLE",
        status: 422,
      }));
    },
  );

  it.each(["2094-09-17", "2094-09-20"])(
    "rejects a Laboratory destination that is not before Physical Examination (%s)",
    (destinationDate) => {
      expect(() => assertManualAppointmentDestination({
        ...baseInput,
        destinationDate,
      })).toThrow(expect.objectContaining({
        code: "PAIR_ORDER_VIOLATION",
        status: 409,
      }));
    },
  );

  it.each(["2094-09-13", "2094-09-10"])(
    "rejects a Physical Examination destination that is not after Laboratory (%s)",
    (destinationDate) => {
      expect(() => assertManualAppointmentDestination({
        ...baseInput,
        appointment: {
          id: "22222222-2222-4222-8222-222222222222",
          scheduleType: "PHYSICAL_EXAM" as const,
        },
        destinationDate,
      })).toThrow(expect.objectContaining({
        code: "PAIR_ORDER_VIOLATION",
        status: 409,
      }));
    },
  );

  it("rejects a destination whose configured maximum is already consumed", () => {
    expect(() => assertManualAppointmentDestination({
      ...baseInput,
      usedCapacity: 5,
    })).toThrow(expect.objectContaining({
      code: "DAILY_CAPACITY_EXCEEDED",
      status: 409,
    }));
  });

  it("accepts a future weekday inside the cycle, service availability, pair order, and capacity", () => {
    expect(() => assertManualAppointmentDestination(baseInput)).not.toThrow();
  });
});
