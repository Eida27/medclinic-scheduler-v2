import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
const { requireStudentPage, requireVerifiedStudentPage, listStudentNotifications } = vi.hoisted(() => ({
  requireStudentPage: vi.fn(), requireVerifiedStudentPage: vi.fn(), listStudentNotifications: vi.fn(),
}));
vi.mock("@/server/auth/student-page", () => ({ requireStudentPage }));
vi.mock("@/server/auth/verified-student-page", () => ({ requireVerifiedStudentPage }));
vi.mock("@/server/services/student-notifications.service", () => ({ listStudentNotifications }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
import StudentNotificationsPage from "./page";
describe("StudentNotificationsPage", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    requireStudentPage.mockResolvedValue({ studentNumber: "24-0001", studentName: "Student, Test", email: null, emailVerifiedAt: null });
    requireVerifiedStudentPage.mockRejectedValue(new Error("Verification must not gate reading"));
  });
  it("shows an unverified student's notifications and normal mark-read action", async () => {
    listStudentNotifications.mockResolvedValue({ unreadCount: 1, items: [{ id: "notice-1", title: "Appointment published", message: "Your clinic schedule is ready.", readAt: null, createdAt: new Date("2026-10-01T00:00:00Z") }] });
    render(await StudentNotificationsPage());
    expect(screen.getByText("1 unread")).toBeVisible();
    expect(screen.getByRole("heading", { name: "Appointment published" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Mark read" })).toBeVisible();
    expect(listStudentNotifications).toHaveBeenCalledWith("24-0001");
  });
  it("does not read notifications when authentication redirects", async () => {
    requireStudentPage.mockRejectedValue(new Error("REDIRECT:/student/login"));
    await expect(StudentNotificationsPage()).rejects.toThrow("REDIRECT:/student/login");
    expect(listStudentNotifications).not.toHaveBeenCalled();
  });
});
