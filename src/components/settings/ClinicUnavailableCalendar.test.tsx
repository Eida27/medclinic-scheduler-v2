import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClinicUnavailableDateRecord } from "@/server/repositories/clinic-unavailable-dates.repository";
import { ClinicUnavailableCalendar } from "./ClinicUnavailableCalendar";

const clinics = [
  { id: "60000000-0000-4000-8000-000000000001", name: "KABALAKA Clinic" },
  { id: "60000000-0000-4000-8000-000000000002", name: "CPU Clinic" },
];

const unavailableDates: ClinicUnavailableDateRecord[] = [
  {
    id: "unavailable-1",
    clinicId: clinics[0].id,
    clinicCode: "KABALAKA_CLINIC",
    clinicName: clinics[0].name,
    startDate: "2026-08-19",
    endDate: "2026-08-20",
    category: "MAINTENANCE",
    reason: "Generator testing",
    createdByName: "Clinic Admin",
    createdAt: "2026-07-01T00:00:00.000Z",
  },
  {
    id: "unavailable-past",
    clinicId: clinics[0].id,
    clinicCode: "KABALAKA_CLINIC",
    clinicName: clinics[0].name,
    startDate: "2026-08-14",
    endDate: "2026-08-14",
    category: "CLOSURE",
    reason: "Storm cleanup",
    createdByName: "Clinic Admin",
    createdAt: "2026-07-01T00:00:00.000Z",
  },
  {
    id: "unavailable-weekend",
    clinicId: clinics[0].id,
    clinicCode: "KABALAKA_CLINIC",
    clinicName: clinics[0].name,
    startDate: "2026-08-22",
    endDate: "2026-08-23",
    category: "STAFF_UNAVAILABILITY",
    reason: "Staff retreat",
    createdByName: "Clinic Admin",
    createdAt: "2026-07-01T00:00:00.000Z",
  },
];

function renderCalendar() {
  return render(
    <ClinicUnavailableCalendar
      clinics={clinics}
      unavailableDates={unavailableDates}
      initialMonth="2026-08"
      today="2026-08-17"
    />,
  );
}

