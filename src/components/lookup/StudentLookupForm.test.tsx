import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { StudentLookupForm } from "./StudentLookupForm";

describe("StudentLookupForm", () => {
  it("explains when a known student has no published appointment", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { studentNumber: "DEMO-0001", studentName: "Student 0001", appointments: [], compliance: { physicalExam: "PENDING_UPLOAD", laboratory: "PENDING_UPLOAD" } } }),
    }));
    render(<StudentLookupForm />);
    fireEvent.change(screen.getByPlaceholderText("e.g. 23-1212-97"), { target: { value: "DEMO-0001" } });
    fireEvent.click(screen.getByRole("button", { name: "Find schedule" }));
    expect(await screen.findByText("No published appointment is available yet.")).toBeVisible();
  });

  it("shows readable appointment and completion status labels", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: {
        studentNumber: "DEMO-0001",
        studentName: "Student 0001",
        appointments: [{ scheduleType: "LABORATORY", appointmentDate: "2026-08-18", status: "NO_SHOW" }],
        compliance: { physicalExam: "REQUIRES_FOLLOW_UP", laboratory: "NOT_APPLICABLE" },
      } }),
    }));
    render(<StudentLookupForm />);
    fireEvent.change(screen.getByPlaceholderText("e.g. 23-1212-97"), { target: { value: "DEMO-0001" } });
    fireEvent.click(screen.getByRole("button", { name: "Find schedule" }));

    expect(await screen.findByText("No-show")).toBeVisible();
    expect(screen.getByText("Needs follow-up")).toBeVisible();
    expect(screen.getByText("Not applicable")).toBeVisible();
    expect(screen.queryByText("NO_SHOW")).not.toBeInTheDocument();
    expect(screen.queryByText("REQUIRES_FOLLOW_UP")).not.toBeInTheDocument();
  });
});
