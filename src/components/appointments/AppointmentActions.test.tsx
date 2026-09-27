import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { push, refresh } = vi.hoisted(() => ({
  push: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, refresh }),
}));

import type { ComponentProps } from "react";
import { AppointmentActions as LiveAppointmentActions } from "./AppointmentActions";

function AppointmentActions(
  props: Omit<ComponentProps<typeof LiveAppointmentActions>, "basePath">
    & Partial<Pick<ComponentProps<typeof LiveAppointmentActions>, "basePath">>,
) {
  return <LiveAppointmentActions basePath="/laboratory" {...props} />;
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("AppointmentActions cancellation and replacement", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not offer manual no-show for a pending appointment", () => {
    render(<AppointmentActions id="appointment-1" status="PENDING" />);

    expect(screen.getByRole("button", { name: "Cancel appointment" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Create replacement" })).toBeVisible();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /complet|no-show/i })).not.toBeInTheDocument();
  });

  it("offers only cancellation for a draft appointment", () => {
    render(<AppointmentActions id="appointment-1" status="DRAFT" />);

    expect(screen.getByRole("button", { name: "Cancel appointment" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Create replacement" })).not.toBeInTheDocument();
  });

  it("does not place completed-status corrections in ordinary actions", () => {
    render(<AppointmentActions id="appointment-1" status="COMPLETED" />);

    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Correction reason")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("offers replacement but no clinical completion for a no-show", () => {
    render(
      <AppointmentActions
        id="appointment-1"
        status="NO_SHOW"
        canCorrectNoShow
      />,
    );

    expect(screen.getByRole("button", { name: "Create replacement" })).toBeVisible();
    expect(screen.queryByRole("button", { name: /complete/i })).not.toBeInTheDocument();
  });

  it.each([
    { status: "NO_SHOW", canCorrectNoShow: false },
    { status: "PENDING", canCorrectNoShow: true },
    { status: "COMPLETED", canCorrectNoShow: true },
  ])("hides the correction form for %o", ({ status, canCorrectNoShow }) => {
    render(
      <AppointmentActions
        id="appointment-1"
        status={status}
        canCorrectNoShow={canCorrectNoShow}
      />,
    );

    expect(screen.queryByRole("button", { name: "Correct to completed" })).not.toBeInTheDocument();
  });

  it("warns about lock inheritance and navigates to the replacement detail", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      data: { id: "replacement-2", status: "PENDING" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(
      <AppointmentActions
        id="appointment-1"
        status="PENDING"
        isManuallyLocked
        basePath="/laboratory"
      />,
    );

    expect(screen.getByText(/protection will transfer to the replacement/)).toBeVisible();
    await user.type(screen.getByLabelText("Replacement appointment date"), "2026-08-24");
    await user.type(screen.getByLabelText("Reason for rescheduling"), "Clinic selected a safe date");
    await user.click(screen.getByRole("button", { name: "Create replacement" }));

    await waitFor(() => expect(push).toHaveBeenCalledWith("/laboratory/replacement-2"));
    expect(refresh).not.toHaveBeenCalled();
  });

  it("keeps physical-exam replacement navigation in the physical-exam workflow", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      data: { id: "replacement-physical", status: "PENDING" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(
      <AppointmentActions
        id="appointment-physical"
        status="PENDING"
        basePath="/physical-exam"
      />,
    );

    await user.type(screen.getByLabelText("Replacement appointment date"), "2026-08-25");
    await user.type(screen.getByLabelText("Reason for rescheduling"), "Physical clinic follow-up");
    await user.click(screen.getByRole("button", { name: "Create replacement" }));

    await waitFor(() => expect(push).toHaveBeenCalledWith("/physical-exam/replacement-physical"));
    expect(refresh).not.toHaveBeenCalled();
  });

  it("sends the appointment version with a manual reschedule when one is available", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      data: { id: "replacement-3", status: "PENDING" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(
      <AppointmentActions
        id="appointment-3"
        status="PENDING"
        updatedAt="2094-09-01T01:02:03.000Z"
      />,
    );

    await user.type(screen.getByLabelText("Replacement appointment date"), "2094-09-12");
    await user.type(screen.getByLabelText("Reason for rescheduling"), "Student requested a safe date");
    await user.click(screen.getByRole("button", { name: "Create replacement" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/appointments/appointment-3",
      expect.objectContaining({
        body: JSON.stringify({
          appointmentDate: "2094-09-12",
          notes: "Student requested a safe date",
          expectedUpdatedAt: "2094-09-01T01:02:03.000Z",
        }),
      }),
    ));
  });

  it.each([400, 500])("shows a JSON API error for HTTP %s and restores the action", async (status) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({
      error: { message: `Appointment ${status}.` },
    }, status)));
    const user = userEvent.setup();
    render(<AppointmentActions id="appointment-1" status="PENDING" />);
    await user.type(screen.getByPlaceholderText("Status note"), "Keep this note");
    await user.click(screen.getByRole("button", { name: "Cancel appointment" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(`Appointment ${status}.`);
    expect(screen.getByPlaceholderText("Status note")).toHaveValue("Keep this note");
    expect(screen.getByRole("button", { name: "Cancel appointment" })).toBeEnabled();
  });

  it.each([
    ["an HTML gateway response", () => Promise.resolve(new Response("Bad gateway", { status: 502 }))],
    ["a rejected fetch", () => Promise.reject(new TypeError("network down"))],
  ])("shows actionable feedback for %s", async (_label, result) => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(result));
    const user = userEvent.setup();
    render(<AppointmentActions id="appointment-1" status="PENDING" />);
    await user.click(screen.getByRole("button", { name: "Cancel appointment" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/check your connection and try again/i);
    expect(screen.getByRole("button", { name: "Cancel appointment" })).toBeEnabled();
  });

  it("blocks duplicate appointment mutations synchronously", async () => {
    let resolve!: (value: Response) => void;
    const pending = new Promise<Response>((done) => { resolve = done; });
    const fetchMock = vi.fn().mockReturnValue(pending);
    vi.stubGlobal("fetch", fetchMock);
    render(<AppointmentActions id="appointment-1" status="PENDING" />);
    const form = screen.getByRole("button", { name: "Cancel appointment" }).closest("form")!;

    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    resolve(jsonResponse({ data: { id: "appointment-1" } }));
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
  });
});
