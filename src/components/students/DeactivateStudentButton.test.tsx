import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DeactivateStudentButton } from "./DeactivateStudentButton";

const push = vi.fn();
const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, refresh }) }));

function openDialog() {
  fireEvent.click(screen.getByRole("button", { name: "Deactivate" }));
  return screen.getByRole("button", { name: "Deactivate student" });
}

describe("DeactivateStudentButton", () => {
  beforeEach(() => { vi.restoreAllMocks(); push.mockReset(); refresh.mockReset(); });

  it("closes and navigates after a successful deactivation", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: { success: true } }), { status: 200 })));
    render(<DeactivateStudentButton studentNumber="24-1000-01" />);
    fireEvent.click(openDialog());
    await waitFor(() => expect(push).toHaveBeenCalledWith("/students"));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it.each([400, 500])("shows a JSON API error for HTTP %s and permits retry", async (status) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { message: `Deactivate ${status}.` } }), { status })));
    render(<DeactivateStudentButton studentNumber="24-1000-01" />);
    fireEvent.click(openDialog());
    expect(await screen.findByRole("alert")).toHaveTextContent(`Deactivate ${status}.`);
    expect(screen.getByRole("button", { name: "Deactivate student" })).toBeEnabled();
  });

  it.each([
    ["an HTML gateway response", () => Promise.resolve(new Response("Bad gateway", { status: 502 }))],
    ["a rejected fetch", () => Promise.reject(new TypeError("network down"))],
  ])("shows actionable feedback for %s", async (_label, result) => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(result));
    render(<DeactivateStudentButton studentNumber="24-1000-01" />);
    fireEvent.click(openDialog());
    expect(await screen.findByRole("alert")).toHaveTextContent(/check your connection and try again/i);
    expect(screen.getByRole("button", { name: "Deactivate student" })).toBeEnabled();
  });

  it("blocks duplicate deactivation synchronously", async () => {
    let resolve!: (value: Response) => void;
    const pending = new Promise<Response>((done) => { resolve = done; });
    const fetchMock = vi.fn().mockReturnValue(pending);
    vi.stubGlobal("fetch", fetchMock);
    render(<DeactivateStudentButton studentNumber="24-1000-01" />);
    const confirm = openDialog();
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    resolve(new Response(JSON.stringify({ data: { success: true } }), { status: 200 }));
    await waitFor(() => expect(push).toHaveBeenCalledOnce());
  });
});
