import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
import { LaboratoryChecklist, type ChecklistView } from "./LaboratoryChecklist";
import type { LaboratoryCompletionPolicy } from "@/shared/laboratory-completion";

const initial = {
  checklistId: "list-1", appointmentId: "appointment-1", version: 1,
  appointmentStatus: "PENDING", verifiedCount: 0, totalCount: 3,
  completionPolicy: { mode: "STANDARD", manualTestCodes: ["CBC", "URINE", "STOOL"], peConfirmedTestCodes: [], externalProvider: null } as LaboratoryCompletionPolicy,
  items: (["CBC", "URINE", "STOOL"] as const).map((testCode) => ({
    testCode, verifiedAt: null, verifiedBy: null, verificationSource: null,
  })),
};

afterEach(() => { vi.unstubAllGlobals(); });

describe("LaboratoryChecklist", () => {
  const external = (mode: "FOURTH_YEAR_OJT" | "FIRST_YEAR_EXTERNAL"): ChecklistView => ({ ...initial, totalCount: 4,
    items: [...initial.items, { testCode: "XRAY", verifiedAt: null, verifiedBy: null, verificationSource: null }],
    completionPolicy: { mode, manualTestCodes: mode === "FOURTH_YEAR_OJT" ? ["CBC", "URINE", "STOOL"] : [],
      peConfirmedTestCodes: mode === "FOURTH_YEAR_OJT" ? ["XRAY"] : ["CBC", "URINE", "STOOL", "XRAY"], externalProvider: "Iloilo Mission Hospital" },
  });

  it("keeps OJT X-ray disabled while manual tests use the server version without optimistic checks", async () => {
    let resolveSave!: (value: unknown) => void;
    const fetchMock = vi.fn().mockReturnValue(new Promise((resolve) => { resolveSave = resolve; }));
    vi.stubGlobal("fetch", fetchMock);
    const checklist = external("FOURTH_YEAR_OJT");
    render(<LaboratoryChecklist appointmentId="appointment-1" initial={checklist} />);
    expect(screen.getAllByRole("checkbox")).toHaveLength(4);
    expect(screen.getByRole("checkbox", { name: "X-ray" })).toBeDisabled();
    expect(screen.getByText("X-ray at Iloilo Mission Hospital — confirmed when Physical Examination is completed.")).toBeVisible();
    fireEvent.click(screen.getByRole("checkbox", { name: "X-ray" }));
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("checkbox", { name: "CBC" }));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ testCode: "CBC", checked: true, expectedVersion: 1 });
    expect(screen.getByRole("checkbox", { name: "CBC" })).not.toBeChecked();
    resolveSave({ ok: true, json: async () => ({ data: { ...checklist, version: 2, verifiedCount: 1,
      items: [{ ...checklist.items[0], verifiedAt: "2026-10-08T04:00:00Z", verifiedBy: "staff", verificationSource: "INTERNAL" }, ...checklist.items.slice(1)] } }) });
    await waitFor(() => expect(screen.getByRole("checkbox", { name: "CBC" })).toBeChecked());
  });

  it("shows OJT 3/4 as pending hospital confirmation", () => {
    const checklist = external("FOURTH_YEAR_OJT");
    render(<LaboratoryChecklist appointmentId="appointment-1" initial={{ ...checklist, verifiedCount: 3,
      items: checklist.items.map((item) => item.testCode === "XRAY" ? item : { ...item, verifiedAt: "2026-10-08T04:00:00Z" }) }} />);
    expect(screen.getByText(/3\/4 verified/)).toBeVisible();
    expect(screen.getByText("CBC, Urine and Stool verified. Awaiting X-ray confirmation at Physical Examination.")).toBeVisible();
    expect(screen.getByRole("checkbox", { name: "X-ray" })).not.toBeChecked();
  });

  it("makes all First-Year tests read-only and explains confirmation at PE", () => {
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    render(<LaboratoryChecklist appointmentId="appointment-1" initial={external("FIRST_YEAR_EXTERNAL")} />);
    for (const box of screen.getAllByRole("checkbox")) { expect(box).toBeDisabled(); fireEvent.click(box); }
    expect(screen.getAllByRole("checkbox")).toHaveLength(4);
    expect(screen.getByText("Laboratory tests at Iloilo Mission Hospital will be confirmed when CPU Clinic completes the Physical Examination.")).toBeVisible();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["FOURTH_YEAR_OJT", "FIRST_YEAR_EXTERNAL"] as const)(
    "shows the committed %s checklist when the PE detail refreshes", (mode) => {
      const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
      const checklist = external(mode);
      const pending: ChecklistView = mode === "FIRST_YEAR_EXTERNAL" ? checklist : { ...checklist,
        verifiedCount: 3, items: checklist.items.map((item) => item.testCode === "XRAY" ? item : {
          ...item, verifiedAt: "2026-10-08T04:00:00Z", verifiedBy: "lab-staff", verificationSource: "INTERNAL",
        }) };
      const view = render(<LaboratoryChecklist appointmentId="appointment-1" initial={pending} readOnly />);
      expect(screen.getByRole("checkbox", { name: "X-ray" })).not.toBeChecked();
      const committed: ChecklistView = { ...pending, version: pending.version + 1, appointmentStatus: "COMPLETED",
        verifiedCount: 4, items: pending.items.map((item) => item.verifiedAt ? item : {
          ...item, verifiedAt: "2026-10-08T05:00:00Z", verifiedBy: "cpu-staff", verificationSource: "EXTERNAL",
        }) };
      view.rerender(<LaboratoryChecklist appointmentId="appointment-1" initial={committed} readOnly />);
      expect(screen.getByText(/4\/4 verified/)).toBeVisible();
      for (const box of screen.getAllByRole("checkbox")) {
        expect(box).toBeChecked(); expect(box).toBeDisabled();
      }
      expect(fetchMock).not.toHaveBeenCalled();
    });

  it.each([undefined, { mode: "FOURTH_YEAR_OJT", manualTestCodes: ["XRAY"], peConfirmedTestCodes: [], externalProvider: null }])(
    "fails closed when the completion policy is absent or invalid", (completionPolicy) => {
      render(<LaboratoryChecklist appointmentId="appointment-1" initial={{ ...initial, completionPolicy } as unknown as ChecklistView} />);
      expect(screen.getByRole("alert")).toHaveTextContent("Unable to load Laboratory completion policy.");
      expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
    });

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
