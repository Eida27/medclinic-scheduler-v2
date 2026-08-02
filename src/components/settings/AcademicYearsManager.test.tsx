import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

import { AcademicYearsManager } from "./AcademicYearsManager";

const years = [{
  startYear: 2025,
  label: "2025–2026",
  closingDate: "2026-07-31",
  state: "CLOSING_SOON" as const,
  linkedSnapshotCount: 3,
}];

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("AcademicYearsManager", () => {
  beforeEach(() => vi.clearAllMocks());

  it("shows derived labels, state badges, closing dates, linked counts, and a July 31 create default", () => {
    render(<AcademicYearsManager years={years} />);

    expect(screen.getByText("2025–2026")).toBeVisible();
    expect(screen.getByText("CLOSING_SOON")).toBeVisible();
    expect(screen.getByText("3 linked historical records")).toBeVisible();
    expect(screen.getByLabelText("Academic-year start year")).toHaveValue(2026);
    expect(screen.getByLabelText("New academic-year closing date")).toHaveValue("2027-07-31");
    expect(screen.getByRole("button", { name: "Delete 2025–2026" })).toBeDisabled();
  });

  it("creates a year and reports success before refreshing", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: {} }, 201));
    vi.stubGlobal("fetch", fetchMock);
    render(<AcademicYearsManager years={years} />);

    await user.click(screen.getByRole("button", { name: "Add academic year" }));

    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    expect(fetchMock).toHaveBeenCalledWith("/api/settings/academic-years", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ startYear: 2026, closingDate: "2027-07-31" }),
    });
    expect(screen.getByRole("alert")).toHaveTextContent("Academic year created.");
  });

  it("updates the closing date and reports success", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: {} }));
    vi.stubGlobal("fetch", fetchMock);
    render(<AcademicYearsManager years={years} />);

    const row = screen.getByRole("listitem");
    const closingDate = within(row).getByLabelText("Closing date for 2025–2026");
    await user.clear(closingDate);
    await user.type(closingDate, "2026-07-15");
    await user.click(within(row).getByRole("button", { name: "Save 2025–2026 closing date" }));

    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    expect(fetchMock).toHaveBeenCalledWith("/api/settings/academic-years", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ startYear: 2025, closingDate: "2026-07-15" }),
    });
    expect(screen.getByRole("alert")).toHaveTextContent("Closing date updated.");
  });

  it("submits the closing date currently displayed by a native date input", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: {} }));
    vi.stubGlobal("fetch", fetchMock);
    render(<AcademicYearsManager years={years} />);

    const row = screen.getByRole("listitem");
    const closingDate = within(row).getByLabelText("Closing date for 2025–2026") as HTMLInputElement;
    closingDate.value = "2026-06-29";
    closingDate.dispatchEvent(new Event("input", { bubbles: true }));
    closingDate.dispatchEvent(new Event("blur", { bubbles: true }));
    expect(closingDate).toHaveValue("2026-06-29");

    await user.click(within(row).getByRole("button", { name: "Save 2025–2026 closing date" }));

    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    expect(fetchMock).toHaveBeenCalledWith("/api/settings/academic-years", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ startYear: 2025, closingDate: "2026-06-29" }),
    });
  });

  it("keeps a stale unlinked year visible when deletion returns a linked-record conflict", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({
      error: {
        code: "ACADEMIC_YEAR_IN_USE",
        message: "This academic year has linked historical records and cannot be deleted.",
      },
    }, 409)));
    render(<AcademicYearsManager years={[{ ...years[0], linkedSnapshotCount: 0 }]} />);

    await user.click(screen.getByRole("button", { name: "Delete 2025–2026" }));
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent("Delete 2025–2026?");
    await user.click(within(dialog).getByRole("button", { name: "Delete academic year" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This academic year has linked historical records and cannot be deleted.",
    );
    expect(screen.getByText("2025–2026")).toBeVisible();
    expect(refresh).not.toHaveBeenCalled();
  });
});
