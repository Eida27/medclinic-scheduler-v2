import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ScheduleImportForm } from "./ScheduleImportForm";

const push = vi.fn();
const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, refresh }) }));

const headers = "Student ID,Surname,First Name,MI,Suffix,College,Course,Year,Date of Birth";

function csvFile() {
  return new File([
    `${headers}\n23-1212-97,Abad,Aaron,A.,,College of Computer Studies,BSIT,3,08-04-2004`,
  ], "students.csv", { type: "text/csv" });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

describe("ScheduleImportForm", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    push.mockReset();
    refresh.mockReset();
  });

  it("shows the exact workbook headers, academic year controls, and seven-day notice", () => {
    render(<ScheduleImportForm />);
    expect(screen.getByText(headers)).toBeVisible();
    expect(screen.getByLabelText("Student category")).toHaveValue("REGULAR");
    expect(screen.getByLabelText("Academic year")).toBeRequired();
    expect(screen.getByText(/CSV UTF-8/)).toBeVisible();
    expect(screen.getByText(/CSV \(Comma delimited\).*Windows-1252/)).toBeVisible();
    expect(screen.queryByLabelText("Preferred month")).not.toBeInTheDocument();
    expect(screen.getByText(/seven calendar days of preparation/i)).toBeVisible();
    expect(screen.queryByText(/schedule dates in MM-DD-YYYY/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/at least one service date/i)).not.toBeInTheDocument();
  });

  it("requires and clears preferred month for priority categories", async () => {
    const user = userEvent.setup();
    render(<ScheduleImportForm />);
    await user.selectOptions(screen.getByLabelText("Student category"), "OJT");
    expect(screen.getByLabelText("Preferred month")).toBeRequired();
    await user.selectOptions(screen.getByLabelText("Preferred month"), "9");
    await user.selectOptions(screen.getByLabelText("Student category"), "REGULAR");
    expect(screen.queryByLabelText("Preferred month")).not.toBeInTheDocument();
  });

  it("posts file, category, academic year, and conditional preferred month once confirmed", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { outcome: "PUBLISHED", importId: "import-id" } }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<ScheduleImportForm />);
    await user.upload(screen.getByLabelText("CSV file"), csvFile());
    await user.selectOptions(screen.getByLabelText("Student category"), "TOUR");
    await user.selectOptions(screen.getByLabelText("Academic year"), "2026");
    await user.selectOptions(screen.getByLabelText("Preferred month"), "10");
    fireEvent.submit(screen.getByRole("button", { name: "Review import" }).closest("form")!);
    const dialog = screen.getByRole("dialog", { name: "Import and publish this CSV?" });
    expect(dialog).toHaveTextContent("Tour");
    expect(dialog).toHaveTextContent("2026–2027");
    await user.click(within(dialog).getByRole("button", { name: "Agree and import" }));

    await waitFor(() => expect(push).toHaveBeenCalledWith("/students/schedule-imports/import-id"));
    const body = fetchMock.mock.calls[0][1].body as FormData;
    expect(body.get("file")).toBeInstanceOf(File);
    expect(body.get("studentCategory")).toBe("TOUR");
    expect(body.get("academicYearStart")).toBe("2026");
    expect(body.get("preferredMonth")).toBe("10");
    expect([...body.keys()].sort()).toEqual([
      "academicYearStart",
      "file",
      "preferredMonth",
      "studentCategory",
    ]);
  });

  it("stays locked after a successful import until navigation unmounts the form", async () => {
    const request = deferred<{ ok: boolean; json: () => Promise<{ data: { importId: string } }> }>();
    const fetchMock = vi.fn().mockReturnValue(request.promise);
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<ScheduleImportForm />);
    await user.upload(screen.getByLabelText("CSV file"), csvFile());
    fireEvent.submit(screen.getByRole("button", { name: "Review import" }).closest("form")!);
    const confirmButton = screen.getByRole("button", { name: "Agree and import" });

    await user.click(confirmButton);
    await user.click(screen.getByRole("button", { name: /importing and publishing/i }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("dialog")).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("button", { name: /importing and publishing/i })).toBeDisabled();

    request.resolve({
      ok: true,
      json: async () => ({ data: { importId: "import-id" } }),
    });
    await waitFor(() => expect(push).toHaveBeenCalledWith("/students/schedule-imports/import-id"));
    expect(screen.getByRole("button", { name: /importing and publishing/i })).toBeDisabled();
  });

  it("restores editing after an import request fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({ error: { message: "The CSV could not be imported." } }),
    }));
    const user = userEvent.setup();
    render(<ScheduleImportForm />);
    await user.upload(screen.getByLabelText("CSV file"), csvFile());
    fireEvent.submit(screen.getByRole("button", { name: "Review import" }).closest("form")!);
    await user.click(screen.getByRole("button", { name: "Agree and import" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByText("The CSV could not be imported.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Review import" })).toBeEnabled();
  });
});
