// @vitest-environment node
import { afterAll, describe, expect, it } from "vitest";
import { pool } from "@/server/db/pool";
import { authenticate } from "./auth.service";

afterAll(async () => {
  await pool.end();
});

describe("authenticate", () => {
  it("accepts the seeded admin credentials", async () => {
    await expect(authenticate("admin@medclinic.local", "Admin123!")).resolves.toMatchObject({
      role: "ADMIN",
      email: "admin@medclinic.local",
    });
  });

  it("round-trips the seeded global coordinator credentials", async () => {
    await expect(authenticate("coordinator@medclinic.local", "Coordinator123!")).resolves.toMatchObject({
      fullName: "Schedule Coordinator",
      role: "COORDINATOR",
      email: "coordinator@medclinic.local",
      clinicId: null,
      clinicCode: null,
    });
  });

  it("rejects an incorrect password without exposing account details", async () => {
    await expect(authenticate("admin@medclinic.local", "wrong-password")).rejects.toMatchObject({
      code: "INVALID_CREDENTIALS",
      status: 401,
    });
  });
});
