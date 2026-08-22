import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EmailDeliveryMonitor } from "./EmailDeliveryMonitor";

const failure = {
  id: "delivery-1",
  destination: "s***@example.test",
  state: "Failed" as const,
  attempts: 10,
  lastAttempt: { at: "2026-08-22T02:00:00.000Z", state: "Failed" as const },
  context: {
    studentNumber: "24-0001",
    messageKind: "SCHEDULE" as const,
    notificationType: "SCHEDULE_CURRENT_STATE",
    sourceType: "CURRENT_SCHEDULE_STATE",
    sourceId: "safe-source",
  },
  failureReason: "Email service connection failed.",
  actionable: true,
};

describe("EmailDeliveryMonitor", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("shows masked actionable failures without override or schedule-edit affordances", () => {
    render(<EmailDeliveryMonitor initialItems={[failure]} />);
    expect(screen.getByText("s***@example.test")).toBeVisible();
    expect(screen.getByText("Email service connection failed.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Retry delivery" })).toBeVisible();
    expect(screen.queryByRole("button", { name: /queue current/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/verification override|mark verified|edit schedule/i)).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain("student@example.test");
  });

  it("reveals safe current schedule state after stale rejection and queues it separately", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: {
          code: "STALE_SCHEDULE_EMAIL",
          message: "This schedule email is no longer current.",
          details: {
            guidance: "Queue the student's current schedule instead.",
            currentState: {
              studentNumber: "24-0001",
              laboratory: {
                scheduleType: "LABORATORY",
                status: "PENDING",
                date: "2026-09-14",
                affectedDate: null,
                location: "KABALAKA Clinic",
              },
              physicalExam: null,
              manualResolutionOpen: false,
            },
          },
        },
      }), { status: 409, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: { queued: true, currentState: { studentNumber: "24-0001" } },
      }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetch);
    const user = userEvent.setup();
    render(<EmailDeliveryMonitor initialItems={[failure]} />);

    await user.click(screen.getByRole("button", { name: "Retry delivery" }));
    expect(await screen.findByText("2026-09-14 at KABALAKA Clinic")).toBeVisible();
    expect(screen.getByText("Queue the student's current schedule instead.")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Queue current schedule" }));
    await waitFor(() => expect(screen.getByText("Current schedule queued.")).toBeVisible());
    expect(fetch).toHaveBeenNthCalledWith(1, "/api/admin/email-deliveries/delivery-1/retry", { method: "POST" });
    expect(fetch).toHaveBeenNthCalledWith(2, "/api/admin/email-deliveries/delivery-1/queue-current", { method: "POST" });
  });

  it("loads explicit history filters without making history the default", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: { scope: "history", items: [] },
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetch);
    const user = userEvent.setup();
    render(<EmailDeliveryMonitor initialItems={[failure]} />);

    expect(screen.getByRole("combobox", { name: "View" })).toHaveValue("actionable");
    await user.selectOptions(screen.getByRole("combobox", { name: "View" }), "history");
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(
      "/api/admin/email-deliveries?scope=history",
      { cache: "no-store" },
    ));
  });
});
