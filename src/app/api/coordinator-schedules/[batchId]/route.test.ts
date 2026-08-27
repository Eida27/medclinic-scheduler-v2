// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors";

const { requireUser, getScheduleBatch, editBatch } = vi.hoisted(() => ({
  requireUser: vi.fn(),
  getScheduleBatch: vi.fn(),
  editBatch: vi.fn(),
}));

vi.mock("@/server/auth/current-user", () => ({ requireUser }));
vi.mock("@/server/repositories/coordinator-schedules.repository", () => ({ getScheduleBatch }));
vi.mock("@/server/services/coordinator-schedules.service", () => ({ editBatch }));

import { GET, PATCH } from "./route";

const context = { params: Promise.resolve({ batchId: "batch-1" }) };
const user = { userId: "user-1", role: "ADMIN" as const };

describe("/api/coordinator-schedules/[batchId] legacy compatibility", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireUser.mockResolvedValue(user);
    editBatch.mockResolvedValue({ id: "batch-1", status: "DRAFT" });
  });

  it("rejects grouped child reads without exposing child details", async () => {
    getScheduleBatch.mockResolvedValue({
      id: "batch-1",
      importGroupId: "import-1",
      items: [{ studentNumber: "private-draft" }],
    });

    const response = await GET(new Request("http://localhost/api/coordinator-schedules/batch-1"), context);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "GROUPED_BATCH_ACTION_REQUIRED",
        message: "This batch belongs to a grouped schedule import. Use the grouped import action instead.",
      },
    });
  });

  it("keeps ungrouped GET compatibility", async () => {
    getScheduleBatch.mockResolvedValue({ id: "batch-1", importGroupId: null, items: [] });

    const getResponse = await GET(
      new Request("http://localhost/api/coordinator-schedules/batch-1"),
      context,
    );
    expect(getResponse.status).toBe(200);
    expect(editBatch).not.toHaveBeenCalled();
  });

  it("preserves authentication precedence for retired edits", async () => {
    requireUser.mockRejectedValue(new AppError("UNAUTHORIZED", "Authentication required.", 401));
    const request = new Request("http://localhost/api/coordinator-schedules/batch-1", { method: "PATCH" });
    const json = vi.spyOn(request, "json");

    const response = await PATCH(request, context);

    expect(response.status).toBe(401);
    expect(json).not.toHaveBeenCalled();
    expect(editBatch).not.toHaveBeenCalled();
  });

  it("retires edits before parsing the body, awaiting params, or mutating", async () => {
    const request = new Request("http://localhost/api/coordinator-schedules/batch-1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ batchName: "Must stay unchanged" }),
    });
    const json = vi.spyOn(request, "json");
    const then = vi.fn((_resolve, reject) => reject(new Error("params must not be awaited")));
    const untouchedContext = { params: { then } as unknown as Promise<{ batchId: string }> };

    const response = await PATCH(request, untouchedContext);

    expect(response.status).toBe(410);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "SCHEDULING_WORKFLOW_RETIRED" },
    });
    expect(json).not.toHaveBeenCalled();
    expect(then).not.toHaveBeenCalled();
    expect(editBatch).not.toHaveBeenCalled();
  });
});
