import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
}));

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
    expect(screen.getByRole("option", { name: "Completed" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Cancelled" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "No-show" })).not.toBeInTheDocument();
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
});
