import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { UsersManager } from "./UsersManager";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

const coordinator = {
  id: "coordinator-1",
  fullName: "Schedule Coordinator",
  email: "coordinator@medclinic.local",
  role: "COORDINATOR" as const,
  clinicCode: null,
  clinicName: null,
  isActive: true,
};

describe("UsersManager", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    refresh.mockReset();
  });

  it("labels existing coordinator accounts as global", () => {
    render(<UsersManager users={[coordinator]} />);

    expect(screen.getByText("Schedule Coordinator")).toBeVisible();
    expect(screen.getByText("Coordinator", { selector: "td" })).toBeVisible();
    expect(screen.getByText("Global", { selector: "td" })).toBeVisible();
  });

  it("forces coordinator account creation to global clinic access", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: {} }) });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<UsersManager users={[]} />);

    await user.type(screen.getByLabelText("Full name"), "New Coordinator");
    await user.type(screen.getByLabelText("Email"), "new.coordinator@example.com");
    await user.type(screen.getByLabelText("Temporary password"), "Secure123!");
    await user.selectOptions(screen.getByLabelText("Role"), "COORDINATOR");

    expect(screen.getByLabelText("Clinic")).toBeDisabled();
    expect(screen.getByLabelText("Clinic")).toHaveValue("");
    await user.click(screen.getByRole("button", { name: "Add user" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const [, request] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(request.body))).toMatchObject({
      fullName: "New Coordinator",
      email: "new.coordinator@example.com",
      role: "COORDINATOR",
      clinicCode: "",
    });
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("keeps clinic selection available to clinic staff", () => {
    render(<UsersManager users={[]} />);

    expect(screen.getByRole("option", { name: "Coordinator" })).toHaveValue("COORDINATOR");
    expect(screen.getByLabelText("Clinic")).toBeEnabled();
    expect(screen.getByLabelText("Clinic")).toHaveValue("KABALAKA_CLINIC");
  });
});
