import type { PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import { lockEffectiveAppointmentScopes } from "./effective-appointment-scope-lock.repository";

describe("lockEffectiveAppointmentScopes", () => {
  it("deduplicates and locks namespaced scope keys in deterministic order", async () => {
    const client = { query: vi.fn().mockResolvedValue({ rows: [] }) } as unknown as PoolClient;

    await lockEffectiveAppointmentScopes(client, [
      { studentNumber: "2027-0002", scheduleType: "PHYSICAL_EXAM" },
      { studentNumber: "2027-0001", scheduleType: "LABORATORY" },
      { studentNumber: "2027-0001", scheduleType: "LABORATORY" },
    ]);

    expect(client.query).toHaveBeenCalledTimes(2);
    expect(client.query).toHaveBeenNthCalledWith(
      1,
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      ["medclinic:effective-appointment:v1:LABORATORY:2027-0001"],
    );
    expect(client.query).toHaveBeenNthCalledWith(
      2,
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      ["medclinic:effective-appointment:v1:PHYSICAL_EXAM:2027-0002"],
    );
  });
});
