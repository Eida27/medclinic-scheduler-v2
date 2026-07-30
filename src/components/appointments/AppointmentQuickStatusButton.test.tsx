import { act, render, screen, waitFor } from "@testing-library/react";
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

function deferredResponse() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("AppointmentQuickStatusButton", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    {
      status: "PENDING" as const,
      completedFromStatus: null,
      visibleLabel: "Pending",
      accessibleLabel: "Pending — click to mark completed",
      toneClasses: ["bg-slate-600", "enabled:hover:bg-slate-700", "focus-visible:outline-slate-600"],
    },
    {
      status: "COMPLETED" as const,
      completedFromStatus: "PENDING" as const,
      visibleLabel: "Completed",
      accessibleLabel: "Completed — click to restore pending",
      toneClasses: ["bg-emerald-700", "enabled:hover:bg-emerald-800", "focus-visible:outline-emerald-700"],
    },
    {
      status: "COMPLETED" as const,
      completedFromStatus: "NO_SHOW" as const,
      visibleLabel: "Completed",
      accessibleLabel: "Completed — click to restore no-show",
      toneClasses: ["bg-emerald-700", "enabled:hover:bg-emerald-800", "focus-visible:outline-emerald-700"],
    },
    {
      status: "NO_SHOW" as const,
      completedFromStatus: null,
      visibleLabel: "No-show",
      accessibleLabel: "No-show — click to correct as completed",
      toneClasses: ["bg-red-600", "enabled:hover:bg-red-700", "focus-visible:outline-red-600"],
    },
  ])("renders only the $visibleLabel status with its full accessible action", (scenario) => {
    render(
      <AppointmentQuickStatusButton
        appointmentId="appointment-1"
        status={scenario.status}
        completedFromStatus={scenario.completedFromStatus}
      />,
    );

    const button = screen.getByRole("button", { name: scenario.accessibleLabel });
    expect(button).toHaveTextContent(new RegExp(`^${scenario.visibleLabel}$`));
    expect(button).toHaveAttribute("aria-label", scenario.accessibleLabel);
    expect(button).toHaveClass("text-white", ...scenario.toneClasses);
    expect(button.className).not.toMatch(/(?<!enabled:)hover:bg-/);
  });

  it("uses the shared compact pill, restrained interaction, and clipped shine classes", () => {
    render(
      <AppointmentQuickStatusButton
        appointmentId="appointment-1"
        status="PENDING"
        completedFromStatus={null}
      />,
    );

    expect(screen.getByRole("button", { name: "Pending — click to mark completed" })).toHaveClass(
      "relative",
      "min-h-9",
      "w-fit",
      "overflow-hidden",
      "rounded-full",
      "shadow-sm",
      "transition-[background-color,box-shadow,transform]",
      "duration-150",
      "enabled:cursor-pointer",
      "enabled:hover:shadow-md",
      "enabled:focus-visible:shadow-md",
      "motion-safe:enabled:hover:-translate-y-px",
      "motion-safe:enabled:hover:scale-[1.02]",
      "motion-safe:enabled:focus-visible:-translate-y-px",
      "motion-safe:enabled:focus-visible:scale-[1.02]",
      "before:pointer-events-none",
      "before:absolute",
      "before:inset-y-0",
      "before:-left-1/2",
      "before:bg-linear-to-r",
      "before:via-white/35",
      "before:content-['']",
      "motion-safe:enabled:hover:before:translate-x-[500%]",
      "motion-safe:enabled:hover:before:transition-transform",
      "motion-safe:enabled:focus-visible:before:translate-x-[500%]",
      "motion-safe:enabled:focus-visible:before:transition-transform",
    );
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
    expect(button).toHaveTextContent(/^Pending$/);
    expect(button).toHaveClass("bg-slate-600");
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

  it("synchronously locks a direct action against two activations in the same act", async () => {
    const request = deferredResponse();
    const fetchMock = vi.fn().mockReturnValue(request.promise);
    vi.stubGlobal("fetch", fetchMock);
    render(
      <AppointmentQuickStatusButton
        appointmentId="appointment-1"
        status="PENDING"
        completedFromStatus={null}
      />,
    );

    const button = screen.getByRole("button", { name: "Pending — click to mark completed" });
    act(() => {
      button.click();
      button.click();
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(button).toHaveTextContent("Updating...");
    expect(button).toHaveAccessibleName("Updating appointment status");
    expect(button).toHaveClass("bg-slate-600");
    const spinner = button.querySelector('[aria-hidden="true"]');
    expect(spinner).toHaveClass("motion-safe:animate-spin");
    expect(spinner).not.toHaveAttribute("aria-label");

    request.resolve(jsonResponse({ data: { status: "COMPLETED" } }));
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
  });

  it("keeps a successful direct action locked through refreshes with unchanged props", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: { status: "COMPLETED" } }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    const { rerender } = render(
      <AppointmentQuickStatusButton
        appointmentId="appointment-1"
        status="PENDING"
        completedFromStatus={null}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Pending — click to mark completed" }));
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());

    expect(screen.getByRole("button", { name: "Updating appointment status" })).toBeDisabled();
    rerender(
      <AppointmentQuickStatusButton
        appointmentId="appointment-1"
        status="PENDING"
        completedFromStatus={null}
      />,
    );
    expect(screen.getByRole("button", { name: "Updating appointment status" })).toBeDisabled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("releases a successful lock only when authoritative status props change", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: { status: "COMPLETED" } }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    const { rerender } = render(
      <AppointmentQuickStatusButton
        appointmentId="appointment-1"
        status="PENDING"
        completedFromStatus={null}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Pending — click to mark completed" }));
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    rerender(
      <AppointmentQuickStatusButton
        appointmentId="appointment-1"
        status="COMPLETED"
        completedFromStatus="PENDING"
      />,
    );

    const restoredAction = screen.getByRole("button", { name: "Completed — click to restore pending" });
    expect(restoredAction).toBeEnabled();
    expect(restoredAction).toHaveTextContent(/^Completed$/);
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
    expect(button).toHaveTextContent(/^Completed$/);
    expect(button).toHaveClass("bg-emerald-700");
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
    expect(button).toHaveTextContent(/^No-show$/);
    expect(button).toHaveClass("bg-red-600");
    await user.click(button);

    expect(screen.getByRole("dialog", { name: "Correct no-show as completed?" })).toBeVisible();
    expect(screen.getAllByRole("button").map((item) => item.textContent)).toEqual([
      "No-show",
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

  it("synchronously locks a confirmed action against two activations in the same act", async () => {
    const request = deferredResponse();
    const fetchMock = vi.fn().mockReturnValue(request.promise);
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(
      <AppointmentQuickStatusButton
        appointmentId="appointment-1"
        status="NO_SHOW"
        completedFromStatus={null}
      />,
    );

    await user.click(screen.getByRole("button", { name: "No-show — click to correct as completed" }));
    const confirmButton = screen.getByRole("button", { name: "Mark as completed" });
    act(() => {
      confirmButton.click();
      confirmButton.click();
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("dialog", { name: "Correct no-show as completed?" })).toHaveAttribute(
      "aria-busy",
      "true",
    );

    request.resolve(jsonResponse({ data: { status: "COMPLETED" } }));
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
  });

  it("does not let an old request overwrite or unlock the same keyed row after it is reused", async () => {
    const oldRequest = deferredResponse();
    const currentRequest = deferredResponse();
    const fetchMock = vi.fn()
      .mockReturnValueOnce(oldRequest.promise)
      .mockReturnValueOnce(currentRequest.promise);
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    const { rerender } = render(
      <AppointmentQuickStatusButton
        appointmentId="appointment-1"
        status="PENDING"
        completedFromStatus={null}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Pending — click to mark completed" }));
    rerender(
      <AppointmentQuickStatusButton
        appointmentId="appointment-2"
        status="PENDING"
        completedFromStatus={null}
      />,
    );
    rerender(
      <AppointmentQuickStatusButton
        appointmentId="appointment-1"
        status="PENDING"
        completedFromStatus={null}
      />,
    );

    const reusedButton = screen.getByRole("button", { name: "Pending — click to mark completed" });
    expect(reusedButton).toBeEnabled();
    await user.click(reusedButton);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    oldRequest.resolve(jsonResponse({ error: { message: "Old row failure" } }, 409));
    await act(async () => {
      await oldRequest.promise;
    });

    expect(screen.queryByText("Old row failure")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Updating appointment status" })).toBeDisabled();

    currentRequest.resolve(jsonResponse({ data: { status: "COMPLETED" } }));
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
  });

  it("ignores an old successful request after an A to B to A row reuse", async () => {
    const oldRequest = deferredResponse();
    const currentRequest = deferredResponse();
    const fetchMock = vi.fn()
      .mockReturnValueOnce(oldRequest.promise)
      .mockReturnValueOnce(currentRequest.promise);
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    const { rerender } = render(
      <AppointmentQuickStatusButton
        appointmentId="appointment-1"
        status="PENDING"
        completedFromStatus={null}
      />,
    );

    await user.click(screen.getByRole("button", { name: /Pending.*click to mark completed/ }));
    rerender(
      <AppointmentQuickStatusButton
        appointmentId="appointment-2"
        status="PENDING"
        completedFromStatus={null}
      />,
    );
    rerender(
      <AppointmentQuickStatusButton
        appointmentId="appointment-1"
        status="PENDING"
        completedFromStatus={null}
      />,
    );

    await user.click(screen.getByRole("button", { name: /Pending.*click to mark completed/ }));
    expect(fetchMock).toHaveBeenCalledTimes(2);

    oldRequest.resolve(jsonResponse({ data: { status: "COMPLETED" } }));
    await act(async () => {
      await oldRequest.promise;
    });

    expect(refresh).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Updating appointment status" })).toBeDisabled();

    currentRequest.resolve(jsonResponse({ data: { status: "COMPLETED" } }));
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
    expect(button).toHaveTextContent(/^Completed$/);
    expect(button).toHaveClass("bg-emerald-700");
    expect(refresh).not.toHaveBeenCalled();

    await user.click(button);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it("unlocks after a network failure, preserves the connection message, and allows retry", async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockResolvedValueOnce(jsonResponse({ data: { status: "COMPLETED" } }));
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

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Unable to update the appointment status. Check your connection and try again.",
    );
    expect(button).toBeEnabled();

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

    const button = screen.getByRole("button", {
      name: "Completed — previous status unavailable",
    });
    expect(button).toBeDisabled();
    expect(button).toHaveTextContent(/^Completed$/);
    expect(button).toHaveAttribute("aria-label", "Completed — previous status unavailable");
  });
});
