import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ClinicUnavailableDateForm } from "./ClinicUnavailableDateForm";

const clinics = [
  { id: "60000000-0000-4000-8000-000000000001", name: "KABALAKA Clinic" },
  { id: "60000000-0000-4000-8000-000000000002", name: "CPU Clinic" },
];

describe("ClinicUnavailableDateForm", () => {
  it("confirms automatic rescheduling and reports the moved impact", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { id: "block-id", movedStudentCount: 2, movedAppointmentCount: 4 } }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<ClinicUnavailableDateForm clinics={clinics} />);
    await user.selectOptions(screen.getByLabelText("Clinic"), clinics[0].id);
    fireEvent.change(screen.getByLabelText("Start date"), { target: { value: "2027-08-10" } });
    fireEvent.change(screen.getByLabelText("End date"), { target: { value: "2027-08-11" } });
    await user.selectOptions(screen.getByLabelText("Category"), "MAINTENANCE");
    await user.type(screen.getByLabelText("Reason"), "Equipment maintenance");
    await user.click(screen.getByRole("button", { name: "Review clinic block" }));
    const dialog = screen.getByRole("dialog", { name: "Create this clinic block?" });
    expect(dialog).toHaveTextContent(/automatically reschedule/i);
    await user.click(within(dialog).getByRole("button", { name: "Create block" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(await screen.findByRole("alert")).toHaveTextContent("2 students");
    expect(screen.getByRole("alert")).toHaveTextContent("4 appointments");
  });

  it("shows unresolved protected appointments from a rejected block", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({
        error: {
          message: "Some affected appointments are protected.",
          fields: { unresolved: ["appointment-id:99-0000-00"] },
        },
      }),
    }));
    const user = userEvent.setup();
    render(<ClinicUnavailableDateForm clinics={clinics} />);
    await user.selectOptions(screen.getByLabelText("Clinic"), clinics[1].id);
    fireEvent.change(screen.getByLabelText("Start date"), { target: { value: "2027-08-10" } });
    fireEvent.change(screen.getByLabelText("End date"), { target: { value: "2027-08-10" } });
    await user.type(screen.getByLabelText("Reason"), "Protected fixture");
    await user.click(screen.getByRole("button", { name: "Review clinic block" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Create block" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("appointment-id:99-0000-00");
  });
});
