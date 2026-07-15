// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createSessionToken, verifySessionToken } from "./session";

describe("session tokens", () => {
  it("round-trips the authenticated user identity and role", async () => {
    const token = await createSessionToken({
      userId: "00000000-0000-4000-8000-000000000001",
      email: "admin@medclinic.local",
      fullName: "System Admin",
      role: "ADMIN",
    });

    await expect(verifySessionToken(token)).resolves.toMatchObject({
      userId: "00000000-0000-4000-8000-000000000001",
      role: "ADMIN",
    });
  });

  it("round-trips a global coordinator identity", async () => {
    const token = await createSessionToken({
      userId: "00000000-0000-4000-8000-000000000003",
      email: "coordinator@medclinic.local",
      fullName: "Schedule Coordinator",
      role: "COORDINATOR",
      clinicId: null,
      clinicCode: null,
      clinicName: null,
    });

    await expect(verifySessionToken(token)).resolves.toMatchObject({
      userId: "00000000-0000-4000-8000-000000000003",
      role: "COORDINATOR",
      clinicId: null,
      clinicCode: null,
      clinicName: null,
    });
  });

  it("rejects a tampered token", async () => {
    const token = await createSessionToken({
      userId: "user-1",
      email: "staff@medclinic.local",
      fullName: "Clinic Staff",
      role: "CLINIC_STAFF",
    });

    const parts = token.split(".");
    parts[1] = `${parts[1].slice(0, 4)}x${parts[1].slice(5)}`;
    await expect(verifySessionToken(parts.join("."))).rejects.toThrow();
  });
});
