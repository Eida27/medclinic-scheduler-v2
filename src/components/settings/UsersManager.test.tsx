import { render, screen, waitFor, within } from "@testing-library/react";
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

    expect(screen.getAllByText("Schedule Coordinator")[0]).toBeVisible();
    expect(screen.getByText("Coordinator", { selector: "td" })).toBeVisible();
    expect(screen.getByText("Global", { selector: "td" })).toBeVisible();
  });

  async function fillValidUser(user: ReturnType<typeof userEvent.setup>) {
    await user.type(screen.getByLabelText("Full name"), "New User");
    await user.type(screen.getByLabelText("Email"), "new.user@example.com");
    await user.type(screen.getByLabelText("Temporary password"), "Secure123!");
    await user.type(screen.getByLabelText("Confirm temporary password"), "Secure123!");
  }

  async function submitValidUser(user: ReturnType<typeof userEvent.setup>) {
    await fillValidUser(user);
    await user.click(screen.getByRole("button", { name: "Add user" }));
  }

  it("offers only named clinics and defaults clinic staff to KABALAKA", () => {
    render(<UsersManager users={[]} />);

    const clinic = screen.getByLabelText("Clinic");
    expect(clinic).toBeEnabled();
    expect(clinic).toHaveValue("KABALAKA_CLINIC");
    expect(within(clinic).getByRole("option", { name: "KABALAKA Clinic" })).toHaveValue("KABALAKA_CLINIC");
    expect(within(clinic).getByRole("option", { name: "CPU Clinic" })).toHaveValue("CPU_CLINIC");
    expect(within(clinic).queryByRole("option", { name: "Global" })).not.toBeInTheDocument();
  });

  it.each([
    ["KABALAKA_CLINIC", "KABALAKA Clinic"],
    ["CPU_CLINIC", "CPU Clinic"],
  ])("submits %s for a clinic staff account", async (clinicCode, clinicName) => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: {} }) });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<UsersManager users={[]} />);

    if (clinicCode === "CPU_CLINIC") {
      await user.selectOptions(screen.getByLabelText("Clinic"), clinicName);
    }
    await submitValidUser(user);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const [, request] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(request.body))).toMatchObject({
      fullName: "New User",
      email: "new.user@example.com",
      role: "CLINIC_STAFF",
      clinicCode,
    });
  });

  it.each(["COORDINATOR", "ADMIN"])("forces %s account creation to global clinic access", async (role) => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: {} }) });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<UsersManager users={[]} />);

    await user.selectOptions(screen.getByLabelText("Role"), role);

    expect(screen.getByLabelText("Clinic")).toBeDisabled();
    expect(screen.getByLabelText("Clinic")).toHaveValue("");
    expect(within(screen.getByLabelText("Clinic")).getByRole("option", { name: "Global" })).toHaveValue("");
    await submitValidUser(user);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const [, request] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(request.body))).toMatchObject({
      fullName: "New User",
      email: "new.user@example.com",
      role,
      clinicCode: "",
    });
    expect(refresh).toHaveBeenCalledOnce();
  });

  it.each([
    ["COORDINATOR", "Coordinator"],
    ["ADMIN", "Administrator"],
  ])("restores a valid clinic staff scope after switching from %s", async (role) => {
    const user = userEvent.setup();
    render(<UsersManager users={[]} />);

    await user.selectOptions(screen.getByLabelText("Role"), role);
    await user.selectOptions(screen.getByLabelText("Role"), "CLINIC_STAFF");

    const clinic = screen.getByLabelText("Clinic");
    expect(clinic).toBeEnabled();
    expect(clinic).toHaveValue("KABALAKA_CLINIC");
    expect(within(clinic).queryByRole("option", { name: "Global" })).not.toBeInTheDocument();
  });

  it.each([
    [
      "uses the clinic error before other field errors",
      { clinicCode: ["Clinic staff must be assigned to a clinic."], email: ["Email is invalid."] },
      "Clinic staff must be assigned to a clinic.",
    ],
    [
      "uses the full name error before email, password, and role errors",
      { fullName: ["Full name is required."], email: ["Email is invalid."], password: ["Password is too short."], role: ["Role is invalid."] },
      "Full name is required.",
    ],
    [
      "uses the email error before password and role errors",
      { email: ["Email is invalid."], password: ["Password is too short."], role: ["Role is invalid."] },
      "Email is invalid.",
    ],
    [
      "uses the password error before the role error",
      { password: ["Password is too short."], role: ["Role is invalid."] },
      "Password is too short.",
    ],
    ["uses the role error when it is the only field error", { role: ["Role is invalid."] }, "Role is invalid."],
  ])("%s", async (_name, fields, expectedMessage) => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({
        error: {
          code: "VALIDATION_ERROR",
          message: "Please correct the highlighted fields.",
          fields,
        },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<UsersManager users={[]} />);

    await submitValidUser(user);

    expect(await screen.findByText(expectedMessage)).toBeVisible();
  });

  it("preserves a top-level duplicate email error", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({ error: { message: "That email address is already in use." } }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<UsersManager users={[]} />);

    await submitValidUser(user);

    expect(await screen.findByText("That email address is already in use.")).toBeVisible();
  });

  it("falls back to a generic user creation error without an API message", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<UsersManager users={[]} />);

    await submitValidUser(user);

    expect(await screen.findByText("Unable to add user.")).toBeVisible();
  });
});
