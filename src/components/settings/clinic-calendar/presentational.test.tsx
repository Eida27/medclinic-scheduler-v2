import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { buildMonthGrid, type CalendarDateCell } from "../clinic-calendar";
import type { CalendarDateState } from "../clinic-calendar-draft";
import { BlockConfigurationForm } from "./BlockConfigurationForm";
import { CalendarDraftSummary } from "./CalendarDraftSummary";
import { CalendarSaveConfirmationDialog } from "./CalendarSaveConfirmationDialog";
import { ClinicCalendarDay } from "./ClinicCalendarDay";
import { ClinicCalendarToolbar } from "./ClinicCalendarToolbar";
import { ClinicMonthGrid } from "./ClinicMonthGrid";

const clinics = [
  { id: "clinic-kabalaka", name: "KABALAKA Clinic" },
  { id: "clinic-cpu", name: "CPU Clinic" },
];

function cell(date: string): CalendarDateCell {
  const found = buildMonthGrid("2027-07").find((candidate) => candidate.kind === "date" && candidate.date === date);
  if (!found || found.kind !== "date") throw new Error(`Missing ${date}`);
  return found;
}

describe("clinic calendar presentation", () => {
  it("renders blank neighboring-month cells without date numbers", () => {
    render(
      <ClinicMonthGrid
        cells={buildMonthGrid("2027-07")}
        getState={() => ({ state: "AVAILABLE" })}
        today="2027-07-01"
        disabled={false}
        onToggle={vi.fn()}
      />,
    );

    expect(screen.queryByText("31", { selector: '[data-outside-month="true"]' })).not.toBeInTheDocument();
    const blankCells = screen.getAllByTestId("calendar-blank-cell");
    expect(blankCells).toHaveLength(4);
    for (const blankCell of blankCells) {
      expect(blankCell).toHaveAttribute("aria-hidden", "true");
      expect(blankCell.querySelectorAll("button, a, input, select, textarea, [tabindex]")).toHaveLength(0);
    }
  });

  it("announces visible date states and toggles editable dates by keyboard", async () => {
    const onToggle = vi.fn();
    const stateByDate: Record<string, CalendarDateState> = {
      "2027-07-15": { state: "AVAILABLE" },
      "2027-07-16": {
        state: "SAVED_BLOCKED",
        record: {
          id: "unavailable-16", clinicId: clinics[0].id, clinicCode: "KABALAKA_CLINIC", clinicName: clinics[0].name,
          startDate: "2027-07-16", endDate: "2027-07-16", category: "CLOSURE", reason: "Maintenance",
          createdByName: "Admin", createdAt: "2027-06-01T00:00:00.000000Z", updatedAt: "2027-06-01T00:00:00.000000Z",
        },
      },
      "2027-07-17": {
        state: "STAGED_BLOCK",
        change: { action: "BLOCK", clinicId: clinics[0].id, date: "2027-07-17", category: "HOLIDAY", reason: "Holiday" },
      },
      "2027-07-18": {
        state: "STAGED_UNBLOCK",
        record: {
          id: "unavailable-18", clinicId: clinics[0].id, clinicCode: "KABALAKA_CLINIC", clinicName: clinics[0].name,
          startDate: "2027-07-18", endDate: "2027-07-18", category: "CLOSURE", reason: "Closure",
          createdByName: "Admin", createdAt: "2027-06-01T00:00:00.000000Z", updatedAt: "2027-06-01T00:00:00.000000Z",
        },
        change: { action: "UNBLOCK", clinicId: clinics[0].id, date: "2027-07-18", unavailableDateId: "unavailable-18", expectedUpdatedAt: "2027-06-01T00:00:00.000000Z" },
      },
    };

    render(
      <div>
        <ClinicCalendarDay cell={cell("2027-07-15")} state={stateByDate["2027-07-15"]} disabled={false} onToggle={onToggle} />
        <ClinicCalendarDay cell={cell("2027-07-16")} state={stateByDate["2027-07-16"]} disabled={false} onToggle={onToggle} />
        <ClinicCalendarDay cell={cell("2027-07-17")} state={stateByDate["2027-07-17"]} disabled={false} onToggle={onToggle} />
        <ClinicCalendarDay cell={cell("2027-07-18")} state={stateByDate["2027-07-18"]} disabled={false} onToggle={onToggle} />
        <ClinicCalendarDay cell={cell("2027-07-10")} state={{ state: "AVAILABLE" }} disabled={true} onToggle={onToggle} />
      </div>,
    );

    const available = screen.getByRole("button", { name: "July 15, 2027 — available" });
    expect(available).toBeEnabled();
    expect(screen.getByRole("button", { name: "July 16, 2027 — blocked: Closure, Maintenance" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "July 17, 2027 — will be blocked: Holiday" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "July 18, 2027 — will be reopened" })).toBeEnabled();
    expect(screen.getByRole("button", { name: /July 10, 2027 — available/ })).toBeDisabled();
    expect(screen.getByText("Will be blocked")).toBeInTheDocument();
    expect(screen.getByText("Will be reopened")).toBeInTheDocument();

    available.focus();
    await userEvent.setup().keyboard("{Enter}");
    await userEvent.setup().keyboard(" ");
    expect(onToggle).toHaveBeenCalledTimes(2);
    expect(onToggle).toHaveBeenCalledWith("2027-07-15");
  });

  it("disables today, past dates, and weekends in the month grid", () => {
    render(
      <ClinicMonthGrid
        cells={buildMonthGrid("2027-07")}
        getState={() => ({ state: "AVAILABLE" })}
        today="2027-07-15"
        disabled={false}
        onToggle={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "July 14, 2027 — available" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "July 15, 2027 — available" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "July 17, 2027 — non-scheduling day" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "July 19, 2027 — available" })).toBeEnabled();
  });

  it("presents weekends as non-scheduling days while future weekdays remain available", () => {
    render(
      <ClinicMonthGrid
        cells={buildMonthGrid("2027-07")}
        getState={() => ({ state: "AVAILABLE" })}
        today="2027-07-15"
        disabled={false}
        onToggle={vi.fn()}
      />,
    );

    const weekend = screen.getByRole("button", { name: "July 17, 2027 — non-scheduling day" });
    expect(weekend).toBeDisabled();
    expect(within(weekend).getByText("Non-scheduling day")).toBeInTheDocument();

    const weekday = screen.getByRole("button", { name: "July 19, 2027 — available" });
    expect(weekday).toBeEnabled();
    expect(within(weekday).getByText("Available")).toBeInTheDocument();
  });

  it("changes clinics and months with years through the configured maximum", async () => {
    const onClinicChange = vi.fn();
    const onMonthChange = vi.fn();
    const user = userEvent.setup();
    render(
      <ClinicCalendarToolbar
        clinics={clinics}
        selectedClinicId={clinics[0].id}
        month="2027-12"
        currentYear={2027}
        maxYear={2100}
        disabled={false}
        onClinicChange={onClinicChange}
        onMonthChange={onMonthChange}
      />,
    );

    expect(screen.getByRole("option", { name: "2027" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "2100" })).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("Clinic"), clinics[1].id);
    await user.selectOptions(screen.getByLabelText("Year"), "2100");
    await user.click(screen.getByRole("button", { name: "Next month" }));
    expect(onClinicChange).toHaveBeenCalledWith(clinics[1].id);
    expect(onMonthChange).toHaveBeenNthCalledWith(1, "2100-12");
    expect(onMonthChange).toHaveBeenLastCalledWith("2028-01");
  });

  it("prevents navigation before the current January", () => {
    render(
      <ClinicCalendarToolbar
        clinics={clinics}
        selectedClinicId={clinics[0].id}
        month="2027-01"
        currentYear={2027}
        maxYear={2100}
        disabled={false}
        onClinicChange={vi.fn()}
        onMonthChange={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Previous month" })).toBeDisabled();
  });

  it("reports valid block configuration without changing staged drafts", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<BlockConfigurationForm disabled={false} onChange={onChange} />);
    await user.selectOptions(screen.getByLabelText("Category"), "MAINTENANCE");
    await user.type(screen.getByLabelText("Reason"), "Generator maintenance");

    expect(onChange).toHaveBeenLastCalledWith({ category: "MAINTENANCE", reason: "Generator maintenance", valid: true });
  });

  it("groups the draft and confirmation changes by clinic and action", () => {
    const changes = [
      { action: "BLOCK" as const, clinicId: clinics[0].id, date: "2027-07-15", category: "HOLIDAY" as const, reason: "Foundation day" },
      { action: "UNBLOCK" as const, clinicId: clinics[0].id, date: "2027-07-16", unavailableDateId: "a", expectedUpdatedAt: "token-a" },
      { action: "BLOCK" as const, clinicId: clinics[1].id, date: "2027-08-01", category: "CLOSURE" as const, reason: "Audit" },
    ];
    render(<CalendarDraftSummary clinics={clinics} changes={changes} />);
    const kabalaka = screen.getByText("KABALAKA Clinic").parentElement!;
    expect(within(kabalaka).getByText("Block 1 date")).toBeInTheDocument();
    expect(within(kabalaka).getByText("Reopen 1 date")).toBeInTheDocument();
    const cpu = screen.getByText("CPU Clinic").parentElement!;
    expect(within(cpu).getByText("Block 1 date")).toBeInTheDocument();
  });

  it("reviews every dated change with block details and movement consequences before one confirmation", () => {
    const changes = [
      { action: "BLOCK" as const, clinicId: clinics[0].id, date: "2027-07-15", category: "HOLIDAY" as const, reason: "Foundation day" },
      { action: "UNBLOCK" as const, clinicId: clinics[0].id, date: "2027-07-16", unavailableDateId: "a", expectedUpdatedAt: "token-a" },
      { action: "BLOCK" as const, clinicId: clinics[1].id, date: "2027-08-01", category: "STAFF_UNAVAILABILITY" as const, reason: "Annual training" },
      { action: "UNBLOCK" as const, clinicId: clinics[1].id, date: "2027-08-02", unavailableDateId: "b", expectedUpdatedAt: "token-b" },
    ];

    render(
      <CalendarSaveConfirmationDialog
        open
        changes={changes}
        clinics={clinics}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );

    const dialog = screen.getByRole("dialog", { name: "Save clinic calendar changes" });
    expect(within(dialog).getByText("2 clinics · 4 dates")).toBeInTheDocument();

    const kabalaka = within(dialog).getByRole("region", { name: "KABALAKA Clinic" });
    expect(within(kabalaka).getByRole("heading", { name: "Dates to block" })).toBeInTheDocument();
    expect(within(kabalaka).getByText("July 15, 2027")).toBeInTheDocument();
    expect(within(kabalaka).getByText("Holiday")).toBeInTheDocument();
    expect(within(kabalaka).getByText("Foundation day")).toBeInTheDocument();
    expect(within(kabalaka).getByRole("heading", { name: "Dates to unblock" })).toBeInTheDocument();
    expect(within(kabalaka).getByText("July 16, 2027")).toBeInTheDocument();

    const cpu = within(dialog).getByRole("region", { name: "CPU Clinic" });
    expect(within(cpu).getByText("August 1, 2027")).toBeInTheDocument();
    expect(within(cpu).getByText("Staff unavailability")).toBeInTheDocument();
    expect(within(cpu).getByText("Annual training")).toBeInTheDocument();
    expect(within(cpu).getByText("August 2, 2027")).toBeInTheDocument();

    expect(within(dialog).getByText(
      "Blocking dates may reschedule appointments. Unblocking dates may restore eligible appointments.",
    )).toBeInTheDocument();
    expect(within(dialog).getAllByRole("button")).toHaveLength(2);
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Confirm and save" })).toBeInTheDocument();
  });

  it("traps focus, cancels on Escape, restores the save trigger, and confirms only once", async () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    function DialogHarness() {
      const [open, setOpen] = useState(false);
      const saveRef = useRef<HTMLButtonElement>(null);
      return (
        <>
          <button ref={saveRef} type="button" onClick={() => setOpen(true)}>Save changes</button>
          <CalendarSaveConfirmationDialog
            open={open}
            changes={[{ action: "BLOCK", clinicId: clinics[0].id, date: "2027-07-15", category: "HOLIDAY", reason: "Foundation day" }]}
            clinics={clinics}
            returnFocusRef={saveRef}
            onCancel={() => { onCancel(); setOpen(false); }}
            onConfirm={onConfirm}
          />
        </>
      );
    }
    render(<DialogHarness />);
    const save = screen.getByRole("button", { name: "Save changes" });
    await user.click(save);
    const dialog = screen.getByRole("dialog", { name: "Save clinic calendar changes" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();

    await user.keyboard("{Shift>}{Tab}{/Shift}");
    expect(screen.getByRole("button", { name: "Confirm and save" })).toHaveFocus();
    await user.keyboard("{Tab}");
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalledOnce();
    expect(save).toHaveFocus();

    await user.click(save);
    fireEvent.click(screen.getByRole("button", { name: "Confirm and save" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm and save" }));
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it("restores the save trigger when a successful confirmation closes the dialog", async () => {
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    function ClosingDialogHarness() {
      const [open, setOpen] = useState(false);
      const saveRef = useRef<HTMLButtonElement>(null);
      return (
        <>
          <button ref={saveRef} type="button" onClick={() => setOpen(true)}>Save changes</button>
          <CalendarSaveConfirmationDialog
            open={open}
            changes={[{ action: "BLOCK", clinicId: clinics[0].id, date: "2027-07-15", category: "HOLIDAY", reason: "Foundation day" }]}
            clinics={clinics}
            returnFocusRef={saveRef}
            onCancel={() => setOpen(false)}
            onConfirm={() => { onConfirm(); setOpen(false); }}
          />
        </>
      );
    }
    render(<ClosingDialogHarness />);
    const save = screen.getByRole("button", { name: "Save changes" });
    await user.click(save);
    await user.click(screen.getByRole("button", { name: "Confirm and save" }));

    expect(onConfirm).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(save).toHaveFocus();
  });

  it("keeps Tab and Shift+Tab inside while a confirmed save remains pending", async () => {
    const pendingSave = new Promise<void>(() => undefined);
    const onConfirm = vi.fn(() => pendingSave);
    const onCancel = vi.fn();
    const user = userEvent.setup();
    function PendingDialogHarness() {
      const [open, setOpen] = useState(false);
      const saveRef = useRef<HTMLButtonElement>(null);
      return (
        <>
          <button ref={saveRef} type="button" onClick={() => setOpen(true)}>Save changes</button>
          <CalendarSaveConfirmationDialog
            open={open}
            changes={[{ action: "BLOCK", clinicId: clinics[0].id, date: "2027-07-15", category: "HOLIDAY", reason: "Foundation day" }]}
            clinics={clinics}
            returnFocusRef={saveRef}
            onCancel={() => { onCancel(); setOpen(false); }}
            onConfirm={onConfirm}
          />
        </>
      );
    }
    render(<PendingDialogHarness />);
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await user.click(screen.getByRole("button", { name: "Confirm and save" }));

    expect(screen.getByRole("dialog")).toHaveAttribute("aria-busy", "true");
    const cancel = screen.getByRole("button", { name: "Cancel" });
    expect(cancel).toHaveAttribute("aria-disabled", "true");
    await user.click(cancel);
    await user.keyboard("{Escape}");
    expect(onCancel).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await user.keyboard("{Tab}");
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    await user.keyboard("{Shift>}{Tab}{/Shift}");
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
  });
});
