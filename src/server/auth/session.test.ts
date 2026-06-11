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

  it("rejects a tampered token", async () => {
    const token = await createSessionToken({
      userId: "user-1",
      email: "staff@medclinic.local",
      fullName: "Clinic Staff",
      role: "CLINIC_STAFF",
    });

    await expect(verifySessionToken(`${token.slice(0, -1)}x`)).rejects.toThrow();
  });
});
