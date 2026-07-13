// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors";

const {
  addReference,
  editReference,
  listColleges,
  listPriorityGroups,
  listPrograms,
  removeReference,
  requireUser,
} = vi.hoisted(() => ({
  addReference: vi.fn(),
  editReference: vi.fn(),
  listColleges: vi.fn(),
  listPriorityGroups: vi.fn(),
  listPrograms: vi.fn(),
  removeReference: vi.fn(),
  requireUser: vi.fn(),
}));

vi.mock("@/server/auth/current-user", () => ({ requireUser }));
vi.mock("@/server/repositories/reference-data.repository", () => ({
  listColleges,
  listPriorityGroups,
  listPrograms,
}));
vi.mock("@/server/services/reference-data.service", () => ({
  addReference,
  editReference,
  removeReference,
}));

import { DELETE as deleteCollege } from "./colleges/route";
import { DELETE as deletePriorityGroup } from "./priority-groups/route";
import { DELETE as deleteProgram } from "./programs/route";

const actor = { userId: "00000000-0000-4000-8000-000000000001", role: "ADMIN" as const };
const referenceId = "20000000-0000-4000-8000-000000000099";

function deleteRequest(path: string) {
  return new Request(`http://localhost${path}`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: referenceId }),
  });
}

const routeCases = [
  ["college", "/api/colleges", deleteCollege],
  ["program", "/api/programs", deleteProgram],
  ["priorityGroup", "/api/priority-groups", deletePriorityGroup],
] as const;

describe("reference data DELETE routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireUser.mockResolvedValue(actor);
    removeReference.mockResolvedValue({ success: true });
  });

  it.each(routeCases)("deletes an ADMIN %s through its existing collection route", async (type, path, handler) => {
    const response = await handler(deleteRequest(path));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ data: { success: true } });
    expect(requireUser).toHaveBeenCalledWith(["ADMIN"]);
    expect(removeReference).toHaveBeenCalledWith(type, { id: referenceId }, actor.userId);
  });

  it.each(routeCases)("rejects non-admin %s deletion before invoking the service", async (_, path, handler) => {
    requireUser.mockRejectedValue(new AppError(
      "FORBIDDEN",
      "You do not have permission to perform this action.",
      403,
    ));

    const response = await handler(deleteRequest(path));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "FORBIDDEN",
        message: "You do not have permission to perform this action.",
      },
    });
    expect(removeReference).not.toHaveBeenCalled();
  });

  it("returns structured service conflicts unchanged", async () => {
    removeReference.mockRejectedValue(new AppError(
      "REFERENCE_IN_USE",
      "This reference value is already in use and cannot be deleted.",
      409,
    ));

    const response = await deleteCollege(deleteRequest("/api/colleges"));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "REFERENCE_IN_USE",
        message: "This reference value is already in use and cannot be deleted.",
      },
    });
  });
});
