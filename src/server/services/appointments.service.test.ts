import { describe, expect, it } from "vitest";
import { assertStatusTransition } from "./appointments.service";

describe("appointment status transitions", () => {
  it.each([
    ["DRAFT", "PENDING"],
    ["PENDING", "COMPLETED"],
    ["PENDING", "NO_SHOW"],
    ["PENDING", "CANCELLED"],
  ] as const)("allows %s to become %s", (from, to) => {
    expect(() => assertStatusTransition(from, to)).not.toThrow();
  });

  it("rejects reopening a completed appointment", () => {
    expect(() => assertStatusTransition("COMPLETED", "PENDING")).toThrow();
  });
});
