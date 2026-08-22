import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({
  requireAdministrator: vi.fn(),
  listAdminEmailDeliveries: vi.fn(),
  retryAdminEmailDelivery: vi.fn(),
  queueCurrentAdminEmailDelivery: vi.fn(),
}));

vi.mock("@/server/auth/admin-authorization", () => ({ requireAdministrator: mocks.requireAdministrator }));
vi.mock("@/server/services/admin-email-deliveries.service", () => ({
  listAdminEmailDeliveries: mocks.listAdminEmailDeliveries,
  retryAdminEmailDelivery: mocks.retryAdminEmailDelivery,
  queueCurrentAdminEmailDelivery: mocks.queueCurrentAdminEmailDelivery,
}));

import { GET } from "./route";
import { POST as retry } from "./[id]/retry/route";
import { POST as queueCurrent } from "./[id]/queue-current/route";

const admin = { userId: "admin-user", role: "ADMIN" as const };
const safeDelivery = {
  id: "delivery-1",
  destination: "s***@example.test",
  state: "Failed",
  attempts: 10,
  lastAttempt: { at: "2026-08-22T02:00:00.000Z", state: "Failed" },
  context: {
    studentNumber: "24-0001",
    messageKind: "SCHEDULE",
    notificationType: "SCHEDULE_CURRENT_STATE",
    sourceType: "CURRENT_SCHEDULE_STATE",
    sourceId: null,
  },
  failureReason: "Email service authentication failed.",
  actionable: true,
};

describe("administrator email-delivery APIs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdministrator.mockResolvedValue(admin);
    mocks.listAdminEmailDeliveries.mockResolvedValue({ scope: "actionable", items: [safeDelivery] });
    mocks.retryAdminEmailDelivery.mockResolvedValue({ ...safeDelivery, state: "Pending", attempts: 0, actionable: false });
    mocks.queueCurrentAdminEmailDelivery.mockResolvedValue({
      queued: true,
      currentState: { studentNumber: "24-0001", laboratory: null, physicalExam: null, manualResolutionOpen: false },
    });
  });

  it("returns the masked and sanitized default list and parses explicit history filters", async () => {
    const defaultResponse = await GET(new Request("http://localhost/api/admin/email-deliveries"));
    expect(defaultResponse.status).toBe(200);
    expect(await defaultResponse.json()).toEqual({ data: { scope: "actionable", items: [safeDelivery] } });
    expect(JSON.stringify(await (await GET(new Request("http://localhost/api/admin/email-deliveries"))).json()))
      .not.toContain("student@example.test");
    expect(JSON.stringify(await (await GET(new Request("http://localhost/api/admin/email-deliveries"))).json()))
      .not.toMatch(/[0-9a-f]{64}/i);

    await GET(new Request("http://localhost/api/admin/email-deliveries?scope=history&state=Retrying"));
    expect(mocks.listAdminEmailDeliveries).toHaveBeenLastCalledWith({ scope: "history", state: "Retrying" });
    expect(mocks.requireAdministrator).toHaveBeenCalled();
  });

  it("retries and queues current state with the authenticated administrator identity", async () => {
    const context = { params: Promise.resolve({ id: "delivery-1" }) };
    const retryResponse = await retry(new Request("http://localhost", { method: "POST" }), context);
    expect(retryResponse.status).toBe(200);
    expect(mocks.retryAdminEmailDelivery).toHaveBeenCalledWith("delivery-1", "admin-user");

    const currentResponse = await queueCurrent(new Request("http://localhost", { method: "POST" }), context);
    expect(currentResponse.status).toBe(200);
    expect(await currentResponse.json()).toMatchObject({ data: { queued: true } });
    expect(mocks.queueCurrentAdminEmailDelivery).toHaveBeenCalledWith("delivery-1", "admin-user");
  });

  it.each([
    ["list", () => GET(new Request("http://localhost/api/admin/email-deliveries"))],
    ["retry", (context: { params: Promise<{ id: string }> }) => retry(new Request("http://localhost", { method: "POST" }), context)],
    ["queue current", (context: { params: Promise<{ id: string }> }) => queueCurrent(new Request("http://localhost", { method: "POST" }), context)],
  ])("returns 403 and no data/control operation when a coordinator requests %s", async (_label, request) => {
    mocks.requireAdministrator.mockRejectedValue(new AppError("FORBIDDEN", "Administrators only.", 403));
    const response = await request({ params: Promise.resolve({ id: "delivery-1" }) });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: { code: "FORBIDDEN", message: "Administrators only." },
    });
    expect(mocks.listAdminEmailDeliveries).not.toHaveBeenCalled();
    expect(mocks.retryAdminEmailDelivery).not.toHaveBeenCalled();
    expect(mocks.queueCurrentAdminEmailDelivery).not.toHaveBeenCalled();
  });

  it("returns the stale schedule conflict and safe current state without raw delivery data", async () => {
    mocks.retryAdminEmailDelivery.mockRejectedValue(new AppError(
      "STALE_SCHEDULE_EMAIL",
      "This schedule email is no longer current.",
      409,
      undefined,
      {
        guidance: "Queue the student's current schedule instead.",
        currentState: { studentNumber: "24-0001", laboratory: null, physicalExam: null, manualResolutionOpen: false },
      },
    ));
    const response = await retry(
      new Request("http://localhost", { method: "POST" }),
      { params: Promise.resolve({ id: "delivery-1" }) },
    );
    const payload = await response.json();
    expect(response.status).toBe(409);
    expect(payload.error).toMatchObject({ code: "STALE_SCHEDULE_EMAIL", details: { currentState: { studentNumber: "24-0001" } } });
    expect(JSON.stringify(payload)).not.toMatch(/smtp|token=|student@example\.test|cipher/i);
  });
});
