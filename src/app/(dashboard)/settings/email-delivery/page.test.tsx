import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({
  listAdminEmailDeliveries: vi.fn(),
  notFound: vi.fn(() => { throw new Error("NEXT_NOT_FOUND"); }),
  requireUser: vi.fn(),
}));

vi.mock("next/navigation", () => ({ notFound: mocks.notFound }));
vi.mock("@/server/auth/current-user", () => ({ requireUser: mocks.requireUser }));
vi.mock("@/server/services/admin-email-deliveries.service", () => ({
  listAdminEmailDeliveries: mocks.listAdminEmailDeliveries,
}));

import EmailDeliveryPage from "./page";

describe("EmailDeliveryPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireUser.mockResolvedValue({ userId: "admin", role: "ADMIN" });
    mocks.listAdminEmailDeliveries.mockResolvedValue({ scope: "actionable", items: [] });
  });

  it("authorizes an administrator and defaults to actionable delivery failures", async () => {
    render(await EmailDeliveryPage());
    expect(mocks.requireUser).toHaveBeenCalledWith(["ADMIN"]);
    expect(mocks.listAdminEmailDeliveries).toHaveBeenCalledWith({});
    expect(screen.getByRole("heading", { level: 1, name: "Email delivery" })).toBeVisible();
    expect(screen.getByText("No actionable delivery failures.")).toBeVisible();
  });

  it.each(["COORDINATOR", "CLINIC_STAFF"])("hides the page from %s", async (role) => {
    mocks.requireUser.mockRejectedValue(new AppError("FORBIDDEN", `${role} forbidden`, 403));
    await expect(EmailDeliveryPage()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mocks.notFound).toHaveBeenCalledOnce();
    expect(mocks.listAdminEmailDeliveries).not.toHaveBeenCalled();
  });
});
