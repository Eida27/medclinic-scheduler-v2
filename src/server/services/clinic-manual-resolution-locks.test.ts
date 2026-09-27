// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import { lockClinicManualResolutionCases } from "./clinic-manual-resolution-locks";

describe("manual resolution lock order", () => {
  it("locks queue then sorted scopes before cases and affected or replacement appointments", async () => {
    const calls: Array<[string, unknown[] | undefined]> = [];
    const query = vi.fn(async (sql: string, args?: unknown[]) => {
      calls.push([sql, args]);
      return { rows: sql.includes("SELECT DISTINCT student_number")
        ? [{ student_number: "Z" }, { student_number: "A" }] : [] };
    });
    await lockClinicManualResolutionCases({ query } as unknown as PoolClient, ["b", "a", "b"]);
    expect(calls[0][0]).toContain("schedule-import-queue");
    const scopes = calls.filter(([sql]) => sql.includes("hashtextextended"));
    expect(scopes.map(([, args]) => args?.[0])).toEqual([
      "medclinic:effective-appointment:v1:LABORATORY:A",
      "medclinic:effective-appointment:v1:LABORATORY:Z",
      "medclinic:effective-appointment:v1:PHYSICAL_EXAM:A",
      "medclinic:effective-appointment:v1:PHYSICAL_EXAM:Z",
    ]);
    const caseLock = calls.findIndex(([sql]) => sql.includes("FOR UPDATE") && sql.includes("clinic_closure_manual_cases"));
    expect(caseLock).toBe(6);
    expect(calls[caseLock][0]).toContain("ORDER BY id");
    expect(calls[caseLock][1]).toEqual([["a", "b"]]);
    expect(calls[caseLock + 1][0]).toContain("ORDER BY appointment.id");
    expect(calls[caseLock + 1][0]).toContain("appointment_reschedule_events");
    expect(calls.some(([sql]) => /^(BEGIN|COMMIT|ROLLBACK)$/.test(sql))).toBe(false);
  });
});
