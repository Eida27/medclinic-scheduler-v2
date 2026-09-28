import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PhysicalExamCompletionDialog } from "./PhysicalExamCompletionDialog";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

function context(studentName: string) {
  return { data: { appointmentId: "11111111-1111-4111-8111-111111111111", studentName,
    studentNumber: "2026-1", appointmentDate: "2026-09-23", scheduleCycleStart: 2026,
    dateOfBirth: "2005-01-01", studentAcademicSnapshot: { studentName, collegeName: "College",
      programName: "Program", yearLevel: 1 }, physicians: [], blockers: [] } };
}

describe("PhysicalExamCompletionDialog", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("ignores stale context when a different appointment is opened", async () => {
    let resolveOld!: (value: Response) => void;
    const old = new Promise<Response>((resolve) => { resolveOld = resolve; });
    const fetchMock = vi.fn().mockReturnValueOnce(old)
      .mockResolvedValueOnce({ ok: true, json: async () => context("Second student") });
    vi.stubGlobal("fetch", fetchMock);
    const onClose = vi.fn();
    const view = render(<PhysicalExamCompletionDialog appointmentId="first" onClose={onClose} onCompleted={vi.fn()} />);
    view.rerender(<PhysicalExamCompletionDialog appointmentId="second" onClose={onClose} onCompleted={vi.fn()} />);
    expect(await screen.findByText(/Second student · 2026-1/)).toBeVisible();
    await act(async () => resolveOld({ ok: true, json: async () => context("First student") } as Response));
    expect(screen.queryByText(/First student · 2026-1/)).not.toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("keeps submit unavailable while context is loading or failed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, json: async () =>
      ({ error: { message: "The appointment changed." } }) }));
    render(<PhysicalExamCompletionDialog appointmentId="first" onClose={vi.fn()} onCompleted={vi.fn()} />);
    expect(screen.getByText("Loading examination details…")).toBeVisible();
    expect(await screen.findByRole("alert")).toHaveTextContent("The appointment changed.");
    expect(screen.queryByRole("button", { name: "Submit" })).not.toBeInTheDocument();
  });
});
