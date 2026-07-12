import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { redirect, notFound, requireUser, getScheduleBatch } = vi.hoisted(() => ({
  redirect: vi.fn(),
  notFound: vi.fn(),
  requireUser: vi.fn(),
  getScheduleBatch: vi.fn(),
}));

vi.mock("next/navigation", () => ({ redirect, notFound }));
vi.mock("@/server/auth/current-user", () => ({ requireUser }));
vi.mock("@/server/repositories/coordinator-schedules.repository", () => ({ getScheduleBatch }));

import BatchDetailsPage from "./page";

const batch = {
  id: "batch-1",
  importGroupId: null,
  batchName: "Historical batch",
  clinicName: "KABALAKA Clinic",
  clinicCode: "KABALAKA_CLINIC",
  status: "VALIDATED",
  programName: "BSIT",
  collegeName: "College of Computer Studies",
  validationSummary: { totalItems: 1, validCount: 1, warningCount: 0, conflictCount: 0 },
  items: [{
    id: "item-1",
    studentName: "Historical Student",
    studentNumber: "20-0000-01",
    scheduleType: "LABORATORY",
    targetDate: "2026-12-14",
    targetWeekStart: null,
    targetWeekEnd: null,
    priorityGroupName: "Regular",
    status: "VALID",
    validationIssues: [],
  }],
};

describe("BatchDetailsPage legacy compatibility", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireUser.mockResolvedValue({ userId: "admin-1", role: "ADMIN" });
    getScheduleBatch.mockResolvedValue(batch);
  });

  it("redirects an administrator's grouped child to grouped import detail", async () => {
    getScheduleBatch.mockResolvedValue({ ...batch, importGroupId: "import-1" });

    await BatchDetailsPage({ params: Promise.resolve({ batchId: "batch-1" }) });

    expect(redirect).toHaveBeenCalledWith("/students/schedule-imports/import-1");
  });

  it("redirects clinic staff away from grouped import detail", async () => {
    requireUser.mockResolvedValue({ userId: "staff-1", role: "CLINIC_STAFF" });
    getScheduleBatch.mockResolvedValue({ ...batch, importGroupId: "import-1" });

    await BatchDetailsPage({ params: Promise.resolve({ batchId: "batch-1" }) });

    expect(redirect).toHaveBeenCalledWith("/students");
  });

  it("renders historical ungrouped batches read-only", async () => {
    render(await BatchDetailsPage({ params: Promise.resolve({ batchId: "batch-1" }) }));

    expect(screen.getByRole("heading", { name: "Historical batch" })).toBeVisible();
    expect(screen.getByText("KABALAKA Clinic · 1 requests")).toBeVisible();
    expect(screen.getByText("Historical Student")).toBeVisible();
    expect(screen.getByText(/read-only historical batch/i)).toBeVisible();
    expect(screen.queryByText(/batch actions/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /generate|publish|validate/i })).not.toBeInTheDocument();
  });
});
