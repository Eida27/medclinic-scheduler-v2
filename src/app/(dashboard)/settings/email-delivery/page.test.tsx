import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({
  listAdminEmailDeliveries: vi.fn(),
  forbidden: vi.fn(() => { throw new Error("NEXT_FORBIDDEN"); }),
  requireAdministrator: vi.fn(),
}));

vi.mock("next/navigation", () => ({ forbidden: mocks.forbidden }));
vi.mock("@/server/auth/admin-authorization", () => ({ requireAdministrator: mocks.requireAdministrator }));
vi.mock("@/server/services/admin-email-deliveries.service", () => ({
  listAdminEmailDeliveries: mocks.listAdminEmailDeliveries,
}));

import EmailDeliveryPage from "./page";

describe("EmailDeliveryPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdministrator.mockResolvedValue({ userId: "admin", role: "ADMIN" });
    mocks.listAdminEmailDeliveries.mockResolvedValue({ scope: "actionable", items: [] });
  });

  it("authorizes an administrator and defaults to actionable delivery failures", async () => {
    render(await EmailDeliveryPage());
    expect(mocks.requireAdministrator).toHaveBeenCalledOnce();
    expect(mocks.listAdminEmailDeliveries).toHaveBeenCalledWith({});
    expect(screen.getByRole("heading", { level: 1, name: "Email delivery" })).toBeVisible();
    expect(screen.getByText("No actionable delivery failures.")).toBeVisible();
  });

  it.each(["COORDINATOR", "CLINIC_STAFF", "STUDENT"])("returns forbidden for an authenticated %s", async (role) => {
    mocks.requireAdministrator.mockRejectedValue(new AppError("FORBIDDEN", `${role} forbidden`, 403));
    await expect(EmailDeliveryPage()).rejects.toThrow("NEXT_FORBIDDEN");
    expect(mocks.forbidden).toHaveBeenCalledOnce();
    expect(mocks.listAdminEmailDeliveries).not.toHaveBeenCalled();
  });

  it("preserves anonymous unauthorized behavior", async () => {
    mocks.requireAdministrator.mockRejectedValue(new AppError("UNAUTHENTICATED", "Please sign in.", 401));
    await expect(EmailDeliveryPage()).rejects.toMatchObject({ code: "UNAUTHENTICATED", status: 401 });
    expect(mocks.forbidden).not.toHaveBeenCalled();
    expect(mocks.listAdminEmailDeliveries).not.toHaveBeenCalled();
  });
});
