import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { StudentLookupForm } from "./StudentLookupForm";

describe("StudentLookupForm", () => {
  it("explains when a known student has no published appointment", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { studentNumber: "DEMO-0001", studentName: "Student 0001", appointments: [], compliance: { physicalExam: "PENDING", laboratory: "PENDING" } } }),
    }));
    render(<StudentLookupForm />);
    fireEvent.change(screen.getByPlaceholderText("e.g. 23-1212-97"), { target: { value: "DEMO-0001" } });
    fireEvent.click(screen.getByRole("button", { name: "Find schedule" }));
    expect(await screen.findByText("No published appointment is available yet.")).toBeVisible();
  });
});
