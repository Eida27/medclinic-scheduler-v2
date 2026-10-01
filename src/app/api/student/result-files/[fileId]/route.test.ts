// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors";
const { getStudentResultFile, requireStudent, requireVerifiedStudent } = vi.hoisted(() => ({
  getStudentResultFile: vi.fn(), requireStudent: vi.fn(), requireVerifiedStudent: vi.fn(),
}));
vi.mock("@/server/auth/current-student", () => ({ requireStudent, requireVerifiedStudent }));
vi.mock("@/server/services/student-result-submissions.service", () => ({ getStudentResultFile }));
import { GET } from "./route";
const context = { params: Promise.resolve({ fileId: "10000000-0000-4000-8000-000000000001" }) };
const request = () => new Request("http://localhost/file");
describe("student result download authorization", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    requireStudent.mockResolvedValue({ studentNumber: "24-0001", studentName: "Student, Test", email: null, emailVerifiedAt: null });
    requireVerifiedStudent.mockRejectedValue(new AppError("STUDENT_EMAIL_VERIFICATION_REQUIRED", "Verify email.", 403));
  });
  it("downloads an unverified student's eligible file through the scoped service with private headers", async () => {
    getStudentResultFile.mockResolvedValue({ bytes: Buffer.from("%PDF-1.7"), filename: "My result.pdf", mimeType: "application/pdf" });
    const response = await GET(request(), context);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("%PDF-1.7");
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("content-length")).toBe("8");
    expect(response.headers.get("content-disposition")).toBe("attachment; filename*=UTF-8''My%20result.pdf");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(getStudentResultFile).toHaveBeenCalledWith("24-0001", "10000000-0000-4000-8000-000000000001");
  });
  it.each([[404, "RESULT_FILE_NOT_FOUND"], [410, "RESULT_FILE_UNAVAILABLE"]])("preserves service eligibility denial %s", async (status, code) => {
    getStudentResultFile.mockRejectedValue(new AppError(code, "Result file unavailable.", status));
    const response = await GET(request(), context);
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: { code, message: "Result file unavailable." } });
  });
  it("rejects unauthenticated downloads before private-file access", async () => {
    const error = new AppError("UNAUTHENTICATED", "Sign in.", 401);
    requireStudent.mockRejectedValue(error); requireVerifiedStudent.mockRejectedValue(error);
    const response = await GET(request(), context);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: { code: "UNAUTHENTICATED", message: "Sign in." } });
    expect(getStudentResultFile).not.toHaveBeenCalled();
  });
});
