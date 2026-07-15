import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ScheduleImportActions } from "./ScheduleImportActions";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

function successfulResponse() {
  return {
    ok: true,
    json: async () => ({ data: {} }),
  };
}

describe("ScheduleImportActions", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    refresh.mockReset();
  });

  it("validates a draft through the grouped import endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(successfulResponse());
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<ScheduleImportActions importId="import-1" status="DRAFT" actorRole="ADMIN" />);

    await user.click(screen.getByRole("button", { name: "Validate import" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/schedule-imports/import-1/validate",
      { method: "POST" },
    );
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("generates through the grouped endpoint with an optional override reason", async () => {
    const fetchMock = vi.fn().mockResolvedValue(successfulResponse());
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<ScheduleImportActions importId="import-2" status="VALIDATED" actorRole="ADMIN" />);

    await user.type(
      screen.getByLabelText("Capacity override reason (optional)"),
      "Approved for graduation processing.",
    );
    await user.click(screen.getByRole("button", { name: "Generate appointments" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const [url, request] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/schedule-imports/import-2/generate");
    expect(request).toMatchObject({
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    expect(JSON.parse(request.body)).toEqual({
      overrideReason: "Approved for graduation processing.",
    });
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("publishes through the grouped endpoint only after explicit confirmation", async () => {
    const fetchMock = vi.fn().mockResolvedValue(successfulResponse());
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<ScheduleImportActions importId="import-3" status="GENERATED" actorRole="ADMIN" />);

    await user.click(screen.getByRole("button", { name: "Publish schedules" }));
    expect(fetchMock).not.toHaveBeenCalled();
    const dialog = screen.getByRole("dialog", { name: "Publish imported schedules?" });
    expect(dialog).toHaveTextContent("visible to students and clinic staff");

    await user.click(within(dialog).getByRole("button", { name: "Publish schedules" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const [url, request] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/schedule-imports/import-3/publish");
    expect(request).toMatchObject({
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    expect(JSON.parse(request.body)).toEqual({ confirm: true });
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("shows pending and structured API errors without refreshing", async () => {
    let resolveResponse!: (value: unknown) => void;
    const fetchMock = vi.fn().mockReturnValue(new Promise((resolve) => {
      resolveResponse = resolve;
    }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<ScheduleImportActions importId="import-4" status="DRAFT" actorRole="ADMIN" />);

    await user.click(screen.getByRole("button", { name: "Validate import" }));
    expect(screen.getByRole("button", { name: "Validating..." })).toBeDisabled();

    resolveResponse({
      ok: false,
      json: async () => ({
        error: {
          message: "Import validation failed.",
          fields: {
            laboratory: ["Resolve the duplicate laboratory request."],
            physicalExamination: ["Review the physical examination capacity."],
          },
        },
      }),
    });

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Import validation failed.");
    expect(alert).toHaveTextContent("Resolve the duplicate laboratory request.");
    expect(alert).toHaveTextContent("Review the physical examination capacity.");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("closes publication confirmation so a structured publish error is visible", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({ error: { message: "Publication was rolled back." } }),
    }));
    const user = userEvent.setup();
    render(<ScheduleImportActions importId="import-4" status="GENERATED" actorRole="ADMIN" />);

    await user.click(screen.getByRole("button", { name: "Publish schedules" }));
    const dialog = screen.getByRole("dialog", { name: "Publish imported schedules?" });
    await user.click(within(dialog).getByRole("button", { name: "Publish schedules" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Publication was rolled back.");
    expect(screen.queryByRole("dialog", { name: "Publish imported schedules?" })).not.toBeInTheDocument();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("renders published links and safe non-action states without invalid mutations", () => {
    const { rerender } = render(<ScheduleImportActions importId="import-5" status="PUBLISHED" actorRole="ADMIN" />);
    expect(screen.getByRole("link", { name: "View Laboratory schedules" })).toHaveAttribute(
      "href",
      "/laboratory",
    );
    expect(screen.getByRole("link", { name: "View Physical exam schedules" })).toHaveAttribute(
      "href",
      "/physical-exam",
    );

    rerender(<ScheduleImportActions importId="import-5" status="NEEDS_REVIEW" actorRole="ADMIN" />);
    expect(screen.getByText(/child batches are not synchronized/i)).toBeVisible();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();

    rerender(<ScheduleImportActions importId="import-5" status="CANCELLED" actorRole="ADMIN" />);
    expect(screen.getByText(/cancelled import cannot be changed/i)).toBeVisible();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("shows coordinators an administrator-review notice instead of lifecycle controls", () => {
    const { rerender } = render(
      <ScheduleImportActions importId="import-6" status="VALIDATED" actorRole="COORDINATOR" />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent(/administrator review is required/i);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();

    rerender(<ScheduleImportActions importId="import-6" status="PUBLISHED" actorRole="COORDINATOR" />);
    expect(screen.getByRole("link", { name: "View students" })).toHaveAttribute("href", "/students");
    expect(screen.getByRole("link", { name: "View import history" })).toHaveAttribute(
      "href",
      "/students?view=schedule-imports",
    );
    expect(screen.queryByRole("link", { name: /Laboratory schedules/i })).not.toBeInTheDocument();
  });
});
