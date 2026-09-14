import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { StudentLogoutButton } from "./StudentLogoutButton";

const replace = vi.fn();
const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace, refresh }) }));

describe("StudentLogoutButton", () => {
  beforeEach(() => { vi.restoreAllMocks(); replace.mockReset(); refresh.mockReset(); });

  it("navigates to student sign in after a successful logout", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: { success: true } }), { status: 200 })));
    render(<StudentLogoutButton />);
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/student/login"));
  });

  it.each([400, 500])("shows a JSON API error for HTTP %s", async (status) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { message: `Student logout ${status}.` } }), { status })));
    render(<StudentLogoutButton />);
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(`Student logout ${status}.`);
    expect(screen.getByRole("button", { name: "Sign out" })).toBeEnabled();
  });

  it.each([
    ["an HTML gateway response", () => Promise.resolve(new Response("Bad gateway", { status: 502 }))],
    ["a rejected fetch", () => Promise.reject(new TypeError("network down"))],
  ])("shows actionable feedback for %s", async (_label, result) => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(result));
    render(<StudentLogoutButton />);
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/check your connection and try again/i);
    expect(screen.getByRole("button", { name: "Sign out" })).toBeEnabled();
  });

  it("blocks duplicate logout synchronously", async () => {
    let resolve!: (value: Response) => void;
    const pending = new Promise<Response>((done) => { resolve = done; });
    const fetchMock = vi.fn().mockReturnValue(pending);
    vi.stubGlobal("fetch", fetchMock);
    render(<StudentLogoutButton />);
    const button = screen.getByRole("button", { name: "Sign out" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    resolve(new Response(JSON.stringify({ data: { success: true } }), { status: 200 }));
    await waitFor(() => expect(replace).toHaveBeenCalledOnce());
  });
});
