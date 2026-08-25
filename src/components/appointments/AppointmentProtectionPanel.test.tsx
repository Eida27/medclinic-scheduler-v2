import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

import { AppointmentProtectionPanel } from "./AppointmentProtectionPanel";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const baseProps = {
  appointmentId: "appointment-1",
  status: "PENDING",
  isManuallyLocked: false,
  lockReason: null,
  lockedByName: null,
  lockedAt: null,
  updatedAt: "2026-08-01T00:00:00.000Z",
  canManage: true,
};

describe("AppointmentProtectionPanel", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it("confirms a validated lock and submits the optimistic timestamp", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: { id: "appointment-1" } }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<AppointmentProtectionPanel {...baseProps} />);

    await user.type(
      screen.getByLabelText("Appointment protection reason"),
      "Protect while reviewing uploaded records",
    );
    await user.click(screen.getByRole("button", { name: "Lock appointment" }));
    expect(screen.getByRole("dialog")).toBeVisible();
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Lock appointment" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/appointments/appointment-1",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({
          lockAction: "LOCK",
          lockReason: "Protect while reviewing uploaded records",
          expectedUpdatedAt: "2026-08-01T00:00:00.000Z",
        }),
      }),
    ));
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("preserves the typed reason and shows stale errors in the open dialog", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({
      error: { code: "APPOINTMENT_STALE", message: "The appointment changed. Refresh and try again." },
    }, 409)));
    const user = userEvent.setup();
    render(<AppointmentProtectionPanel {...baseProps} />);

    const reason = screen.getByLabelText("Appointment protection reason");
    await user.type(reason, "Keep this reason after a conflict");
    await user.click(screen.getByRole("button", { name: "Lock appointment" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Lock appointment" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("The appointment changed");
    expect(screen.getByRole("dialog")).toBeVisible();
    expect(reason).toHaveValue("Keep this reason after a conflict");
  });

  it("shows protection details read-only to clinic staff", () => {
    render(<AppointmentProtectionPanel
      {...baseProps}
      canManage={false}
      isManuallyLocked
      lockReason="Administrator review in progress"
      lockedByName="System Admin"
      lockedAt="2026-08-01T02:30:00.000Z"
    />);

    expect(screen.getByText("Administrator review in progress")).toBeVisible();
    expect(screen.getByText(/System Admin/)).toBeVisible();
    expect(screen.queryByRole("button", { name: /protection/i })).not.toBeInTheDocument();
  });

  it("marks a tombstoned staff member in historical protection attribution", () => {
    render(<AppointmentProtectionPanel
      {...baseProps}
      canManage={false}
      isManuallyLocked
      lockReason="Administrator review in progress"
      lockedByName="Former Administrator"
      lockedBy={{ fullName: "Former Administrator", role: "ADMIN", deleted: true }}
      lockedAt="2026-08-01T02:30:00.000Z"
    />);

    expect(screen.getByText("Former Administrator")).toBeVisible();
    expect(screen.getByText("Deleted")).toBeVisible();
  });

  it("allows an administrator to remove an inherited lock from a historical status", () => {
    render(<AppointmentProtectionPanel
      {...baseProps}
      status="COMPLETED"
      isManuallyLocked
      lockReason="Inherited protection"
      lockedByName="Clinic Staff"
      lockedAt="2026-08-01T02:30:00.000Z"
    />);

    expect(screen.getByText("Previously locked")).toBeVisible();
    expect(screen.getByRole("button", { name: "Unlock appointment" })).toBeEnabled();
    expect(screen.queryByLabelText("Appointment protection reason")).not.toBeInTheDocument();
  });
});
