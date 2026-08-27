import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { operationalStatusLabel, push, refresh } = vi.hoisted(() => ({
  operationalStatusLabel: vi.fn((value: string) => `Readable ${value}`),
  push: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, refresh }),
}));
vi.mock("@/components/appointments/status-labels", () => ({ operationalStatusLabel }));

import { AppointmentActions } from "./AppointmentActions";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("AppointmentActions automatic no-show correction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not offer manual no-show for a pending appointment", () => {
    render(<AppointmentActions id="appointment-1" status="PENDING" />);

    const status = screen.getByRole("combobox");
    expect(status).toHaveValue("COMPLETED");
    expect(screen.getByRole("option", { name: "Readable COMPLETED" })).toHaveValue("COMPLETED");
    expect(screen.getByRole("option", { name: "Readable CANCELLED" })).toHaveValue("CANCELLED");
    expect(screen.queryByRole("option", { name: "Readable NO_SHOW" })).not.toBeInTheDocument();
  });

  it("uses the shared operational label for a draft cancellation target", () => {
    render(<AppointmentActions id="appointment-1" status="DRAFT" />);

    expect(screen.getByRole("option", { name: "Readable CANCELLED" })).toHaveValue("CANCELLED");
  });

  it("does not place completed-status corrections in ordinary actions", () => {
    render(<AppointmentActions id="appointment-1" status="COMPLETED" />);

    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Correction reason")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("shows a required correction form only for an eligible no-show", () => {
    render(
      <AppointmentActions
        id="appointment-1"
        status="NO_SHOW"
        canCorrectNoShow
      />,
    );

    const button = screen.getByRole("button", { name: "Correct to completed" });
    const form = button.closest("form");
    expect(form).not.toBeNull();
    expect(form).toHaveFormValues({ status: "COMPLETED" });
    expect(screen.getByLabelText("Correction reason")).toBeRequired();
    expect(screen.getByRole("button", { name: "Create replacement" })).toBeVisible();
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

  it("sends completed status and the entered correction reason", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      data: { id: "appointment-1", status: "COMPLETED" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(
      <AppointmentActions
        id="appointment-1"
        status="NO_SHOW"
        canCorrectNoShow
      />,
    );

    await user.type(
      screen.getByLabelText("Correction reason"),
      "Signed clinic record confirms completion",
    );
    await user.click(screen.getByRole("button", { name: "Correct to completed" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/appointments/appointment-1",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          status: "COMPLETED",
          notes: "Signed clinic record confirms completion",
        }),
      },
    ));
    expect(refresh).toHaveBeenCalledOnce();
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
});
