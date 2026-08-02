// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors";

const {
  createAcademicYear,
  deleteAcademicYear,
  listAcademicYears,
  requireUser,
  updateAcademicYear,
} = vi.hoisted(() => ({
  createAcademicYear: vi.fn(),
  deleteAcademicYear: vi.fn(),
  listAcademicYears: vi.fn(),
  requireUser: vi.fn(),
  updateAcademicYear: vi.fn(),
}));

vi.mock("@/server/auth/current-user", () => ({ requireUser }));
vi.mock("@/server/services/academic-years.service", () => ({
  createAcademicYear,
  deleteAcademicYear,
  listAcademicYears,
  updateAcademicYear,
}));

import { DELETE, GET, PATCH, POST } from "./route";

const actor = { userId: "00000000-0000-4000-8000-000000000001", role: "ADMIN" as const };
const body = { startYear: 2025, closingDate: "2026-07-31" };

function request(method: string, payload: unknown = body) {
  return new Request("http://localhost/api/settings/academic-years", {
    method,
    headers: { "content-type": "application/json" },
    body: method === "GET" ? undefined : JSON.stringify(payload),
  });
}

describe("/api/settings/academic-years", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireUser.mockResolvedValue(actor);
    listAcademicYears.mockResolvedValue([{ ...body, label: "2025–2026", state: "OPEN" }]);
    createAcademicYear.mockResolvedValue({ ...body, label: "2025–2026", state: "OPEN" });
    updateAcademicYear.mockResolvedValue({ ...body, label: "2025–2026", state: "OPEN" });
    deleteAcademicYear.mockResolvedValue({ success: true });
  });

  it("lists academic years for administrators", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect(requireUser).toHaveBeenCalledWith(["ADMIN"]);
    await expect(response.json()).resolves.toEqual({
      data: [{ ...body, label: "2025–2026", state: "OPEN" }],
    });
  });

  it.each([
    ["POST", POST, createAcademicYear, 201],
    ["PATCH", PATCH, updateAcademicYear, 200],
    ["DELETE", DELETE, deleteAcademicYear, 200],
  ] as const)("handles administrator %s mutations through the collection route", async (method, handler, service, status) => {
    const payload = method === "DELETE" ? { startYear: 2025 } : body;
    const response = await handler(request(method, payload));
    expect(response.status).toBe(status);
    expect(requireUser).toHaveBeenCalledWith(["ADMIN"]);
    expect(service).toHaveBeenCalledWith(payload, actor.userId);
  });

  it.each([
    ["GET", () => GET(), listAcademicYears],
    ["POST", () => POST(request("POST")), createAcademicYear],
    ["PATCH", () => PATCH(request("PATCH")), updateAcademicYear],
    ["DELETE", () => DELETE(request("DELETE", { startYear: 2025 })), deleteAcademicYear],
  ] as const)("denies non-administrator %s before service access", async (_method, invoke, service) => {
    requireUser.mockRejectedValue(new AppError(
      "FORBIDDEN",
      "You do not have permission to perform this action.",
      403,
    ));
    const response = await invoke();
    expect(response.status).toBe(403);
    expect(service).not.toHaveBeenCalled();
  });

  it("returns linked-delete conflicts with safe details", async () => {
    deleteAcademicYear.mockRejectedValue(new AppError(
      "ACADEMIC_YEAR_IN_USE",
      "This academic year has linked historical records and cannot be deleted.",
      409,
      undefined,
      { linkedSnapshotCount: 2 },
    ));
    const response = await DELETE(request("DELETE", { startYear: 2025 }));
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "ACADEMIC_YEAR_IN_USE",
        message: "This academic year has linked historical records and cannot be deleted.",
        details: { linkedSnapshotCount: 2 },
      },
    });
  });
});