function completeControls() {
  const user = userEvent.setup();
  fireEvent.change(screen.getByLabelText("Clinic"), { target: { value: clinics[0].id } });
  fireEvent.change(screen.getByLabelText("Category"), { target: { value: "MAINTENANCE" } });
  fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "Equipment maintenance" } });
  return user;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ClinicUnavailableCalendar", () => {
  it("disables invalid and non-working dates while keeping unavailable weekdays focusable", async () => {
    renderCalendar();

    expect(screen.getByRole("heading", { name: "August 2026" })).toBeInTheDocument();
    for (const weekday of ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]) {
      expect(screen.getByText(weekday)).toBeInTheDocument();
    }

    const availableDate = screen.getByRole("button", { name: "August 18, 2026 — available" });
    expect(availableDate).toBeDisabled();
    expect(screen.getByRole("button", { name: "August 13, 2026 — past" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "August 17, 2026 — today" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "August 29, 2026 — weekend" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "September 1, 2026 — outside current month" })).toBeDisabled();

    const unavailableDate = screen.getByRole("button", {
      name: "August 19, 2026 — unavailable: Maintenance, Generator testing",
    });
    expect(unavailableDate).toBeEnabled();
    expect(unavailableDate).not.toHaveAttribute("aria-disabled");
    expect(unavailableDate).not.toHaveAttribute("aria-controls");
    expect(unavailableDate).not.toHaveAttribute("aria-describedby");

    await completeControls();

    expect(availableDate).toBeEnabled();
    expect(unavailableDate).toBeEnabled();
    expect(unavailableDate).not.toHaveAttribute("aria-disabled");
  });

  it("selects past and weekend unavailable dates without posting while available peers stay disabled", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    renderCalendar();
    const user = await completeControls();
    const pastUnavailable = screen.getByRole("button", {
      name: "August 14, 2026 — unavailable: Closure, Storm cleanup",
    });
    const weekendUnavailable = screen.getByRole("button", {
      name: "August 22, 2026 — unavailable: Staff unavailability, Staff retreat",
    });

    expect(pastUnavailable).toBeEnabled();
    expect(weekendUnavailable).toBeEnabled();
    expect(pastUnavailable).not.toHaveAttribute("aria-disabled");
    expect(weekendUnavailable).not.toHaveAttribute("aria-disabled");
    expect(pastUnavailable).not.toHaveAttribute("aria-controls");
    expect(weekendUnavailable).not.toHaveAttribute("aria-controls");
    expect(screen.getByRole("button", { name: "August 13, 2026 — past" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "August 29, 2026 — weekend" })).toBeDisabled();

    await user.click(pastUnavailable);

    const details = screen.getByRole("region", { name: "Unavailable date details" });
    expect(pastUnavailable).toHaveAttribute("aria-pressed", "true");
    expect(pastUnavailable).toHaveAttribute("aria-controls", details.id);
    expect(pastUnavailable).toHaveAttribute("aria-describedby", details.id);
    expect(weekendUnavailable).not.toHaveAttribute("aria-controls");
    expect(within(details).getByText("Closure")).toBeInTheDocument();
    expect(within(details).getByText("Storm cleanup")).toBeInTheDocument();
    expect(within(details).getByText("August 14, 2026 to August 14, 2026")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();

    weekendUnavailable.focus();
    await user.keyboard(" ");

    expect(weekendUnavailable).toHaveFocus();
    expect(pastUnavailable).toHaveAttribute("aria-pressed", "false");
    expect(pastUnavailable).not.toHaveAttribute("aria-controls");
    expect(pastUnavailable).not.toHaveAttribute("aria-describedby");
    expect(weekendUnavailable).toHaveAttribute("aria-pressed", "true");
    expect(weekendUnavailable).toHaveAttribute("aria-controls", details.id);
    expect(weekendUnavailable).toHaveAttribute("aria-describedby", details.id);
    expect(within(details).getByText("Staff unavailability")).toBeInTheDocument();
    expect(within(details).getByText("Staff retreat")).toBeInTheDocument();
    expect(within(details).getByText("August 22, 2026 to August 23, 2026")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("selects unavailable dates by pointer or keyboard and discloses accessible details without posting", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    renderCalendar();
    const user = await completeControls();
    const firstUnavailableDate = screen.getByRole("button", {
      name: "August 19, 2026 — unavailable: Maintenance, Generator testing",
    });
    const secondUnavailableDate = screen.getByRole("button", {
      name: "August 20, 2026 — unavailable: Maintenance, Generator testing",
    });

    expect(firstUnavailableDate).not.toHaveAttribute("aria-controls");
    expect(firstUnavailableDate).not.toHaveAttribute("aria-describedby");
    expect(secondUnavailableDate).not.toHaveAttribute("aria-controls");
    expect(secondUnavailableDate).not.toHaveAttribute("aria-describedby");

    await user.click(firstUnavailableDate);

    const details = screen.getByRole("region", { name: "Unavailable date details" });
    expect(firstUnavailableDate).toHaveAttribute("aria-pressed", "true");
    expect(firstUnavailableDate).toHaveAttribute("aria-controls", details.id);
    expect(firstUnavailableDate).toHaveAttribute("aria-describedby", details.id);
    expect(secondUnavailableDate).not.toHaveAttribute("aria-controls");
    expect(within(details).getByText("KABALAKA Clinic")).toBeInTheDocument();
    expect(within(details).getByText("Maintenance")).toBeInTheDocument();
    expect(within(details).getByText("Generator testing")).toBeInTheDocument();
    expect(within(details).getByText("August 19, 2026 to August 20, 2026")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();

    secondUnavailableDate.focus();
    expect(secondUnavailableDate).toHaveFocus();
    await user.keyboard("{Enter}");

    expect(firstUnavailableDate).toHaveAttribute("aria-pressed", "false");
    expect(firstUnavailableDate).not.toHaveAttribute("aria-controls");
    expect(firstUnavailableDate).not.toHaveAttribute("aria-describedby");
    expect(secondUnavailableDate).toHaveAttribute("aria-pressed", "true");
    expect(secondUnavailableDate).toHaveAttribute("aria-controls", details.id);
    expect(secondUnavailableDate).toHaveAttribute("aria-describedby", details.id);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("moves between calendar months", async () => {
    const user = userEvent.setup();
    renderCalendar();

    await user.click(screen.getByRole("button", { name: "Next month" }));
    expect(screen.getByRole("heading", { name: "September 2026" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Previous month" }));
    expect(screen.getByRole("heading", { name: "August 2026" })).toBeInTheDocument();
  });

  it("posts one date once, shows saving state, and records the moved impact", async () => {
    const response = deferred<Response>();
    const fetchMock = vi.fn().mockReturnValue(response.promise);
    vi.stubGlobal("fetch", fetchMock);
    renderCalendar();
    const user = await completeControls();

    await user.click(screen.getByRole("button", { name: "August 18, 2026 — available" }));

    const savingDate = screen.getByRole("button", { name: "August 18, 2026 — saving" });
    expect(savingDate).toBeDisabled();
    expect(screen.getByRole("button", {
      name: "August 19, 2026 — unavailable: Maintenance, Generator testing",
    })).toBeDisabled();
    expect(screen.getByRole("button", { name: "August 21, 2026 — available" })).toBeDisabled();
    expect(within(savingDate).getByRole("status", { name: "Saving August 18, 2026" })).toBeInTheDocument();
    fireEvent.click(savingDate);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith("/api/clinic-unavailable-dates", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        clinicId: clinics[0].id,
        startDate: "2026-08-18",
        endDate: "2026-08-18",
        category: "MAINTENANCE",
        reason: "Equipment maintenance",
      }),
    });

    response.resolve(new Response(JSON.stringify({
      data: { id: "unavailable-new", movedStudentCount: 2, movedAppointmentCount: 4 },
    }), { status: 201, headers: { "content-type": "application/json" } }));

    expect(await screen.findByRole("alert")).toHaveTextContent("2 students");
    expect(screen.getByRole("alert")).toHaveTextContent("4 appointments");
    const newlyUnavailable = screen.getByRole("button", {
      name: "August 18, 2026 — unavailable: Maintenance, Equipment maintenance",
    });
    expect(newlyUnavailable).toBeEnabled();
    expect(newlyUnavailable).not.toHaveAttribute("aria-disabled");
  });

  it("rolls a date back to available after a 409 response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: {
        code: "CLINIC_BLOCK_OVERLAP",
        message: "This clinic already has an overlapping unavailable date.",
      },
    }), { status: 409, headers: { "content-type": "application/json" } })));
    renderCalendar();
    const user = await completeControls();

    await user.click(screen.getByRole("button", { name: "August 18, 2026 — available" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This clinic already has an overlapping unavailable date.",
    );
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "August 18, 2026 — available" })).toBeEnabled();
    });
  });
});
