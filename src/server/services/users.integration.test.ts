// @vitest-environment node
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { pool } from "@/server/db/pool";
import { createUser, updateUser } from "./users.service";

const adminId = "00000000-0000-4000-8000-000000000001";
let createdUserId: string | undefined;

afterEach(async () => {
  if (!createdUserId) return;
  await pool.query("DELETE FROM audit_logs WHERE entity_type='user' AND entity_id=$1", [createdUserId]);
  await pool.query("DELETE FROM users WHERE id=$1", [createdUserId]);
  createdUserId = undefined;
});

afterAll(async () => {
  await pool.end();
});

describe("coordinator user management", () => {
  it("creates and updates a global coordinator account", async () => {
    const created = await createUser({
      fullName: "Temporary Coordinator",
      email: "temporary.coordinator@example.com",
      password: "Secure123!",
      role: "COORDINATOR",
      clinicCode: "",
    }, adminId);
    createdUserId = created?.id;

    expect(created).toMatchObject({
      fullName: "Temporary Coordinator",
      email: "temporary.coordinator@example.com",
      role: "COORDINATOR",
      clinicId: null,
      clinicCode: null,
    });

    const updated = await updateUser({
      id: createdUserId,
      fullName: "Updated Coordinator",
      email: "updated.coordinator@example.com",
      password: "",
      role: "COORDINATOR",
      clinicCode: null,
      isActive: false,
    }, adminId);

    expect(updated).toMatchObject({
      fullName: "Updated Coordinator",
      email: "updated.coordinator@example.com",
      role: "COORDINATOR",
      clinicId: null,
      clinicCode: null,
      isActive: false,
    });
  });
});
