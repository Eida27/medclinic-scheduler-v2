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

  it("rejects an incorrect password without exposing account details", async () => {
    await expect(authenticate("admin@medclinic.local", "wrong-password")).rejects.toMatchObject({
      code: "INVALID_CREDENTIALS",
      status: 401,
    });
  });
});
