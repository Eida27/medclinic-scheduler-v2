// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors";

const {
  requireUser,
  getScheduleImport,
  validateScheduleImport,
  generateScheduleImport,
  publishScheduleImport,
} = vi.hoisted(() => ({
  requireUser: vi.fn(),
  getScheduleImport: vi.fn(),
  validateScheduleImport: vi.fn(),
  generateScheduleImport: vi.fn(),
  publishScheduleImport: vi.fn(),
}));

vi.mock("@/server/auth/current-user", () => ({ requireUser }));
vi.mock("@/server/services/schedule-imports.service", () => ({
  getScheduleImport,
  validateScheduleImport,
  generateScheduleImport,
  publishScheduleImport,
}));

import { GET } from "./route";
import { POST as validate } from "./validate/route";
import { POST as generate } from "./generate/route";
import { POST as publish } from "./publish/route";

const importId = "11111111-1111-4111-8111-111111111111";
const admin = { userId: "admin-user", role: "ADMIN" as const };
const context = { params: Promise.resolve({ importId }) };

describe("/api/schedule-imports/[importId]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireUser.mockResolvedValue(admin);
    getScheduleImport.mockResolvedValue({ id: importId, status: "DRAFT" });
    validateScheduleImport.mockResolvedValue({ importId, status: "VALIDATED" });
    generateScheduleImport.mockResolvedValue({ importId, status: "GENERATED" });
    publishScheduleImport.mockResolvedValue({ importId, status: "PUBLISHED" });
  });

  it("returns ADMIN-only import detail", async () => {
    const response = await GET(new Request(`http://localhost/api/schedule-imports/${importId}`), context);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ data: { id: importId, status: "DRAFT" } });
    expect(requireUser).toHaveBeenCalledWith(["ADMIN"]);
    expect(getScheduleImport).toHaveBeenCalledWith(importId, admin);
  });

  it("validates without requiring a request body", async () => {
    const response = await validate(new Request(
      `http://localhost/api/schedule-imports/${importId}/validate`,
      { method: "POST" },
    ), context);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ data: { importId, status: "VALIDATED" } });
    expect(requireUser).toHaveBeenCalledWith(["ADMIN"]);
    expect(validateScheduleImport).toHaveBeenCalledWith(importId, admin);
  });

  it("generates with an optional override reason", async () => {
    const response = await generate(new Request(
      `http://localhost/api/schedule-imports/${importId}/generate`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ overrideReason: "Approved capacity exception" }),
      },
    ), context);

    expect(response.status).toBe(200);
    expect(generateScheduleImport).toHaveBeenCalledWith(
      importId,
      admin,
      "Approved capacity exception",
    );
  });

  it("treats an empty generate body as an empty object", async () => {
    const response = await generate(new Request(
      `http://localhost/api/schedule-imports/${importId}/generate`,
      { method: "POST" },
    ), context);

    expect(response.status).toBe(200);
    expect(generateScheduleImport).toHaveBeenCalledWith(importId, admin, undefined);
  });

  it("rejects generate override reasons over 500 characters", async () => {
    const response = await generate(new Request(
      `http://localhost/api/schedule-imports/${importId}/generate`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ overrideReason: "x".repeat(501) }),
      },
    ), context);

    expect(response.status).toBe(422);
    expect(generateScheduleImport).not.toHaveBeenCalled();
  });

  it("publishes only with explicit confirmation", async () => {
    const confirmed = await publish(new Request(
      `http://localhost/api/schedule-imports/${importId}/publish`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: true }),
      },
    ), context);

    expect(confirmed.status).toBe(200);
    expect(publishScheduleImport).toHaveBeenCalledWith(importId, admin);

    publishScheduleImport.mockClear();
    const unconfirmed = await publish(new Request(
      `http://localhost/api/schedule-imports/${importId}/publish`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: false }),
      },
    ), context);

    expect(unconfirmed.status).toBe(422);
    expect(publishScheduleImport).not.toHaveBeenCalled();

    const empty = await publish(new Request(
      `http://localhost/api/schedule-imports/${importId}/publish`,
      { method: "POST" },
    ), context);
    expect(empty.status).toBe(422);
    expect(publishScheduleImport).not.toHaveBeenCalled();
  });

  it("requires ADMIN for detail and every lifecycle action", async () => {
    requireUser.mockRejectedValue(new AppError(
      "FORBIDDEN",
      "You do not have permission to perform this action.",
      403,
    ));

    const responses = await Promise.all([
      GET(new Request(`http://localhost/api/schedule-imports/${importId}`), context),
      validate(new Request(`http://localhost/api/schedule-imports/${importId}/validate`, { method: "POST" }), context),
      generate(new Request(`http://localhost/api/schedule-imports/${importId}/generate`, { method: "POST" }), context),
      publish(new Request(`http://localhost/api/schedule-imports/${importId}/publish`, { method: "POST" }), context),
    ]);

    expect(responses.map((response) => response.status)).toEqual([403, 403, 403, 403]);
    expect(requireUser.mock.calls).toEqual([
      [["ADMIN"]],
      [["ADMIN"]],
      [["ADMIN"]],
      [["ADMIN"]],
    ]);
    expect(getScheduleImport).not.toHaveBeenCalled();
    expect(validateScheduleImport).not.toHaveBeenCalled();
    expect(generateScheduleImport).not.toHaveBeenCalled();
    expect(publishScheduleImport).not.toHaveBeenCalled();
  });

  it("returns structured service errors unchanged", async () => {
    validateScheduleImport.mockRejectedValue(new AppError(
      "SCHEDULE_IMPORT_NEEDS_REVIEW",
      "Schedule import child batches are not synchronized.",
      409,
    ));

    const response = await validate(new Request(
      `http://localhost/api/schedule-imports/${importId}/validate`,
      { method: "POST" },
    ), context);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "SCHEDULE_IMPORT_NEEDS_REVIEW",
        message: "Schedule import child batches are not synchronized.",
      },
    });
  });
});
