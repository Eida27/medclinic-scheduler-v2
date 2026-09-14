import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { StudentForm } from "./StudentForm";

const push = vi.fn();
const refresh = vi.fn();
const back = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, refresh, back }) }));

const colleges = [{ id: "10000000-0000-4000-8000-000000000003", code: "CCS", name: "Computer Studies", isActive: true }];
const programs = [{ id: "20000000-0000-4000-8000-000000000003", collegeId: colleges[0].id, collegeName: colleges[0].name, code: "BSIT", name: "BSIT", isActive: true }];
const student = {
  studentNumber: "24-1000-01",
  firstName: "Ana",
  middleName: "Maria Angela",
  lastName: "Santos",
  suffix: null,
  collegeId: colleges[0].id,
  programId: programs[0].id,
  yearLevel: 2,
  section: "B",
  dateOfBirth: "2004-08-04",
};

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("StudentForm", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    push.mockReset();
    refresh.mockReset();
    back.mockReset();
  });

  it("requires a middle name without blocking 100 supplementary Unicode characters", async () => {
    const user = userEvent.setup();
    render(<StudentForm colleges={colleges} programs={programs} student={student} />);
    const middleName = screen.getByLabelText("Middle name");

    expect(middleName).toBeRequired();
    await user.clear(middleName);
    await user.type(middleName, ` ${"😀".repeat(100)} `);
    expect(middleName).toHaveValue(` ${"😀".repeat(100)} `);
  });

  it("shows and associates the real middle-name Zod field error while preserving input", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({
      error: {
        code: "VALIDATION_ERROR",
        message: "Please correct the highlighted fields.",
        fields: { middleName: ["Middle name is required."] },
      },
    }, 422)));
    render(<StudentForm colleges={colleges} programs={programs} student={student} />);
    const middleName = screen.getByLabelText("Middle name");
    fireEvent.change(middleName, { target: { value: "   " } });

    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Please correct the highlighted fields.");
    expect(middleName).toHaveValue("   ");
    expect(middleName).toHaveAttribute("aria-invalid", "true");
    expect(middleName).toHaveAccessibleDescription("Middle name is required.");
  });

  it("lets an existing student save twice without reloading and reports each success", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({ data: student }));
    vi.stubGlobal("fetch", fetchMock);
    render(<StudentForm colleges={colleges} programs={programs} student={student} />);
    const button = screen.getByRole("button", { name: "Save changes" });

    fireEvent.click(button);
    expect(await screen.findByRole("alert")).toHaveTextContent("Student changes saved.");
    expect(button).toBeEnabled();
    fireEvent.click(button);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(push).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it.each([400, 500])("shows a JSON API error for HTTP %s and preserves student input", async (status) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ error: { message: `Student save ${status}.` } }, status)));
    render(<StudentForm colleges={colleges} programs={programs} student={student} />);
    fireEvent.change(screen.getByLabelText("Middle name"), { target: { value: "Changed Middle" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(`Student save ${status}.`);
    expect(screen.getByLabelText("Middle name")).toHaveValue("Changed Middle");
    expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled();
  });

  it.each([
    ["an HTML gateway response", () => Promise.resolve(new Response("Bad gateway", { status: 502 }))],
    ["a rejected fetch", () => Promise.reject(new TypeError("network down"))],
  ])("shows actionable feedback for %s", async (_label, result) => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(result));
    render(<StudentForm colleges={colleges} programs={programs} student={student} />);
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/check your connection and try again/i);
    expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled();
  });

  it("blocks duplicate saves synchronously", async () => {
    let resolve!: (value: Response) => void;
    const pending = new Promise<Response>((done) => { resolve = done; });
    const fetchMock = vi.fn().mockReturnValue(pending);
    vi.stubGlobal("fetch", fetchMock);
    render(<StudentForm colleges={colleges} programs={programs} student={student} />);
    const form = screen.getByRole("button", { name: "Save changes" }).closest("form")!;

    fireEvent.submit(form);
    fireEvent.submit(form);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    resolve(response({ data: student }));
    await screen.findByText("Student changes saved.");
  });
});
