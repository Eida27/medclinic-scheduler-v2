import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ScheduleImportForm } from "./ScheduleImportForm";

const push = vi.fn();
const refresh = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, refresh }),
}));

const priorities = [
  {
    id: "30000000-0000-4000-8000-000000000004",
    name: "Regular",
    rankOrder: 4,
    isActive: true,
  },
  {
    id: "30000000-0000-4000-8000-000000000099",
    name: "Retired",
    rankOrder: 99,
    isActive: false,
  },
];

const headers = "Student ID,Name,College,Course,Year,Laboratory Schedule,Physical Examination Schedule";

function csvFile(name = "July schedules.csv") {
  return new File([[
    headers,
    '00-0000-00,"Sample, Student",College of Computer Studies,BSIT,1,07-29-2026,07-30-2026',
  ].join("\n")], name, { type: "text/csv" });
}

async function completeRequiredFields(user: ReturnType<typeof userEvent.setup>, name = "July schedules.csv") {
  await user.upload(screen.getByLabelText("CSV file"), csvFile(name));
  await user.selectOptions(screen.getByLabelText("Priority group"), priorities[0].id);
}

describe("ScheduleImportForm", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    push.mockReset();
    refresh.mockReset();
  });

  it("explains the master CSV contract and links to the public template", () => {
    render(<ScheduleImportForm priorities={priorities} />);

    expect(screen.getByText(headers)).toBeVisible();
    expect(screen.getByText(/UTF-8 CSV/i)).toBeVisible();
    expect(screen.getByText(/MM-DD-YYYY/)).toBeVisible();
    expect(screen.getByText(/1 MB/)).toBeVisible();
    expect(screen.getByText(/500 data rows/)).toBeVisible();
    expect(screen.getByText(/at least one service date/i)).toBeVisible();
    expect(screen.getByRole("link", { name: "Download CSV template" })).toHaveAttribute(
      "href",
      "/templates/student-schedule-import-template.csv",
    );
  });

  it("shows the selected file and derives an editable import name without overwriting a custom name", async () => {
    const user = userEvent.setup();
    render(<ScheduleImportForm priorities={priorities} />);

    expect(screen.getByText("No file chosen")).toBeVisible();
    await user.upload(screen.getByLabelText("CSV file"), csvFile("Clinic appointments.csv"));

    expect(screen.getByText("Clinic appointments.csv")).toBeVisible();
    expect(screen.getByLabelText("Import name")).toHaveValue("Clinic appointments");

    await user.clear(screen.getByLabelText("Import name"));
    await user.type(screen.getByLabelText("Import name"), "Coordinator master schedule");
    await user.upload(screen.getByLabelText("CSV file"), csvFile("Replacement.csv"));

    expect(screen.getByText("Replacement.csv")).toBeVisible();
    expect(screen.getByLabelText("Import name")).toHaveValue("Coordinator master schedule");
  });

  it("posts the five multipart fields and opens the grouped import detail", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { importId: "grouped-import-id" } }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<ScheduleImportForm priorities={priorities} />);

    await completeRequiredFields(user);
    expect(screen.getByLabelText("Priority group")).toHaveValue(priorities[0].id);
    fireEvent.change(screen.getByLabelText("Import name"), { target: { value: "July grouped schedule" } });
    expect(screen.getByLabelText("Priority group")).toHaveValue(priorities[0].id);
    fireEvent.change(screen.getByLabelText("Submitted by"), { target: { value: "CCS Coordinator" } });
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Master clinic schedule" } });
    expect(screen.getByLabelText("Priority group")).toHaveValue(priorities[0].id);
    fireEvent.submit(screen.getByRole("button", { name: "Import CSV" }).closest("form")!);

    await waitFor(() => {
      expect(push).toHaveBeenCalledWith("/students/schedule-imports/grouped-import-id");
    });
    expect(refresh).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();

    const [url, request] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/schedule-imports");
    expect(request.method).toBe("POST");
    expect(request.body).toBeInstanceOf(FormData);
    const body = request.body as FormData;
    expect(body.get("file")).toBeInstanceOf(File);
    expect(body.get("importName")).toBe("July grouped schedule");
    expect(body.get("priorityGroupId")).toBe(priorities[0].id);
    expect(body.get("submittedByName")).toBe("CCS Coordinator");
    expect(body.get("description")).toBe("Master clinic schedule");
  });

  it("renders top-level and row-column errors while preserving every entered value", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({
        error: {
          message: "Please correct the CSV import errors.",
          fields: {
            "rows.2.Course": ["Course does not match an active program."],
            "rows.2.Physical Examination Schedule": ["Use MM-DD-YYYY."],
            file: ["CSV files may not exceed 1 MB."],
          },
        },
      }),
    }));
    const user = userEvent.setup();
    render(<ScheduleImportForm priorities={priorities} />);

    await completeRequiredFields(user, "invalid.csv");
    fireEvent.change(screen.getByLabelText("Import name"), { target: { value: "Needs correction" } });
    fireEvent.change(screen.getByLabelText("Submitted by"), { target: { value: "Coordinator Name" } });
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Keep these values" } });
    fireEvent.submit(screen.getByRole("button", { name: "Import CSV" }).closest("form")!);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Please correct the CSV import errors.");
    expect(alert).toHaveTextContent("Row 2 · Course: Course does not match an active program.");
    expect(alert).toHaveTextContent("Row 2 · Physical Examination Schedule: Use MM-DD-YYYY.");
    expect(alert).toHaveTextContent("File: CSV files may not exceed 1 MB.");
    expect(screen.getByText("invalid.csv")).toBeVisible();
    expect(screen.getByLabelText("Import name")).toHaveValue("Needs correction");
    expect(screen.getByLabelText("Priority group")).toHaveValue(priorities[0].id);
    expect(screen.getByLabelText("Submitted by")).toHaveValue("Coordinator Name");
    expect(screen.getByLabelText("Description")).toHaveValue("Keep these values");
    expect(screen.getByRole("button", { name: "Import CSV" })).toBeEnabled();
  });

  it("disables duplicate submission while the import is pending", async () => {
    let resolveFetch!: (value: unknown) => void;
    const fetchMock = vi.fn().mockReturnValue(new Promise((resolve) => { resolveFetch = resolve; }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<ScheduleImportForm priorities={priorities} />);

    await completeRequiredFields(user);
    fireEvent.submit(screen.getByRole("button", { name: "Import CSV" }).closest("form")!);

    const pendingButton = await screen.findByRole("button", { name: "Importing..." });
    expect(pendingButton).toBeDisabled();
    await user.click(pendingButton);
    expect(fetchMock).toHaveBeenCalledOnce();

    resolveFetch({ ok: true, json: async () => ({ data: { importId: "pending-import" } }) });
    await waitFor(() => {
      expect(push).toHaveBeenCalledWith("/students/schedule-imports/pending-import");
    });
  });
});
