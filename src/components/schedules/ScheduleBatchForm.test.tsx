import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ScheduleBatchForm } from "./ScheduleBatchForm";

const push = vi.fn();
const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, refresh }) }));

const colleges = [{
  id: "10000000-0000-4000-8000-000000000003",
  code: "CCS",
  name: "College of Computer Studies",
  isActive: true,
}];
const programs = [{
  id: "20000000-0000-4000-8000-000000000003",
  collegeId: colleges[0].id,
  collegeName: colleges[0].name,
  code: "BSIT",
  name: "BS Information Technology",
  isActive: true,
}];
const priorities = [{
  id: "30000000-0000-4000-8000-000000000004",
  name: "Regular",
  rankOrder: 4,
  isActive: true,
}];

describe("ScheduleBatchForm", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    push.mockReset();
    refresh.mockReset();
  });

  it("groups the manual scheduling controls in one labeled form", () => {
    render(<ScheduleBatchForm colleges={colleges} programs={programs} priorities={priorities} />);

    const manualForm = screen.getByRole("form", { name: "Create schedule manually" });
    const manualWorkflow = within(manualForm);

    expect(manualWorkflow.getByRole("heading", { name: "Create schedule manually" })).toBeVisible();
    expect(manualWorkflow.getByRole("heading", { name: "Batch details" })).toBeVisible();
    expect(manualWorkflow.getByLabelText("Batch name")).toBeVisible();
    expect(manualWorkflow.getByRole("heading", { name: "Schedule items" })).toBeVisible();
    expect(manualWorkflow.getByRole("button", { name: "Add row" })).toBeVisible();
    expect(manualWorkflow.getByRole("button", { name: "Create schedule batch" })).toBeVisible();
  });

  it("preserves the form and marks every missing-student row", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({
        error: {
          code: "SCHEDULE_STUDENTS_NOT_FOUND",
          message: "Some students are not registered. Add them before creating the batch, or use CSV import.",
          fields: {
            "items.0.studentNumber": ["Student number 09-0808-97 is not registered."],
            "items.1.studentNumber": ["Student number 09-0809-97 is not registered."],
          },
        },
      }),
    }));
    const user = userEvent.setup();
    render(<ScheduleBatchForm colleges={colleges} programs={programs} priorities={priorities} />);

    await user.type(screen.getByLabelText("Batch name"), "Second Year Students (BSIT)");
    await user.type(screen.getByLabelText("Student number 1"), "09-0808-97");
    await user.selectOptions(screen.getByLabelText("Priority 1"), priorities[0].id);
    fireEvent.change(screen.getByLabelText("Target date 1"), { target: { value: "2026-06-20" } });
    await user.click(screen.getByRole("button", { name: "Add row" }));
    await user.type(screen.getByLabelText("Student number 2"), "09-0809-97");
    await user.selectOptions(screen.getByLabelText("Priority 2"), priorities[0].id);
    fireEvent.change(screen.getByLabelText("Target date 2"), { target: { value: "2026-06-21" } });

    fireEvent.submit(screen.getByRole("button", { name: "Create schedule batch" }).closest("form")!);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Some students are not registered.");
    expect(screen.getByText("Student number 09-0808-97 is not registered.")).toBeVisible();
    expect(screen.getByText("Student number 09-0809-97 is not registered.")).toBeVisible();
    expect(screen.getByLabelText("Student number 1")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByLabelText("Student number 2")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByLabelText("Student number 1")).toHaveValue("09-0808-97");
    expect(screen.getByLabelText("Batch name")).toHaveValue("Second Year Students (BSIT)");

    const addStudent = screen.getByRole("link", { name: "Add student" });
    expect(addStudent).toHaveAttribute("href", "/students/new");
    expect(addStudent).toHaveAttribute("target", "_blank");
    expect(addStudent).toHaveAttribute("rel", expect.stringContaining("noopener"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Create schedule batch" })).toBeEnabled());
    expect(push).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("forces clinic and schedule type when rendered from a clinic dashboard", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { id: "lab-batch" } }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(
      <ScheduleBatchForm
        colleges={colleges}
        programs={programs}
        priorities={priorities}
        clinicCode="KABALAKA_CLINIC"
        forcedScheduleType="LABORATORY"
        redirectBase="/laboratory/coordinator-schedules"
      />,
    );

    expect(screen.getByText("Laboratory")).toBeVisible();
    expect(screen.queryByLabelText("Service 1")).not.toBeInTheDocument();

    await user.type(screen.getByLabelText("Batch name"), "Laboratory Batch");
    await user.type(screen.getByLabelText("Student number 1"), "DEMO-0001");
    await user.selectOptions(screen.getByLabelText("Priority 1"), priorities[0].id);
    fireEvent.change(screen.getByLabelText("Target date 1"), { target: { value: "2026-06-20" } });

    fireEvent.submit(screen.getByRole("button", { name: "Create schedule batch" }).closest("form")!);

    await waitFor(() => expect(push).toHaveBeenCalledWith("/laboratory/coordinator-schedules/lab-batch"));
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.clinicCode).toBe("KABALAKA_CLINIC");
    expect(body.items).toEqual([
      expect.objectContaining({ studentNumber: "DEMO-0001", scheduleType: "LABORATORY" }),
    ]);
  });
});
