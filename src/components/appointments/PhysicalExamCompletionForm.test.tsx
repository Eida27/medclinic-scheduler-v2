import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PhysicalExamCompletionForm } from "./PhysicalExamCompletionForm";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
afterEach(() => vi.unstubAllGlobals());

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
  physicians: [{ id: "physician-1", version: 2, displayName: "Dr Test", licenseNumber: "123", specialty: null }],
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
    expect(screen.getByRole("button", { name: "Submit" })).toBeDisabled();
  });

  it("submits Class B directly with mandatory details and preserves the same request on retry", async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new TypeError("Network error"))
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: { certificateId: "cert-1", certificateNumber: "MC-1" } }) });
    vi.stubGlobal("fetch", fetchMock);
    render(<PhysicalExamCompletionForm {...base} />);
    fireEvent.change(screen.getByLabelText("Sex recorded for this examination"), { target: { value: "Female" } });
    fireEvent.change(screen.getByLabelText("Physician"), { target: { value: "physician-1" } });
    fireEvent.click(screen.getByRole("radio", { name: /Class B:/ }));
    fireEvent.change(screen.getByLabelText(/Remarks/), { target: { value: "Correctible" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /I attest/ }));
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0][0]).toContain("complete-physical-exam");
    await screen.findByRole("button", { name: /Retry same request/i });
    fireEvent.click(screen.getByRole("button", { name: /Retry same request/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls[1][1].body).toBe(fetchMock.mock.calls[0][1].body);
  });

  it.each(["A", "C", "D"])("submits Class %s without preview", async (classification) => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true,
      json: async () => ({ data: { certificateId: "cert-1", certificateNumber: "MC-1" } }) });
    vi.stubGlobal("fetch", fetchMock);
    render(<PhysicalExamCompletionForm {...base} />);
    fireEvent.change(screen.getByLabelText("Sex recorded for this examination"), { target: { value: "Female" } });
    fireEvent.change(screen.getByLabelText("Physician"), { target: { value: "physician-1" } });
    fireEvent.click(screen.getByRole("radio", { name: new RegExp(`Class ${classification}:`) }));
    if (classification !== "A") fireEvent.change(screen.getByLabelText(/Remarks/), { target: { value: "Finding" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /I attest/ }));
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(fetchMock.mock.calls[0][0]).toContain("complete-physical-exam");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).classification).toBe(classification);
  });

  it("requires a reason for a past examination date before calling the API", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<PhysicalExamCompletionForm {...base} today="2026-09-27" status="PENDING" />);
    fireEvent.change(screen.getByLabelText("Sex recorded for this examination"), { target: { value: "Female" } });
    fireEvent.change(screen.getByLabelText("Physician"), { target: { value: "physician-1" } });
    fireEvent.click(screen.getByRole("radio", { name: /Class A:/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /I attest/ }));
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByLabelText(/Reason for late encoding/)).toBeRequired();
  });
});
