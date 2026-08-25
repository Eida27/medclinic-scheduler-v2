import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { UsersManager } from "./UsersManager";

const refresh = vi.fn();
const replace = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh, replace }) }));

const users = [
  { id: "pending", fullName: "Pending User", email: "pending@example.test", role: "COORDINATOR" as const, clinicCode: null, clinicName: null, status: "PENDING_VERIFICATION" as const },
  { id: "password", fullName: "Password User", email: "password@example.test", role: "CLINIC_STAFF" as const, clinicCode: "CPU_CLINIC", clinicName: "CPU Clinic", status: "PASSWORD_CHANGE_REQUIRED" as const },
  { id: "active", fullName: "Active User", email: "active@example.test", role: "ADMIN" as const, clinicCode: null, clinicName: null, status: "ACTIVE" as const },
];

beforeEach(() => {
  vi.restoreAllMocks();
  refresh.mockReset();
  replace.mockReset();
});

describe("UsersManager staff security lifecycle", () => {
  it("renders lifecycle badges and approved actions without Activate or Deactivate", () => {
    render(<UsersManager users={users} currentUserId="active" />);
    expect(screen.getAllByText("Pending verification").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Password change required").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Active").length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: /activate|deactivate/i })).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Edit email" }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: "Reset temporary password" }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: "Delete" }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: "Resend verification" }).length).toBeGreaterThan(0);
  });

  it("uses the destructive confirmation pattern with explicit Delete account wording", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: { deleted: true } }) });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<UsersManager users={[users[0]]} currentUserId="active" />);
    await user.click(screen.getAllByRole("button", { name: "Delete" })[0]);
    const dialog = screen.getByRole("dialog", { name: "Delete Pending User?" });
    expect(dialog).toBeVisible();
    expect(within(dialog).getByText(/historical records remain/i)).toBeVisible();
    expect(within(dialog).getByText(/pending@example\.test/)).toBeVisible();
    expect(within(dialog).getByText(/Coordinator/)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Delete account" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/users/pending",
      expect.objectContaining({ method: "DELETE" }),
    ));
  });

  it("submits matching temporary-password fields for a new pending account", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: {} }) });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<UsersManager users={[]} currentUserId="active" />);
    await user.type(screen.getByLabelText("Full name"), "New Coordinator");
    await user.type(screen.getByLabelText("Email"), "new@example.test");
    await user.type(screen.getByLabelText("Temporary password"), "Temporary123!");
    await user.type(screen.getByLabelText("Confirm temporary password"), "Temporary123!");
    await user.selectOptions(screen.getByLabelText("Role"), "COORDINATOR");
    await user.click(screen.getByRole("button", { name: "Add user" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [, request] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(request.body))).toMatchObject({
      temporaryPassword: "Temporary123!",
      confirmTemporaryPassword: "Temporary123!",
      role: "COORDINATOR",
      clinicCode: "",
    });
  });

  it("recovers the create form after a network error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    const user = userEvent.setup();
    render(<UsersManager users={[]} currentUserId="active" />);
    await user.type(screen.getByLabelText("Full name"), "New Coordinator");
    await user.type(screen.getByLabelText("Email"), "new@example.test");
    await user.type(screen.getByLabelText("Temporary password"), "Temporary123!");
    await user.type(screen.getByLabelText("Confirm temporary password"), "Temporary123!");
    await user.selectOptions(screen.getByLabelText("Role"), "COORDINATOR");
    await user.click(screen.getByRole("button", { name: "Add user" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Unable to add user.");
    expect(screen.getByRole("button", { name: "Add user" })).toBeEnabled();
  });
});
