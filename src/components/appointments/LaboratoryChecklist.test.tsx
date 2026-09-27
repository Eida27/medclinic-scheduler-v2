import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
import { LaboratoryChecklist } from "./LaboratoryChecklist";

const initial = {
  checklistId: "list-1", appointmentId: "appointment-1", version: 1,
  appointmentStatus: "PENDING", verifiedCount: 0, totalCount: 3,
  items: (["CBC", "URINE", "STOOL"] as const).map((testCode) => ({
    testCode, verifiedAt: null, verifiedBy: null, verificationSource: null,
  })),
};

afterEach(() => { vi.unstubAllGlobals(); });

describe("LaboratoryChecklist", () => {
  it("collects a no-show correction reason inline before verifying a test", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { ...initial, appointmentStatus: "PENDING", version: 2, verifiedCount: 1,
        items: [{ ...initial.items[0], verifiedAt: "2026-09-23T00:00:00Z" }, ...initial.items.slice(1)] } }),
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<LaboratoryChecklist appointmentId="appointment-1" initial={{ ...initial, appointmentStatus: "NO_SHOW" }} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "CBC" }));
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole("textbox", { name: "Reason for correcting the automatic no-show" }),
      { target: { value: "Student attended the laboratory visit" } });
    fireEvent.click(screen.getByRole("button", { name: "Save checklist change" }));
    await waitFor(() => expect(screen.getByText(/1\/3 verified/)).toBeVisible());
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      testCode: "CBC", checked: true, reason: "Student attended the laboratory visit",
    });
  });

  it("labels each required test and announces the confirmed server progress", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { ...initial, version: 2, verifiedCount: 1,
        items: [{ ...initial.items[0], verifiedAt: "2026-09-23T00:00:00Z" }, ...initial.items.slice(1)] } }),
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<LaboratoryChecklist appointmentId="appointment-1" initial={initial} />);
    expect(screen.getByText("0/3 verified")).toBeVisible();
    fireEvent.click(screen.getByRole("checkbox", { name: "CBC" }));
    await waitFor(() => expect(screen.getByText(/1\/3 verified/)).toBeVisible());
    expect(fetchMock).toHaveBeenCalledWith("/api/appointments/appointment-1/laboratory-checklist", expect.objectContaining({ method: "PATCH" }));
    expect(screen.getByRole("checkbox", { name: "CBC" })).toBeChecked();
  });
});
