import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
}));

import { AppointmentQuickStatusButton } from "./AppointmentQuickStatusButton";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("AppointmentQuickStatusButton", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("marks Pending completed immediately with the semantic payload", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: { status: "COMPLETED" } }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(
      <AppointmentQuickStatusButton
        appointmentId="appointment-1"
        status="PENDING"
        completedFromStatus={null}
      />,
    );

    const button = screen.getByRole("button", { name: "Pending — click to mark completed" });
    expect(button).toHaveClass("bg-slate-100");
    await user.click(button);

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/api/appointments/appointment-1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        quickStatusAction: "MARK_COMPLETED",
        expectedStatus: "PENDING",
      }),
    });
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
  });

  it("does not optimistically change state and prevents duplicate submissions while busy", async () => {
    let resolveResponse!: (response: Response) => void;
    const fetchMock = vi.fn().mockReturnValue(new Promise<Response>((resolve) => {
      resolveResponse = resolve;
    }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(
      <AppointmentQuickStatusButton
        appointmentId="appointment-1"
        status="PENDING"
        completedFromStatus={null}
      />,
    );

    const button = screen.getByRole("button", { name: "Pending — click to mark completed" });
    await user.click(button);

    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(button).toHaveTextContent("Updating...");
    expect(button).toHaveClass("bg-slate-100");
    await user.click(button);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    resolveResponse(jsonResponse({ data: { status: "COMPLETED" } }));
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
  });

  it("restores a completion derived from Pending immediately", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: { status: "PENDING" } }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(
      <AppointmentQuickStatusButton
        appointmentId="appointment-1"
        status="COMPLETED"
        completedFromStatus="PENDING"
      />,
    );

    const button = screen.getByRole("button", { name: "Completed — click to restore pending" });
    expect(button).toHaveClass("bg-emerald-100");
    await user.click(button);

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/appointments/appointment-1",
      expect.objectContaining({
        body: JSON.stringify({
          quickStatusAction: "REVERT_COMPLETION",
          expectedStatus: "COMPLETED",
        }),
      }),
    );
  });

  it("requires a two-button confirmation with no reason field for automatic No-show", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(
      <AppointmentQuickStatusButton
        appointmentId="appointment-1"
        status="NO_SHOW"
        completedFromStatus={null}
      />,
    );

    const button = screen.getByRole("button", { name: "No-show — click to correct as completed" });
    expect(button).toHaveClass("bg-red-100");
    await user.click(button);

    expect(screen.getByRole("dialog", { name: "Correct no-show as completed?" })).toBeVisible();
    expect(screen.getAllByRole("button").map((item) => item.textContent)).toEqual([
      "No-show — click to correct as completed",
      "Cancel",
      "Mark as completed",
    ]);
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(button).toHaveFocus();
  });

  it.each([
    {
      status: "NO_SHOW" as const,
      completedFromStatus: null,
      buttonName: "No-show — click to correct as completed",
      dialogName: "Correct no-show as completed?",
      confirmName: "Mark as completed",
      quickStatusAction: "MARK_COMPLETED",
      expectedStatus: "NO_SHOW",
    },
    {
      status: "COMPLETED" as const,
      completedFromStatus: "NO_SHOW" as const,
      buttonName: "Completed — click to restore no-show",
      dialogName: "Restore automatic no-show?",
      confirmName: "Restore no-show",
      quickStatusAction: "REVERT_COMPLETION",
      expectedStatus: "COMPLETED",
    },
  ])("confirms $status before sending its semantic transition", async (scenario) => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: {} }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(
      <AppointmentQuickStatusButton
        appointmentId="appointment-1"
        status={scenario.status}
        completedFromStatus={scenario.completedFromStatus}
      />,
    );

    await user.click(screen.getByRole("button", { name: scenario.buttonName }));
    expect(screen.getByRole("dialog", { name: scenario.dialogName })).toBeVisible();
    await user.click(screen.getByRole("button", { name: scenario.confirmName }));

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/appointments/appointment-1",
      expect.objectContaining({
        body: JSON.stringify({
          quickStatusAction: scenario.quickStatusAction,
          expectedStatus: scenario.expectedStatus,
        }),
      }),
    );
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
  });

  it("keeps the authoritative state visible, reports a failure inline, and allows retry", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        error: { message: "This appointment can no longer be reverted because protected result data is linked to it." },
      }, 409))
      .mockResolvedValueOnce(jsonResponse({ data: {} }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(
      <AppointmentQuickStatusButton
        appointmentId="appointment-1"
        status="COMPLETED"
        completedFromStatus="PENDING"
      />,
    );

    const button = screen.getByRole("button", { name: "Completed — click to restore pending" });
    await user.click(button);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This appointment can no longer be reverted because protected result data is linked to it.",
    );
    expect(button).toBeEnabled();
    expect(button).toHaveTextContent("Completed — click to restore pending");
    expect(button).toHaveClass("bg-emerald-100");
    expect(refresh).not.toHaveBeenCalled();

    await user.click(button);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it("disables a completed appointment whose restoration history is unavailable", () => {
    render(
      <AppointmentQuickStatusButton
        appointmentId="appointment-1"
        status="COMPLETED"
        completedFromStatus={null}
      />,
    );

    expect(screen.getByRole("button", {
      name: "Completed — previous status unavailable",
    })).toBeDisabled();
  });
});
