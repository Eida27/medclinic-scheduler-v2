import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ScheduleCsvImportForm } from "./ScheduleCsvImportForm";

const push = vi.fn();
const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, refresh }) }));

const priorities = [{
  id: "30000000-0000-4000-8000-000000000004",
  name: "Regular",
  rankOrder: 4,
  isActive: true,
}];

describe("ScheduleCsvImportForm", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    push.mockReset();
    refresh.mockReset();
  });

  it("opens the CSV picker from the Upload button and displays the selected filename", async () => {
    const user = userEvent.setup();
    render(<ScheduleCsvImportForm priorities={priorities} />);

    const fileInput = screen.getByLabelText("CSV file") as HTMLInputElement;
    const inputClick = vi.spyOn(fileInput, "click");

    expect(screen.getByText("No file chosen")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Upload" }));
    expect(inputClick).toHaveBeenCalledOnce();

    await user.upload(
      fileInput,
      new File(["Student ID,Name"], "Clinic Appointments.csv", { type: "text/csv" }),
    );

    expect(screen.getByText("Clinic Appointments.csv")).toBeInTheDocument();
  });

  it("uploads the CSV as multipart data and opens the imported draft batch", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { id: "imported-batch" } }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<ScheduleCsvImportForm priorities={priorities} />);

    const file = new File(["Student ID,Name"], "Clinic Appointments.csv", { type: "text/csv" });
    await user.upload(screen.getByLabelText("CSV file"), file);
    await user.selectOptions(screen.getByLabelText("Priority group"), priorities[0].id);
    expect(screen.getByLabelText("Batch name")).toHaveValue("Clinic Appointments");

    fireEvent.submit(screen.getByRole("button", { name: "Import CSV" }).closest("form")!);
    await waitFor(() => expect(push).toHaveBeenCalledWith("/coordinator-schedules/imported-batch"));

    const [, request] = fetchMock.mock.calls[0];
    expect(request.method).toBe("POST");
    expect(request.body).toBeInstanceOf(FormData);
    expect(request.body.get("file")).toBeInstanceOf(File);
    expect(request.body.get("batchName")).toBe("Clinic Appointments");
    expect(request.body.get("priorityGroupId")).toBe(priorities[0].id);
    expect(refresh).toHaveBeenCalled();
  });

  it("renders row-and-column validation errors returned by the importer", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({
        error: {
          message: "Please correct the CSV import errors.",
          fields: {
            "rows.2.Appointment Date": ["Appointment Date must be a valid date in MM-DD-YYYY format."],
            file: ["CSV files may not exceed 1 MB."],
          },
        },
      }),
    }));
    const user = userEvent.setup();
    render(<ScheduleCsvImportForm priorities={priorities} />);
    await user.upload(
      screen.getByLabelText("CSV file"),
      new File(["invalid"], "invalid.csv", { type: "text/csv" }),
    );
    await user.selectOptions(screen.getByLabelText("Priority group"), priorities[0].id);

    fireEvent.submit(screen.getByRole("button", { name: "Import CSV" }).closest("form")!);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Please correct the CSV import errors.");
    expect(alert).toHaveTextContent(
      "Row 2 · Appointment Date: Appointment Date must be a valid date in MM-DD-YYYY format.",
    );
    expect(alert).toHaveTextContent("File: CSV files may not exceed 1 MB.");
    expect(screen.getByRole("button", { name: "Import CSV" })).toBeEnabled();
  });

  it("disables repeat submissions while an import is pending", async () => {
    let resolveFetch!: (value: unknown) => void;
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise((resolve) => { resolveFetch = resolve; })));
    const user = userEvent.setup();
    render(<ScheduleCsvImportForm priorities={priorities} />);
    await user.upload(
      screen.getByLabelText("CSV file"),
      new File(["Student ID,Name"], "pending.csv", { type: "text/csv" }),
    );
    await user.selectOptions(screen.getByLabelText("Priority group"), priorities[0].id);

    fireEvent.submit(screen.getByRole("button", { name: "Import CSV" }).closest("form")!);

    expect(await screen.findByRole("button", { name: "Importing..." })).toBeDisabled();
    resolveFetch({ ok: true, json: async () => ({ data: { id: "pending-batch" } }) });
    await waitFor(() => expect(push).toHaveBeenCalledWith("/coordinator-schedules/pending-batch"));
  });
});
