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
      }), { status: 200, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: { scope: "actionable", items: [] },
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
    expect(fetch).toHaveBeenNthCalledWith(3, "/api/admin/email-deliveries?scope=actionable", { cache: "no-store" });
  });

  it("refreshes actionable failures after a successful retry", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: { ...failure, state: "Pending", actionable: false },
      }), { status: 200, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: { scope: "actionable", items: [] },
      }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetch);
    const user = userEvent.setup();
    render(<EmailDeliveryMonitor initialItems={[failure]} />);

    await user.click(screen.getByRole("button", { name: "Retry delivery" }));

    expect(await screen.findByRole("status")).toHaveTextContent("Delivery queued for retry.");
    expect(await screen.findByText("No actionable delivery failures.")).toBeVisible();
    expect(fetch).toHaveBeenNthCalledWith(2, "/api/admin/email-deliveries?scope=actionable", { cache: "no-store" });
  });

  it("reports an idempotent queue-current result without claiming a new row", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: {
          code: "STALE_SCHEDULE_EMAIL",
          message: "This schedule email is no longer current.",
          details: {
            currentState: {
              studentNumber: "24-0001",
              laboratory: null,
              physicalExam: null,
              manualResolutionOpen: true,
            },
          },
        },
      }), { status: 409, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: { queued: false, currentState: { studentNumber: "24-0001" } },
      }), { status: 200, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: { scope: "actionable", items: [] },
      }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetch);
    const user = userEvent.setup();
    render(<EmailDeliveryMonitor initialItems={[failure]} />);

    await user.click(screen.getByRole("button", { name: "Retry delivery" }));
    await user.click(await screen.findByRole("button", { name: "Queue current schedule" }));

    expect(await screen.findByRole("status")).toHaveTextContent("Current schedule was already queued.");
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

  it("shows an accessible filter error for a non-OK response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: { message: "Delivery history is temporarily unavailable." },
    }), { status: 503, headers: { "Content-Type": "application/json" } })));
    const user = userEvent.setup();
    render(<EmailDeliveryMonitor initialItems={[failure]} />);

    await user.selectOptions(screen.getByRole("combobox", { name: "View" }), "history");
    expect(await screen.findByRole("alert")).toHaveTextContent("Delivery history is temporarily unavailable.");
    expect(screen.getByText("s***@example.test")).toBeVisible();
  });

  it("handles a non-JSON filter failure without an unhandled rejection", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("Bad gateway", { status: 502 })));
    const user = userEvent.setup();
    render(<EmailDeliveryMonitor initialItems={[failure]} />);

    await user.selectOptions(screen.getByRole("combobox", { name: "View" }), "history");
    expect(await screen.findByRole("alert")).toHaveTextContent("Unable to load email deliveries. Try again.");
  });

  it("shows loading state and ignores an older filter response", async () => {
    let resolveHistory!: (response: Response) => void;
    let resolveActionable!: (response: Response) => void;
    const historyResponse = new Promise<Response>((resolve) => { resolveHistory = resolve; });
    const actionableResponse = new Promise<Response>((resolve) => { resolveActionable = resolve; });
    const fetch = vi.fn()
      .mockImplementationOnce(() => historyResponse)
      .mockImplementationOnce(() => actionableResponse);
    vi.stubGlobal("fetch", fetch);
    const user = userEvent.setup();
    const latest = { ...failure, id: "delivery-2", destination: "l***@example.test" };
    render(<EmailDeliveryMonitor initialItems={[failure]} />);

    await user.selectOptions(screen.getByRole("combobox", { name: "View" }), "history");
    expect(screen.getByRole("status")).toHaveTextContent("Loading email deliveries...");
    await user.selectOptions(screen.getByRole("combobox", { name: "View" }), "actionable");
    resolveActionable(new Response(JSON.stringify({ data: { items: [latest] } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    expect(await screen.findByText("l***@example.test")).toBeVisible();

    resolveHistory(new Response(JSON.stringify({ data: { items: [failure] } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    await waitFor(() => expect(screen.queryByText("Loading email deliveries...")).not.toBeInTheDocument());
    expect(screen.getByText("l***@example.test")).toBeVisible();
    expect(screen.queryByText("s***@example.test")).not.toBeInTheDocument();
  });

  it("handles a rejected mutation request without an unhandled rejection", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network disconnected")));
    const user = userEvent.setup();
    render(<EmailDeliveryMonitor initialItems={[failure]} />);

    await user.click(screen.getByRole("button", { name: "Retry delivery" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Unable to update email delivery. Try again.");
    expect(screen.getByRole("button", { name: "Retry delivery" })).toBeEnabled();
  });

  it("handles a non-JSON mutation failure without exposing its response body", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      "upstream smtp password=secret",
      { status: 500 },
    )));
    const user = userEvent.setup();
    render(<EmailDeliveryMonitor initialItems={[failure]} />);

    await user.click(screen.getByRole("button", { name: "Retry delivery" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Unable to update email delivery. Try again.");
    expect(document.body.textContent).not.toContain("password=secret");
  });
});
