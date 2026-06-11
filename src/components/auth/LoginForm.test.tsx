import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LoginForm } from "./LoginForm";

const replace = vi.fn();
const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace, refresh }) }));

describe("LoginForm", () => {
  beforeEach(() => { vi.restoreAllMocks(); replace.mockReset(); refresh.mockReset(); });

  it("shows the safe API message when credentials are rejected", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, json: async () => ({ error: { message: "Invalid email or password." } }) }));
    render(<LoginForm />);
    fireEvent.change(screen.getByLabelText("Email address"), { target: { value: "admin@medclinic.local" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "wrong" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Invalid email or password.");
  });

  it("navigates to the dashboard after successful authentication", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: {} }) }));
    render(<LoginForm />);
    fireEvent.change(screen.getByLabelText("Email address"), { target: { value: "admin@medclinic.local" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "Admin123!" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/dashboard"));
  });
});
