import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PhysicalExamCompletionForm } from "./PhysicalExamCompletionForm";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

const base = {
  appointmentId: "11111111-1111-4111-8111-111111111111",
  studentName: "Current student name",
  studentNumber: "2026-0001",
  appointmentDate: "2026-09-24",
  scheduleCycleStart: 2026,
  dateOfBirth: "2005-09-25",
  studentAcademicSnapshot: {
    studentName: "Snapshot student name",
    collegeName: "College of Nursing",
    programName: "BS Nursing",
    yearLevel: 4,
  },
  physicians: [],
};

describe("PhysicalExamCompletionForm certificate context", () => {
  it("shows the immutable academic record and age for the actual examination date", () => {
    render(<PhysicalExamCompletionForm {...base} />);

    expect(screen.getByText("Snapshot student name")).toBeVisible();
    expect(screen.getByText("2026–2027")).toBeVisible();
    expect(screen.getByText("College of Nursing · BS Nursing · Year 4")).toBeVisible();
    expect(screen.getByText("2005-09-25")).toBeVisible();
    expect(screen.getByText("20 years")).toBeVisible();

    fireEvent.change(screen.getByLabelText("Actual examination date"), { target: { value: "2026-09-25" } });
    expect(screen.getByText("21 years")).toBeVisible();
  });

  it("blocks preview and explains missing certificate identity data", () => {
    render(<PhysicalExamCompletionForm {...base} studentAcademicSnapshot={null} dateOfBirth={null} />);
    expect(screen.getByText(/academic snapshot is missing/i)).toBeVisible();
    expect(screen.getByRole("button", { name: "Preview certificate" })).toBeDisabled();
  });
});
