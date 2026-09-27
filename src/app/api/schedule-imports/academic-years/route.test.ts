// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors";

const { requireUser, listImportAcademicYears } = vi.hoisted(() => ({
  requireUser: vi.fn(), listImportAcademicYears: vi.fn(),
}));
vi.mock("@/server/auth/current-user", () => ({ requireUser }));
vi.mock("@/server/services/academic-years.service", () => ({ listImportAcademicYears }));
import { GET } from "./route";

describe("import academic-year catalog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireUser.mockResolvedValue({ role: "COORDINATOR" });
    listImportAcademicYears.mockResolvedValue([
      { startYear: 2026, label: "2026–2027", closingDate: "2027-07-31", state: "OPEN", selectable: true },
    ]);
  });

  it("exposes only the import catalog to coordinators in a private response", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(requireUser).toHaveBeenCalledWith(["ADMIN", "COORDINATOR"]);
    const body = await response.json();
    expect(body.data.years).toEqual([
      { startYear: 2026, label: "2026–2027", closingDate: "2027-07-31", state: "OPEN", selectable: true },
    ]);
    expect(body.data.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("denies students without exposing year data and without cache storage", async () => {
    requireUser.mockRejectedValue(new AppError("FORBIDDEN", "Forbidden", 403));
    const response = await GET();
    expect(response.status).toBe(403);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(listImportAcademicYears).not.toHaveBeenCalled();
  });
});
