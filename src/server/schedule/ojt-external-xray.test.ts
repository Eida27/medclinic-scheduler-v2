import { afterEach, describe, expect, it, vi } from "vitest";
import { deriveOjtExternalXraySchedule, type OjtExternalXrayContext } from "./ojt-external-xray";

const ojt: OjtExternalXrayContext = {
  laboratoryAppointmentId: "lab-1",
  laboratoryDate: "2026-08-20",
  status: "PENDING",
  clinicCode: "KABALAKA_CLINIC",
  yearLevel: 4,
  schedulingCategory: "OJT",
  hasOvpsaProvenance: false,
};
const detail = {
  anchorLaboratoryAppointmentId: "lab-1",
  laboratoryDate: "2026-08-20",
  xrayDate: "2026-08-13",
  provider: "Iloilo Mission Hospital",
  offsetCalendarDays: 7,
};
const originalTimezone = process.env.TZ;
afterEach(() => {
  vi.useRealTimers();
  if (originalTimezone === undefined) delete process.env.TZ;
  else process.env.TZ = originalTimezone;
});

describe("OJT external X-ray schedule", () => {
  it("anchors the hospital instruction seven calendar days before KABALAKA", () => {
    expect(deriveOjtExternalXraySchedule(ojt)).toEqual(detail);
  });

  it.each([
    ["2026-09-03", "2026-08-27"],
    ["2027-01-04", "2026-12-28"],
    ["2028-03-01", "2028-02-23"],
    ["2026-08-01", "2026-07-25"],
    ["2026-08-16", "2026-08-09"],
  ])("subtracts across calendar boundaries without clamping %s", (laboratoryDate, xrayDate) => {
    expect(deriveOjtExternalXraySchedule({ ...ojt, laboratoryDate }))
      .toEqual({ ...detail, laboratoryDate, xrayDate });
  });

  it.each<Partial<OjtExternalXrayContext>>([
    { yearLevel: 1 }, { yearLevel: 2 }, { yearLevel: 3 }, { yearLevel: null },
    { schedulingCategory: "REGULAR" }, { schedulingCategory: "TOUR" },
    { schedulingCategory: null }, { clinicCode: "CPU_CLINIC" },
    { hasOvpsaProvenance: true },
    { status: "DRAFT" }, { status: "CANCELLED" }, { status: "RESCHEDULED" },
  ])("omits detail when saved eligibility or status excludes it: %j", (change) => {
    expect(deriveOjtExternalXraySchedule({ ...ojt, ...change })).toBeNull();
  });

  it.each([null, "2026-02-30", "2026-13-01", "2026-2-03", "bad", "2026-08-20T00:00:00Z", "2026-00-01", "2026-01-00"])
    ("leaves an eligible invalid or undated instruction pending: %s", (laboratoryDate) => {
      expect(deriveOjtExternalXraySchedule({ ...ojt, laboratoryDate }))
        .toEqual({ ...detail, laboratoryDate: null, xrayDate: null });
    });

  it("suppresses the old stored date while awaiting an authorized replacement", () => {
    expect(deriveOjtExternalXraySchedule({ ...ojt, status: "AWAITING_RESCHEDULE" }))
      .toEqual({ ...detail, laboratoryDate: null, xrayDate: null });
  });

  it.each(["COMPLETED", "NO_SHOW"] as const)("retains a planned date for %s", (status) => {
    expect(deriveOjtExternalXraySchedule({ ...ojt, status })).toEqual(detail);
  });

  it.each(["UTC", "Asia/Manila", "America/Los_Angeles"])("ignores host timezone and clock in %s", (timezone) => {
    process.env.TZ = timezone;
    vi.useFakeTimers();
    for (const clock of ["2026-08-01", "2026-08-13", "2026-10-12"]) {
      vi.setSystemTime(new Date(`${clock}T12:00:00Z`));
      expect(deriveOjtExternalXraySchedule(ojt)).toEqual(detail);
    }
  });
});
