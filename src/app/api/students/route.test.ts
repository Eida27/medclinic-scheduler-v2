// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const { createStudent, listStudents, requireUser } = vi.hoisted(() => ({
  createStudent: vi.fn(),
  listStudents: vi.fn(),
  requireUser: vi.fn(),
}));

vi.mock("@/server/auth/current-user", () => ({ requireUser }));
vi.mock("@/server/services/students.service", () => ({ createStudent, listStudents }));

import { GET, POST } from "./route";

describe("/api/students permissions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireUser.mockResolvedValue({ userId: "admin-1", role: "ADMIN" });
    listStudents.mockResolvedValue({ items: [], total: 0 });
    createStudent.mockResolvedValue({ studentNumber: "24-0001" });
  });

  it("allows every authenticated role to read students", async () => {
    await GET(new Request("http://localhost/api/students"));

    expect(requireUser).toHaveBeenCalledWith();
  });

  it("limits student creation to administrators and clinic staff", async () => {
    await POST(new Request("http://localhost/api/students", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ studentNumber: "24-0001" }),
    }));

    expect(requireUser).toHaveBeenCalledWith(["ADMIN", "CLINIC_STAFF"]);
  });
});
