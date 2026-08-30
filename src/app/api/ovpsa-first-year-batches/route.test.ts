import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  list: vi.fn(),
  get: vi.fn(),
  reschedule: vi.fn(),
  cancel: vi.fn(),
}));

vi.mock("@/server/auth/current-user", () => ({ requireUser: mocks.requireUser }));
vi.mock("@/server/ovpsa/ovpsa-first-year.service", () => ({
  listOvpsaFirstYearBatches: mocks.list,
  getOvpsaFirstYearBatch: mocks.get,
  rescheduleOvpsaFirstYearBatch: mocks.reschedule,
  cancelOvpsaFirstYearBatch: mocks.cancel,
}));

import { GET } from "./route";
import { GET as getBatch } from "./[batchId]/route";
import { POST as rescheduleBatch } from "./[batchId]/reschedule/route";
import { POST as cancelBatch } from "./[batchId]/cancel/route";

const actor = { userId: "00000000-0000-4000-8000-000000000001", role: "ADMIN" };
const batchId = "11111111-1111-4111-8111-111111111111";
const token = "33333333-3333-4333-8333-333333333333";
const batchContext = { params: Promise.resolve({ batchId }) };

function jsonRequest(body: unknown) {
  return new Request("http://localhost", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireUser.mockResolvedValue(actor);
});

describe("First Year OVPSA operational routes", () => {
  it("preserves historical list and detail reads", async () => {
    mocks.list.mockResolvedValue({ items: [] });
    mocks.get.mockResolvedValue({ batchId });

    expect((await GET()).status).toBe(200);
    expect((await getBatch(new Request("http://localhost"), batchContext)).status).toBe(200);
    expect(mocks.requireUser).toHaveBeenCalledWith(["ADMIN"]);
    expect(mocks.get).toHaveBeenCalledWith(batchId);
  });

  it("preserves emergency batch rescheduling and cancellation", async () => {
    for (const [handler, service, body] of [
      [rescheduleBatch, mocks.reschedule, {
        optimisticToken: token,
        laboratoryDate: "2026-10-03",
        physicalExamDateOverride: null,
        physicalExamExceptionReason: null,
        reason: "Official closure replacement",
      }],
      [cancelBatch, mocks.cancel, {
        optimisticToken: token,
        reason: "OVPSA cancelled the batch",
      }],
    ] as const) {
      service.mockResolvedValue({ batchId });
      const response = await handler(jsonRequest(body), batchContext);

      expect(response.status).toBe(200);
      expect(service).toHaveBeenCalledWith(
        batchId,
        expect.objectContaining({ optimisticToken: token }),
        actor.userId,
      );
    }
  });

  it("returns structured authorization and validation errors", async () => {
    mocks.requireUser.mockRejectedValueOnce(
      new AppError("FORBIDDEN", "Administrators only.", 403),
    );
    expect((await GET()).status).toBe(403);

    const invalid = await cancelBatch(jsonRequest({
      optimisticToken: "not-a-uuid",
      reason: "no",
    }), batchContext);
    expect(invalid.status).toBe(422);
    expect(mocks.cancel).not.toHaveBeenCalled();
  });
});
