import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  list: vi.fn(),
  create: vi.fn(),
  get: vi.fn(),
  update: vi.fn(),
  validate: vi.fn(),
  publish: vi.fn(),
  reschedule: vi.fn(),
  cancel: vi.fn(),
  verify: vi.fn(),
}));

vi.mock("@/server/auth/current-user", () => ({ requireUser: mocks.requireUser }));
vi.mock("@/server/ovpsa/ovpsa-first-year.service", () => ({
  listOvpsaFirstYearBatches: mocks.list,
  createOvpsaFirstYearBatch: mocks.create,
  getOvpsaFirstYearBatch: mocks.get,
  updateOvpsaFirstYearDraft: mocks.update,
  validateOvpsaFirstYearBatch: mocks.validate,
  publishOvpsaFirstYearBatch: mocks.publish,
  rescheduleOvpsaFirstYearBatch: mocks.reschedule,
  cancelOvpsaFirstYearBatch: mocks.cancel,
}));
vi.mock("@/server/ovpsa/external-laboratory-verification.service", () => ({
  verifyOvpsaExternalLaboratory: mocks.verify,
}));

import { GET, POST } from "./route";
import { GET as getBatch, PATCH } from "./[batchId]/route";
import { POST as validateBatch } from "./[batchId]/validate/route";
import { POST as publishBatch } from "./[batchId]/publish/route";
import { POST as rescheduleBatch } from "./[batchId]/reschedule/route";
import { POST as cancelBatch } from "./[batchId]/cancel/route";
import { POST as verifyExternalLab } from "../appointments/[appointmentId]/external-laboratory-verification/route";

const actor = { userId: "00000000-0000-4000-8000-000000000001", role: "ADMIN" };
const batchId = "11111111-1111-4111-8111-111111111111";
const appointmentId = "22222222-2222-4222-8222-222222222222";
const token = "33333333-3333-4333-8333-333333333333";
const batchContext = { params: Promise.resolve({ batchId }) };

function jsonRequest(url: string, body: unknown, method = "POST") {
  return new Request(url, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireUser.mockResolvedValue(actor);
});

describe("First Year OVPSA JSON routes", () => {
  it("requires an administrator for list and create", async () => {
    mocks.list.mockResolvedValue({ items: [] });
    expect((await GET()).status).toBe(200);
    expect(mocks.requireUser).toHaveBeenCalledWith(["ADMIN"]);

    mocks.create.mockResolvedValue({ batchId, optimisticToken: token });
    const response = await POST(jsonRequest("http://localhost/api/ovpsa-first-year-batches", {
      scheduleCycleStart: 2026,
      collegeId: "44444444-4444-4444-8444-444444444444",
      laboratoryDate: "2026-09-12",
      physicalExamDateOverride: null,
      physicalExamExceptionReason: null,
    }));
    expect(response.status).toBe(201);
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ laboratoryDate: "2026-09-12" }), actor.userId);
  });

  it("wires detail, update, validation, publication, reschedule, and cancellation tokens", async () => {
    mocks.get.mockResolvedValue({ batchId });
    expect((await getBatch(new Request("http://localhost"), batchContext)).status).toBe(200);

    mocks.update.mockResolvedValue({ batchId, optimisticToken: token });
    await PATCH(jsonRequest("http://localhost", {
      optimisticToken: token,
      laboratoryDate: "2026-09-12",
      physicalExamDateOverride: null,
      physicalExamExceptionReason: null,
    }, "PATCH"), batchContext);
    expect(mocks.update).toHaveBeenCalledWith(batchId, expect.objectContaining({ optimisticToken: token }), actor.userId);

    for (const [handler, service, body] of [
      [validateBatch, mocks.validate, { optimisticToken: token }],
      [publishBatch, mocks.publish, { optimisticToken: token }],
      [rescheduleBatch, mocks.reschedule, {
        optimisticToken: token,
        laboratoryDate: "2026-10-03",
        physicalExamDateOverride: null,
        physicalExamExceptionReason: null,
        reason: "Official closure replacement",
      }],
      [cancelBatch, mocks.cancel, { optimisticToken: token, reason: "OVPSA cancelled the batch" }],
    ] as const) {
      service.mockResolvedValue({ batchId });
      const response = await handler(jsonRequest("http://localhost", body), batchContext);
      expect(response.status).toBe(200);
      expect(service).toHaveBeenCalledWith(batchId, expect.objectContaining({ optimisticToken: token }), actor.userId);
    }
  });

  it("returns structured authorization and validation errors", async () => {
    mocks.requireUser.mockRejectedValueOnce(new AppError("FORBIDDEN", "Administrators only.", 403));
    const denied = await GET();
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ error: { code: "FORBIDDEN" } });

    const invalid = await POST(jsonRequest("http://localhost", { scheduleCycleStart: "bad" }));
    expect(invalid.status).toBe(422);
    expect(await invalid.json()).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
  });

  it("authorizes the external Laboratory verification route for admin or clinic staff", async () => {
    mocks.verify.mockResolvedValue({ appointmentId, externalProvider: "Iloilo Mission Hospital" });
    const response = await verifyExternalLab(
      jsonRequest("http://localhost", { remarks: "Mission Hospital result received" }),
      { params: Promise.resolve({ appointmentId }) },
    );
    expect(response.status).toBe(200);
    expect(mocks.requireUser).toHaveBeenCalledWith(["ADMIN", "CLINIC_STAFF"]);
    expect(mocks.verify).toHaveBeenCalledWith(appointmentId, { remarks: "Mission Hospital result received" }, actor);
  });
});
