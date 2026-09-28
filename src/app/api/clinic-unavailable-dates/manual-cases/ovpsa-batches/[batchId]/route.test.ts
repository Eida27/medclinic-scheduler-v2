import { beforeEach, expect, it, vi } from "vitest";
import { GET } from "./route";

vi.mock("@/server/auth/current-user", () => ({ requireUser: vi.fn() }));
vi.mock("@/server/services/ovpsa-manual-batch-context.service", () => ({ getOvpsaManualBatchContext: vi.fn() }));
import { requireUser } from "@/server/auth/current-user";
import { getOvpsaManualBatchContext } from "@/server/services/ovpsa-manual-batch-context.service";

beforeEach(() => vi.clearAllMocks());

it("loads full authorized OVPSA membership for the requested batch", async () => {
  vi.mocked(requireUser).mockResolvedValue({ userId: "admin" } as never);
  vi.mocked(getOvpsaManualBatchContext).mockResolvedValue({ batchId: "batch", optimisticToken: "revision", cases: [{ caseId: "case", expectedOptimisticToken: "token", studentNumber: "24-0001", studentName: "Student" }] });
  const response = await GET(new Request("http://localhost/api"), { params: Promise.resolve({ batchId: "batch" }) });
  expect(response.status).toBe(200);
  expect(getOvpsaManualBatchContext).toHaveBeenCalledWith("batch", expect.objectContaining({ userId: "admin" }));
  expect((await response.json()).data.cases).toHaveLength(1);
});
