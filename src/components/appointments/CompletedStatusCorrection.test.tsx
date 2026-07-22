import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
}));

import { CompletedStatusCorrection } from "./CompletedStatusCorrection";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function renderCorrection(appointmentDate = "2026-07-21") {
  return render(
    <CompletedStatusCorrection
      appointmentId="appointment-1"
      appointmentDate={appointmentDate}
      source="LABORATORY"
    />,
  );
}

describe("CompletedStatusCorrection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-07-22T04:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("offers pending and no-show and requires a correction reason", () => {
    renderCorrection();

    expect(screen.getByRole("heading", { name: "Correct completed status" })).toBeVisible();
    expect(screen.getByRole("option", { name: "Pending" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "No-show" })).toBeInTheDocument();
    expect(screen.getByLabelText("Correction reason")).toBeRequired();
  });

  it.each([
    ["today", "2026-07-22"],
    ["future", "2026-07-23"],
  ])("disables no-show for a %s Manila appointment", (_, appointmentDate) => {
    renderCorrection(appointmentDate);

    expect(screen.getByRole("option", { name: "No-show" })).toBeDisabled();
    expect(screen.getByText(
      "No-show corrections are available only after the appointment date.",
    )).toBeVisible();
  });

  it("uses the Manila date when UTC is still on the previous day", () => {
    vi.setSystemTime(new Date("2026-07-21T16:30:00.000Z"));
    renderCorrection("2026-07-22");

    expect(screen.getByRole("option", { name: "No-show" })).toBeDisabled();
  });

  it("opens confirmation before sending the correction PATCH", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderCorrection();

    await user.selectOptions(screen.getByLabelText("Correct status to"), "NO_SHOW");
    await user.type(screen.getByLabelText("Correction reason"), "Incorrect completion entry");
    await user.click(screen.getByRole("button", { name: "Review correction" }));

    expect(screen.getByRole("dialog", { name: "Confirm status correction?" })).toBeVisible();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("disables controls, shows a spinner, sends the PATCH body, and refreshes", async () => {
    let resolveResponse!: (response: Response) => void;
    const fetchMock = vi.fn().mockReturnValue(new Promise<Response>((resolve) => {
      resolveResponse = resolve;
    }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderCorrection();

    await user.selectOptions(screen.getByLabelText("Correct status to"), "NO_SHOW");
    await user.type(screen.getByLabelText("Correction reason"), "Incorrect completion entry");
    await user.click(screen.getByRole("button", { name: "Review correction" }));
    await user.click(screen.getByRole("button", { name: "Confirm correction" }));

    expect(fetchMock).toHaveBeenCalledWith("/api/appointments/appointment-1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        status: "NO_SHOW",
        correctionReason: "Incorrect completion entry",
        source: "LABORATORY",
      }),
    });
    expect(screen.getByLabelText("Correct status to")).toBeDisabled();
    expect(screen.getByLabelText("Correction reason")).toBeDisabled();
    expect(screen.getByRole("status", { name: "Saving correction" })).toBeVisible();

    resolveResponse(jsonResponse({ data: { id: "appointment-1", status: "NO_SHOW" } }));
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
  });

  it("displays the server error and allows retry after a failed PATCH", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({
      error: { message: "This appointment has protected result data and cannot be corrected." },
    }, 409)));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderCorrection();

    await user.type(screen.getByLabelText("Correction reason"), "Incorrect completion entry");
    await user.click(screen.getByRole("button", { name: "Review correction" }));
    await user.click(screen.getByRole("button", { name: "Confirm correction" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This appointment has protected result data and cannot be corrected.",
    );
    expect(screen.getByLabelText("Correct status to")).toBeEnabled();
    expect(refresh).not.toHaveBeenCalled();
  });
});
