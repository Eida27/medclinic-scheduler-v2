// @vitest-environment node
import { afterAll, describe, expect, it } from "vitest";
import { pool } from "@/server/db/pool";
import { complianceReport, resultsForStudent } from "@/server/repositories/tracking.repository";
import { recordResult, resultSchema } from "./tracking.service";

const actorUserId = "00000000-0000-4000-8000-000000000002";

afterAll(async () => pool.end());

describe("results and compliance", () => {
  it("requires a completion date for completed results", () => {
    expect(() => resultSchema.parse({
      studentNumber: "DEMO-0178", resultType: "PHYSICAL_EXAM",
      resultStatus: "COMPLETED", completedAt: "", remarks: "",
    })).toThrow();
  });

  it("stores historical results and reflects them in compliance", async () => {
    const result = await recordResult({
      studentNumber: "DEMO-0178", appointmentId: null, resultType: "PHYSICAL_EXAM",
      resultStatus: "COMPLETED", completedAt: "2026-07-01", remarks: "Historical record",
    }, actorUserId);
    try {
      const history = await resultsForStudent("DEMO-0178");
      expect(history?.examResults[0]).toMatchObject({ resultStatus: "COMPLETED", completedAt: "2026-07-01" });
      const compliance = await complianceReport({ search: "DEMO-0178", page: 1, limit: 20, offset: 0 });
      expect(compliance.items[0]).toMatchObject({ physicalExamStatus: "COMPLETED" });
    } finally {
      await pool.query("DELETE FROM exam_results WHERE id=$1", [result.id]);
    }
  });
});
