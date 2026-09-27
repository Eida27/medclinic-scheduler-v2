// @vitest-environment node
import sharp from "sharp";
import { afterAll, describe, expect, it } from "vitest";
import { pool, transaction } from "@/server/db/pool";
import { TEST_REFERENCE_IDS } from "@/test/integration-fixtures";
import type { SessionUser } from "@/types/roles";
import { listPhysicians, savePhysicianRevision } from "./physician.service";

const admin: SessionUser = {
  userId: TEST_REFERENCE_IDS.adminUser,
  fullName: "Test Admin",
  email: "admin@medclinic.local",
  role: "ADMIN",
};
const created: string[] = [];

afterAll(async () => {
  await transaction(async (client) => {
    await client.query("ALTER TABLE medical_certificate_physician_revisions DISABLE TRIGGER medical_certificate_physician_revisions_immutable");
    await client.query("DELETE FROM medical_certificate_physician_revisions WHERE physician_id=ANY($1::uuid[])", [created]);
    await client.query("DELETE FROM medical_certificate_physicians WHERE id=ANY($1::uuid[])", [created]);
    await client.query("ALTER TABLE medical_certificate_physician_revisions ENABLE TRIGGER medical_certificate_physician_revisions_immutable");
  });
  await pool.end();
});

describe("physician profile revisions", () => {
  it("creates immutable revisions and rejects stale edits", async () => {
    const signatureBytes = await sharp({ create: { width: 200, height: 80, channels: 4, background: "white" } }).png().toBuffer();
    const first = await savePhysicianRevision({
      profile: { displayName: "Dr. Test Physician", licenseNumber: "PRC 12345", specialty: "General Medicine", active: true },
      signatureBytes, signatureMediaType: "image/png",
    }, admin);
    created.push(first.id);
    expect(first.version).toBe(1);
    const second = await savePhysicianRevision({ physicianId: first.id, expectedVersion: 1,
      profile: { displayName: "Dr. Test Physician", licenseNumber: "PRC 54321", specialty: null, active: false },
    }, admin);
    expect(second.version).toBe(2);
    expect((await listPhysicians(admin)).some((row) => row.id === first.id)).toBe(false);
    expect((await listPhysicians(admin, true)).find((row) => row.id === first.id)?.licenseNumber).toBe("PRC 54321");
    await expect(savePhysicianRevision({ physicianId: first.id, expectedVersion: 1,
      profile: { displayName: "Dr. Test Physician", licenseNumber: "PRC 99999", active: true },
    }, admin)).rejects.toMatchObject({ code: "PHYSICIAN_STALE", status: 409 });
    const revisions = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM medical_certificate_physician_revisions WHERE physician_id=$1", [first.id]);
    expect(revisions.rows[0].count).toBe("2");
  });
});
