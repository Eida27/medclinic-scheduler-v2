import { describe, expect, it } from "vitest";
import {
  APPOINTMENT_SUMMARY_SORTS,
  parseAppointmentSummarySort,
} from "./appointment-summary";

describe("parseAppointmentSummarySort", () => {
  it.each(APPOINTMENT_SUMMARY_SORTS)("accepts the supported sort %s", (sort) => {
    expect(parseAppointmentSummarySort(sort)).toBe(sort);
  });

  it.each([undefined, "", "soonest", "UPCOMING_ASC", "name"])(
    "falls back to upcoming_asc for %s",
    (sort) => {
      expect(parseAppointmentSummarySort(sort)).toBe("upcoming_asc");
    },
  );
});
