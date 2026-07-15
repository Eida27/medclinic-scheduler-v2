import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

async function reviewImport(user: ReturnType<typeof userEvent.setup>, name = "July schedules.csv") {
  await completeRequiredFields(user, name);
  fireEvent.submit(screen.getByRole("button", { name: "Review import" }).closest("form")!);
  return screen.getByRole("dialog", { name: "Import and publish this CSV?" });
}

describe("ScheduleImportForm", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    push.mockReset();
    refresh.mockReset();
  });

  it("shows only the CSV and priority inputs with the existing import guidance", () => {
    render(<ScheduleImportForm priorities={priorities} />);

    expect(screen.getByText(headers)).toBeVisible();
    expect(screen.getByText(/UTF-8 CSV/i)).toBeVisible();
    expect(screen.getByRole("link", { name: "Download CSV template" })).toHaveAttribute(
      "href",
      "/templates/student-schedule-import-template.csv",
    );
    expect(screen.getByLabelText("CSV file")).toBeRequired();
    expect(screen.getByLabelText("Priority group")).toBeRequired();
    expect(screen.queryByLabelText("Import name")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Submitted by")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Description")).not.toBeInTheDocument();
  });

  it("reviews one confirmation and cancel sends no request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<ScheduleImportForm priorities={priorities} />);

    const dialog = await reviewImport(user, "Clinic appointments.csv");
    expect(dialog).toHaveTextContent("Clinic appointments.csv");
    expect(dialog).toHaveTextContent("Regular");
    expect(dialog).toHaveTextContent(/publish.*Laboratory.*Physical Examination/i);
    expect(fetchMock).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts exactly once after agreement and opens the published import detail", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { outcome: "PUBLISHED", importId: "grouped-import-id" } }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<ScheduleImportForm priorities={priorities} />);

    const dialog = await reviewImport(user);
    await user.click(within(dialog).getByRole("button", { name: "Agree and import" }));

    await waitFor(() => expect(push).toHaveBeenCalledWith("/students/schedule-imports/grouped-import-id"));
    expect(refresh).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();

    const [url, request] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/schedule-imports");
    expect(request.method).toBe("POST");
    const body = request.body as FormData;
    expect(body.get("file")).toBeInstanceOf(File);
    expect(body.get("priorityGroupId")).toBe(priorities[0].id);
    expect([...body.keys()].sort()).toEqual(["file", "priorityGroupId"]);
  });

  it("preserves the selected values and validation details after a rejected file", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({
        error: {
          message: "Please correct the CSV import errors.",
          fields: {
            "rows.2.Course": ["Course does not match an active program."],
            file: ["CSV files may not exceed 1 MB."],
          },
        },
      }),
    }));
    const user = userEvent.setup();
    render(<ScheduleImportForm priorities={priorities} />);

    const dialog = await reviewImport(user, "invalid.csv");
    await user.click(within(dialog).getByRole("button", { name: "Agree and import" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Please correct the CSV import errors.");
    expect(alert).toHaveTextContent("Row 2 · Course: Course does not match an active program.");
    expect(alert).toHaveTextContent("File: CSV files may not exceed 1 MB.");
    expect(screen.getByText("invalid.csv")).toBeVisible();
    expect(screen.getByLabelText("Priority group")).toHaveValue(priorities[0].id);
    expect(screen.getByRole("button", { name: "Review import" })).toBeEnabled();
  });

  it("locks the confirmation against duplicate requests while publishing", async () => {
    let resolveFetch!: (value: unknown) => void;
    const fetchMock = vi.fn().mockReturnValue(new Promise((resolve) => { resolveFetch = resolve; }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<ScheduleImportForm priorities={priorities} />);

    const dialog = await reviewImport(user);
    await user.click(within(dialog).getByRole("button", { name: "Agree and import" }));

    const pendingButton = await screen.findByRole("button", { name: "Importing and publishing…" });
    expect(pendingButton).toBeDisabled();
    await user.click(pendingButton);
    expect(fetchMock).toHaveBeenCalledOnce();

    resolveFetch({ ok: true, json: async () => ({ data: { outcome: "PUBLISHED", importId: "pending-import" } }) });
    await waitFor(() => expect(push).toHaveBeenCalledWith("/students/schedule-imports/pending-import"));
  });

  it("links to the saved review checkpoint instead of navigating automatically", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          outcome: "REVIEW_REQUIRED",
          importId: "review-import",
          status: "VALIDATED",
          stage: "GENERATE",
          issue: { code: "ADMIN_OVERRIDE_REQUIRED", message: "Capacity override requires an administrator." },
        },
      }),
    }));
    const user = userEvent.setup();
    render(<ScheduleImportForm priorities={priorities} />);

    const dialog = await reviewImport(user);
    await user.click(within(dialog).getByRole("button", { name: "Agree and import" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Capacity override requires an administrator.");
    expect(alert).toHaveTextContent(/saved at validated/i);
    expect(screen.getByRole("link", { name: "Review saved import" })).toHaveAttribute(
      "href",
      "/students/schedule-imports/review-import",
    );
    expect(push).not.toHaveBeenCalled();
  });
});
