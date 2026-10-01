// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors";
const { listStudentNotifications, markStudentNotificationRead, requireStudent, requireVerifiedStudent } = vi.hoisted(() => ({
  listStudentNotifications: vi.fn(), markStudentNotificationRead: vi.fn(), requireStudent: vi.fn(), requireVerifiedStudent: vi.fn(),
}));
vi.mock("@/server/auth/current-student", () => ({ requireStudent, requireVerifiedStudent }));
vi.mock("@/server/services/student-notifications.service", () => ({ listStudentNotifications, markStudentNotificationRead }));
import { GET, PATCH } from "./route";
const notificationId = "10000000-0000-4000-8000-000000000001";
describe("student notifications authorization", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    requireStudent.mockResolvedValue({ studentNumber: "24-0001", studentName: "Student, Test", email: null, emailVerifiedAt: null });
    requireVerifiedStudent.mockRejectedValue(new AppError("STUDENT_EMAIL_VERIFICATION_REQUIRED", "Verify email.", 403));
  });
  it("returns the unverified student's scoped notifications", async () => {
    listStudentNotifications.mockResolvedValue({ unreadCount: 1, items: [{ id: notificationId, title: "Schedule published" }] });
    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: { unreadCount: 1, items: [{ id: notificationId, title: "Schedule published" }] } });
    expect(listStudentNotifications).toHaveBeenCalledWith("24-0001");
  });
  it.each([true, false])("marks only the session student's notification read (found=%s)", async (found) => {
    markStudentNotificationRead.mockResolvedValue(found);
    const response = await PATCH(new Request("http://localhost/notifications", {
      method: "PATCH", body: JSON.stringify({ notificationId, studentNumber: "another-student" }),
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: { success: found } });
    expect(markStudentNotificationRead).toHaveBeenCalledWith("24-0001", notificationId);
  });
  it("retains validation for notification identifiers", async () => {
    const response = await PATCH(new Request("http://localhost/notifications", { method: "PATCH", body: '{"notificationId":"invalid"}' }));
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
    expect(markStudentNotificationRead).not.toHaveBeenCalled();
  });
  it.each(["GET", "PATCH"])("rejects unauthenticated %s before body or service work", async (method) => {
    const error = new AppError("UNAUTHENTICATED", "Please sign in to continue.", 401);
    requireStudent.mockRejectedValue(error);
    requireVerifiedStudent.mockRejectedValue(error);
    const request = new Request("http://localhost/notifications", { method: "PATCH", body: "malformed" });
    const json = vi.spyOn(request, "json");
    const response = method === "GET" ? await GET() : await PATCH(request);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: { code: "UNAUTHENTICATED", message: "Please sign in to continue." } });
    expect(json).not.toHaveBeenCalled();
    expect(listStudentNotifications).not.toHaveBeenCalled();
    expect(markStudentNotificationRead).not.toHaveBeenCalled();
  });
});
