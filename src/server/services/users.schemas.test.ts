import { describe, expect, it } from "vitest";
import { userSchema } from "./users.service";

describe("userSchema", () => {
  it.each(["KABALAKA_CLINIC", "CPU_CLINIC"])("accepts clinic staff assigned to %s", (clinicCode) => {
    expect(userSchema.parse({
      fullName: "Clinic Staff",
      email: "staff@medclinic.local",
      role: "CLINIC_STAFF",
      clinicCode,
    })).toMatchObject({
      role: "CLINIC_STAFF",
      clinicCode,
    });
  });

  it.each(["", null])("rejects clinic staff without a clinic assignment", (clinicCode) => {
    expect(() => userSchema.parse({
      fullName: "Clinic Staff",
      email: "staff@medclinic.local",
      role: "CLINIC_STAFF",
      clinicCode,
    })).toThrow("Clinic staff must be assigned to a clinic.");
  });

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

  it.each([
    ["COORDINATOR", ""],
    ["ADMIN", null],
  ])("accepts %s with a global clinic assignment", (role, clinicCode) => {
    expect(userSchema.parse({
      fullName: "Global User",
      email: "global@medclinic.local",
      role,
      clinicCode,
    })).toMatchObject({
      role,
      clinicCode: null,
    });
  });
});
