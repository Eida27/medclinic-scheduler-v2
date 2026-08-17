import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ScheduleImportForm } from "./ScheduleImportForm";

const push = vi.fn();
const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, refresh }) }));

const headers = "Student ID,Surname,First Name,Middle Name,Suffix,College,Course,Year,Date of Birth";

function csvFile() {
  return new File([
    `${headers}\n23-1212-97,Abad,Aaron,A.,,College of Computer Studies,BSIT,3,2004-08-04`,
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
    expect(screen.getByText(/Date of Birth must use YYYY-MM-DD/)).toBeVisible();
    expect(screen.getByText(/replace the sample row/i)).toBeVisible();
    expect(screen.getByText(/save as.*CSV UTF-8/i)).toBeVisible();
    expect(screen.getByRole("link", { name: "Download Excel template" })).toHaveAttribute(
      "href",
      "/templates/student-schedule-import-template.xlsx",
    );
    expect(screen.getByLabelText("CSV file")).toHaveAttribute("accept", ".csv,text/csv");
    expect(screen.getByRole("button", { name: "Review import" }).closest("form")).toHaveClass("min-w-0");
    expect(screen.queryByLabelText("Preferred month")).not.toBeInTheDocument();
    expect(screen.getByText(/seven calendar days of preparation/i)).toBeVisible();
    expect(screen.getByText("CSV Import Reminder")).toBeVisible();
    expect(screen.getByText("CSV Import Reminder").parentElement?.parentElement).toHaveClass("min-w-0");
    expect(screen.getByText("Required headers in this exact order").parentElement).toHaveClass("min-w-0");
    expect(screen.getByText((_content, element) => (
      element?.tagName === "P"
      && element.textContent?.includes("Each CSV must contain students from only one year level and one category") === true
    ))).toBeVisible();
    expect(screen.getByText(/Year 1.*First Year/i)).toBeVisible();
    expect(screen.getByText(/Year 2.*Regular/i)).toBeVisible();
    expect(screen.getByText(/Year 3.*Regular or Tour/i)).toBeVisible();
    expect(screen.getByText(/Year 4.*OJT/i)).toBeVisible();
    expect(within(screen.getByLabelText("Student category")).getAllByRole("option").map((option) => option.textContent)).toEqual([
      "Regular",
      "First Year",
      "OJT",
      "Tour",
    ]);
    expect(screen.queryByText(/schedule dates in YYYY-MM-DD/i)).not.toBeInTheDocument();
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

  it("reviews First Year imports before confirmation and shows the authoritative allocation warning", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { valid: true } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            sourceFilename: "students.csv",
            memberCount: 280,
            academicYearStart: 2026,
            laboratory: { date: "2026-09-22", locationName: "Iloilo Mission Hospital" },
            firstPhysicalExamCandidate: "2026-09-29",
            physicalExamMaximumCapacity: 150,
            allocations: [
              { date: "2026-09-29", studentCount: 150, capacity: 150 },
              { date: "2026-09-30", studentCount: 130, capacity: 150 },
            ],
            skippedDates: [{ date: "2026-09-28", reasons: ["PROTECTED_APPOINTMENT_CONFLICT"] }],
            displacementTotal: 4,
            blockers: [],
            canPublish: true,
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { importId: "first-year-import-id" } }),
      });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<ScheduleImportForm />);

    await user.selectOptions(screen.getByLabelText("Student category"), "FIRST_YEAR");
    expect(screen.queryByLabelText("Preferred month")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Laboratory date")).toBeRequired();
    expect(screen.getByText("Iloilo Mission Hospital")).toBeVisible();
    await user.upload(screen.getByLabelText("CSV file"), csvFile());
    await user.selectOptions(screen.getByLabelText("Academic year"), "2026");
    fireEvent.change(screen.getByLabelText("Laboratory date"), {
      target: { value: "2026-09-22" },
    });
    fireEvent.submit(screen.getByRole("button", { name: "Review import" }).closest("form")!);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls[0][0]).toBe("/api/schedule-imports/preflight");
    const reviewBody = fetchMock.mock.calls[1][1].body as FormData;
    expect(fetchMock.mock.calls[1][0]).toBe("/api/schedule-imports/review");
    expect(reviewBody.get("importMode")).toBe("FIRST_YEAR_OVPSA");
    expect(reviewBody.get("studentCategory")).toBe("REGULAR");
    expect(reviewBody.get("firstYearLaboratoryDate")).toBe("2026-09-22");

    const dialog = await screen.findByRole("dialog", { name: "Confirm First Year schedule?" });
    expect(dialog).toHaveTextContent("280 Year-1 students");
    expect(dialog).toHaveTextContent("students.csv");
    expect(dialog).toHaveTextContent("AY 2026–2027");
    expect(dialog).toHaveTextContent("2026-09-22 at Iloilo Mission Hospital");
    expect(dialog).toHaveTextContent("first Physical Examination candidate is 2026-09-29");
    expect(dialog).toHaveTextContent("capacity is 150 per day across 2 selected dates");
    expect(dialog).toHaveTextContent("2026-09-29: 150 of 150");
    expect(dialog).toHaveTextContent("2026-09-30: 130 of 150");
    expect(dialog).toHaveTextContent("2026-09-28");
    expect(dialog).toHaveTextContent("4 lower-priority appointments");
    expect(dialog).toHaveTextContent("First Year-exclusive");

    await user.click(within(dialog).getByRole("button", { name: "Agree and schedule" }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/students/schedule-imports/first-year-import-id"));
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[2][0]).toBe("/api/schedule-imports");
  });

  it("posts file, category, academic year, and conditional preferred month once confirmed", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { valid: true } }),
      })
      .mockResolvedValueOnce({
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
    const dialog = await screen.findByRole("dialog", { name: "Import and publish this CSV?" });
    expect(dialog).toHaveTextContent("Tour");
    expect(dialog).toHaveTextContent("2026–2027");
    await user.click(within(dialog).getByRole("button", { name: "Agree and import" }));

    await waitFor(() => expect(push).toHaveBeenCalledWith("/students/schedule-imports/import-id"));
    expect(fetchMock.mock.calls[0][0]).toBe("/api/schedule-imports/preflight");
    const body = fetchMock.mock.calls[1][1].body as FormData;
    expect(fetchMock.mock.calls[1][0]).toBe("/api/schedule-imports");
    expect(body.get("file")).toBeInstanceOf(File);
    expect(body.get("studentCategory")).toBe("TOUR");
    expect(body.get("importMode")).toBe("STANDARD");
    expect(body.get("academicYearStart")).toBe("2026");
    expect(body.get("preferredMonth")).toBe("10");
    expect([...body.keys()].sort()).toEqual([
      "academicYearStart",
      "file",
      "importMode",
      "preferredMonth",
      "studentCategory",
    ]);
  });

  it("stays locked after a successful import until navigation unmounts the form", async () => {
    const request = deferred<{ ok: boolean; json: () => Promise<{ data: { importId: string } }> }>();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: { valid: true } }) })
      .mockReturnValueOnce(request.promise);
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<ScheduleImportForm />);
    await user.upload(screen.getByLabelText("CSV file"), csvFile());
    fireEvent.submit(screen.getByRole("button", { name: "Review import" }).closest("form")!);
    const confirmButton = await screen.findByRole("button", { name: "Agree and import" });

    await user.click(confirmButton);
    await user.click(screen.getByRole("button", { name: /importing and publishing/i }));

    expect(fetchMock).toHaveBeenCalledTimes(2);
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
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: { valid: true } }) })
      .mockResolvedValueOnce({
        ok: false,
        json: async () => ({ error: { message: "The CSV could not be imported." } }),
      }));
    const user = userEvent.setup();
    render(<ScheduleImportForm />);
    await user.upload(screen.getByLabelText("CSV file"), csvFile());
    fireEvent.submit(screen.getByRole("button", { name: "Review import" }).closest("form")!);
    await user.click(await screen.findByRole("button", { name: "Agree and import" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByText("The CSV could not be imported.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Review import" })).toBeEnabled();
  });

  it("shows a preflight mismatch without confirmation and clears it when category changes", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({
        error: {
          code: "CSV_IMPORT_INVALID",
          message: "Please correct the CSV import errors.",
          fields: {
            studentCategory: [
              "This CSV contains Year 4 students. Year 4 students can only be imported as OJT.",
            ],
          },
        },
      }),
    }));
    const user = userEvent.setup();
    render(<ScheduleImportForm />);
    await user.upload(screen.getByLabelText("CSV file"), csvFile());
    fireEvent.submit(screen.getByRole("button", { name: "Review import" }).closest("form")!);

    expect(await screen.findByText(/Year 4 students can only be imported as OJT/)).toBeVisible();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Student category")).toHaveAttribute("aria-invalid", "true");

    await user.selectOptions(screen.getByLabelText("Student category"), "OJT");
    expect(screen.queryByText(/Year 4 students can only be imported as OJT/)).not.toBeInTheDocument();
  });
});
