import { describe, expect, it } from "vitest";
import { occupancyTone } from "./calendar-occupancy.service";

describe("calendar occupancy tone", () => {
  const empty = { laboratory: { used: 0, maximum: 10 }, physicalExam: { used: 0, maximum: 10 },
    appointmentTotal: 0, heldCapacity: 0 };
  it("keeps zero bookings colorless and distinguishes external-only bookings", () => {
    expect(occupancyTone(empty)).toBe("NONE");
    expect(occupancyTone({ ...empty, appointmentTotal: 2 })).toBe("GREEN");
  });
  it("marks either full service red, including overcapacity", () => {
    expect(occupancyTone({ ...empty, laboratory: { used: 10, maximum: 10 } })).toBe("RED");
    expect(occupancyTone({ ...empty, physicalExam: { used: 12, maximum: 10 } })).toBe("RED");
  });
  it("surfaces unconfigured capacity before green, while a known full service wins", () => {
    expect(occupancyTone({ ...empty, appointmentTotal: 1, physicalExam: { used: 0, maximum: null } })).toBe("NEUTRAL");
    expect(occupancyTone({ ...empty, laboratory: { used: 10, maximum: 10 }, physicalExam: { used: 0, maximum: null } })).toBe("RED");
  });
});
