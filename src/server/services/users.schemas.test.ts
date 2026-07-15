import { describe, expect, it } from "vitest";
import { userSchema } from "./users.service";

describe("userSchema", () => {
  it("accepts a coordinator without a clinic assignment", () => {
    expect(userSchema.parse({
      fullName: "Schedule Coordinator",
      email: "coordinator@medclinic.local",
      role: "COORDINATOR",
      clinicCode: "",
    })).toMatchObject({
      role: "COORDINATOR",
      clinicCode: null,
    });
  });

  it("rejects a clinic assignment for a global coordinator", () => {
    expect(() => userSchema.parse({
      fullName: "Schedule Coordinator",
      email: "coordinator@medclinic.local",
      role: "COORDINATOR",
      clinicCode: "CPU_CLINIC",
    })).toThrow(/Coordinator accounts must be global/);
  });
});
