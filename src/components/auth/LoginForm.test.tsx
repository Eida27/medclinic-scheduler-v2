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

  it.each([400, 500])("shows a JSON API error for HTTP %s and restores the form", async (status) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: { message: `Safe ${status} response.` },
    }), { status, headers: { "content-type": "application/json" } })));
    render(<LoginForm />);
    fireEvent.change(screen.getByLabelText("Email address"), { target: { value: "admin@medclinic.local" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "kept-secret" } });
    const button = screen.getByRole("button", { name: "Sign in" });
    fireEvent.click(button);

    expect(await screen.findByRole("alert")).toHaveTextContent(`Safe ${status} response.`);
    expect(screen.getByLabelText("Email address")).toHaveValue("admin@medclinic.local");
    expect(screen.getByLabelText("Password")).toHaveValue("kept-secret");
    expect(button).toBeEnabled();
  });

  it.each([
    ["an HTML gateway response", () => Promise.resolve(new Response("<h1>Bad gateway</h1>", { status: 502 }))],
    ["a rejected fetch", () => Promise.reject(new TypeError("network down"))],
  ])("shows actionable feedback for %s", async (_label, result) => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(result));
    render(<LoginForm />);
    fireEvent.change(screen.getByLabelText("Email address"), { target: { value: "admin@medclinic.local" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "kept-secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/check your connection and try again/i);
    expect(screen.getByRole("button", { name: "Sign in" })).toBeEnabled();
  });

  it("blocks duplicate submissions synchronously", async () => {
    let resolve!: (response: Response) => void;
    const pendingResponse = new Promise<Response>((done) => { resolve = done; });
    const fetchMock = vi.fn().mockReturnValue(pendingResponse);
    vi.stubGlobal("fetch", fetchMock);
    render(<LoginForm />);
    fireEvent.change(screen.getByLabelText("Email address"), { target: { value: "admin@medclinic.local" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "secret" } });
    const form = screen.getByRole("button", { name: "Sign in" }).closest("form")!;

    fireEvent.submit(form);
    fireEvent.submit(form);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    resolve(new Response(JSON.stringify({ data: {} }), { status: 200 }));
    await waitFor(() => expect(replace).toHaveBeenCalledOnce());
  });
});
