import { describe, expect, it } from "vitest";
import {
  APPOINTMENT_LIST_SORTS,
  parseAppointmentListSort,
} from "./appointment-list-sort";

describe("parseAppointmentListSort", () => {
  it.each(APPOINTMENT_LIST_SORTS)("accepts the supported sort %s", (sort) => {
    expect(parseAppointmentListSort(sort)).toBe(sort);
  });

  it.each([undefined, "", "upcoming_asc", "SURNAME_ASC", "date"])(
    "falls back to soonest for %s",
    (sort) => {
      expect(parseAppointmentListSort(sort)).toBe("soonest");
    },
  );
});
