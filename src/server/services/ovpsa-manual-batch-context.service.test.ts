import { beforeEach, expect, it, vi } from "vitest";
import { getOvpsaManualBatchContext } from "./ovpsa-manual-batch-context.service";

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("@/server/db/pool", () => ({ transaction: (run: (client: { query: typeof query }) => Promise<unknown>) => run({ query }) }));
const actor = { userId: "admin", role: "ADMIN", fullName: "Admin", email: "admin@example.test" } as const;
const batchId = "83000000-0000-4000-8000-000000000001";

beforeEach(() => query.mockReset());

it("returns every linked member beyond the visible queue page", async () => {
  query.mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [{ optimistic_token: "revision", status: "RESCHEDULE_REQUIRED" }] })
    .mockResolvedValueOnce({ rows: Array.from({ length: 21 }, (_, index) => ({
      case_id: `case-${index}`, optimistic_token: `token-${index}`, student_number: `24-${index}`,
      student_name: `Student ${index}`,
    })) });
  const result = await getOvpsaManualBatchContext(batchId, actor);
  expect(result.cases).toHaveLength(21);
  expect(result.cases[20].expectedOptimisticToken).toBe("token-20");
  expect(query.mock.calls[2][0]).toContain("LIMIT 101");
});

it("rejects membership beyond the configured import limit", async () => {
  query.mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [{ optimistic_token: "revision", status: "RESCHEDULE_REQUIRED" }] })
    .mockResolvedValueOnce({ rows: Array.from({ length: 101 }, (_, index) => ({
      case_id: `case-${index}`, optimistic_token: `token-${index}`, student_number: `24-${index}`, student_name: "Student",
    })) });
  await expect(getOvpsaManualBatchContext(batchId, actor)).rejects.toMatchObject({ code: "OVPSA_BATCH_MEMBERSHIP_INVALID" });
});
