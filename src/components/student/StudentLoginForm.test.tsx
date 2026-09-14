import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { StudentLoginForm } from "./StudentLoginForm";

const replace = vi.fn();
const refresh = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, refresh }),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

describe("StudentLoginForm", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    replace.mockReset();
    refresh.mockReset();
  });

  it("renders the required plain-text Middle Name after Date of Birth", () => {
    render(<StudentLoginForm />);

    const form = screen.getByRole("button", { name: "Student sign in" }).closest("form");
    const inputs = Array.from(form?.querySelectorAll("input") ?? []);
    expect(inputs.map((input) => input.name)).toEqual([
      "studentNumber",
      "dateOfBirth",
      "middleName",
    ]);
    expect(screen.getByLabelText("Middle Name")).toHaveAttribute("type", "text");
    expect(screen.getByLabelText("Middle Name")).toHaveAttribute("autocomplete", "additional-name");
    expect(screen.getByLabelText("Middle Name")).toHaveAttribute("maxlength", "100");
    expect(screen.getByLabelText("Middle Name")).toBeRequired();
  });

  it("submits the untouched Middle Name and keeps the pending state until completion", async () => {
    const request = deferred<{
      ok: boolean;
      json: () => Promise<{ data: { studentNumber: string; sessionType: "STUDENT" } }>;
    }>();
    const fetchMock = vi.fn().mockReturnValue(request.promise);
    vi.stubGlobal("fetch", fetchMock);
    render(<StudentLoginForm />);

    fireEvent.change(screen.getByLabelText("Student Number"), {
      target: { value: "23-1212-97" },
    });
    fireEvent.change(screen.getByLabelText("Date of Birth"), {
      target: { value: "2004-08-04" },
    });
    fireEvent.change(screen.getByLabelText("Middle Name"), {
      target: { value: " Maria  Angela " },
    });
    fireEvent.submit(screen.getByRole("button", { name: "Student sign in" }).closest("form")!);

    expect(screen.getByRole("button", { name: "Signing in..." })).toBeDisabled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toEqual({
      studentNumber: "23-1212-97",
      dateOfBirth: "2004-08-04",
      middleName: " Maria  Angela ",
    });

    request.resolve({
      ok: true,
      json: async () => ({
        data: { studentNumber: "23-1212-97", sessionType: "STUDENT" },
      }),
    });
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/student"));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("shows the generic credential error returned by the API", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({
        error: { message: "Invalid Student Number, Date of Birth, or Middle Name." },
      }),
    }));
    render(<StudentLoginForm />);

    fireEvent.change(screen.getByLabelText("Student Number"), {
      target: { value: "23-1212-97" },
    });
    fireEvent.change(screen.getByLabelText("Date of Birth"), {
      target: { value: "2004-08-04" },
    });
    fireEvent.change(screen.getByLabelText("Middle Name"), {
      target: { value: "Wrong" },
    });
    fireEvent.submit(screen.getByRole("button", { name: "Student sign in" }).closest("form")!);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Invalid Student Number, Date of Birth, or Middle Name.",
    );
    expect(screen.getByRole("button", { name: "Student sign in" })).toBeEnabled();
  });

  it.each([400, 500])("shows a JSON API error for HTTP %s and preserves credentials", async (status) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: { message: `Student ${status} response.` },
    }), { status, headers: { "content-type": "application/json" } })));
    render(<StudentLoginForm />);
    fireEvent.change(screen.getByLabelText("Student Number"), { target: { value: "23-1212-97" } });
    fireEvent.change(screen.getByLabelText("Date of Birth"), { target: { value: "2004-08-04" } });
    fireEvent.change(screen.getByLabelText("Middle Name"), { target: { value: "Maria Angela" } });
    fireEvent.submit(screen.getByRole("button", { name: "Student sign in" }).closest("form")!);

    expect(await screen.findByRole("alert")).toHaveTextContent(`Student ${status} response.`);
    expect(screen.getByLabelText("Middle Name")).toHaveValue("Maria Angela");
    expect(screen.getByRole("button", { name: "Student sign in" })).toBeEnabled();
  });

  it.each([
    ["an HTML gateway response", () => Promise.resolve(new Response("Bad gateway", { status: 502 }))],
    ["a rejected fetch", () => Promise.reject(new TypeError("network down"))],
  ])("shows actionable feedback for %s", async (_label, result) => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(result));
    render(<StudentLoginForm />);
    fireEvent.change(screen.getByLabelText("Student Number"), { target: { value: "23-1212-97" } });
    fireEvent.change(screen.getByLabelText("Date of Birth"), { target: { value: "2004-08-04" } });
    fireEvent.change(screen.getByLabelText("Middle Name"), { target: { value: "Maria Angela" } });
    fireEvent.submit(screen.getByRole("button", { name: "Student sign in" }).closest("form")!);

    expect(await screen.findByRole("alert")).toHaveTextContent(/check your connection and try again/i);
    expect(screen.getByRole("button", { name: "Student sign in" })).toBeEnabled();
  });

  it("blocks duplicate submissions synchronously", async () => {
    const request = deferred<Response>();
    const fetchMock = vi.fn().mockReturnValue(request.promise);
    vi.stubGlobal("fetch", fetchMock);
    render(<StudentLoginForm />);
    fireEvent.change(screen.getByLabelText("Student Number"), { target: { value: "23-1212-97" } });
    fireEvent.change(screen.getByLabelText("Date of Birth"), { target: { value: "2004-08-04" } });
    fireEvent.change(screen.getByLabelText("Middle Name"), { target: { value: "Maria Angela" } });
    const form = screen.getByRole("button", { name: "Student sign in" }).closest("form")!;

    fireEvent.submit(form);
    fireEvent.submit(form);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    request.resolve(new Response(JSON.stringify({ data: {} }), { status: 200 }));
    await waitFor(() => expect(replace).toHaveBeenCalledOnce());
  });
});
