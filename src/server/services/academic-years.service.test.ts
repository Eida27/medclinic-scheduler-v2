// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors";

const {
  client,
  createAcademicYearWithClient,
  deleteAcademicYearWithClient,
  listAcademicYearRecords,
  lockAcademicYearWithSnapshotCount,
  transaction,
  updateAcademicYearClosingDateWithClient,
  writeAudit,
} = vi.hoisted(() => ({
  client: { query: vi.fn() },
  createAcademicYearWithClient: vi.fn(),
  deleteAcademicYearWithClient: vi.fn(),
  listAcademicYearRecords: vi.fn(),
  lockAcademicYearWithSnapshotCount: vi.fn(),
  transaction: vi.fn(),
  updateAcademicYearClosingDateWithClient: vi.fn(),
  writeAudit: vi.fn(),
}));

vi.mock("@/server/db/pool", () => ({ transaction }));
vi.mock("@/server/repositories/academic-years.repository", () => ({
  createAcademicYearWithClient,
  deleteAcademicYearWithClient,
  listAcademicYearRecords,
  lockAcademicYearWithSnapshotCount,
  updateAcademicYearClosingDateWithClient,
}));
vi.mock("@/server/repositories/audit.repository", () => ({ writeAudit }));

import {
  createAcademicYear,
  deleteAcademicYear,
  listAcademicYears,
  updateAcademicYear,
} from "./academic-years.service";

const actorUserId = "00000000-0000-4000-8000-000000000001";
const storedYear = {
  startYear: 2025,
  closingDate: "2026-07-31",
  createdBy: actorUserId,
  updatedBy: actorUserId,
  createdAt: new Date("2025-08-01T00:00:00.000Z"),
  updatedAt: new Date("2025-08-01T00:00:00.000Z"),
  linkedSnapshotCount: 3,
};

describe("academic-year administration service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    transaction.mockImplementation(async (callback) => callback(client));
    createAcademicYearWithClient.mockResolvedValue(storedYear);
    lockAcademicYearWithSnapshotCount.mockResolvedValue(storedYear);
    updateAcademicYearClosingDateWithClient.mockResolvedValue({
      ...storedYear,
      closingDate: "2026-07-15",
    });
    deleteAcademicYearWithClient.mockResolvedValue(storedYear);
    writeAudit.mockResolvedValue(undefined);
  });

  it("derives labels and states for listed years with linked snapshot counts", async () => {
    listAcademicYearRecords.mockResolvedValue([storedYear]);

    await expect(listAcademicYears(new Date("2026-07-16T16:00:00.000Z"))).resolves.toEqual([{
      ...storedYear,
      label: "2025–2026",
      state: "CLOSING_SOON",
    }]);
  });

  it.each(["2025-08-01", "2026-07-31"])("accepts the closing-date boundary %s", async (closingDate) => {
    await expect(createAcademicYear({ startYear: 2025, closingDate }, actorUserId)).resolves.toBeDefined();
    expect(createAcademicYearWithClient).toHaveBeenCalledWith(client, {
      startYear: 2025,
      closingDate,
      actorUserId,
    });
  });

  it.each([2019, 2101])("rejects the unsupported start year %s", async (startYear) => {
    await expect(createAcademicYear({ startYear, closingDate: `${startYear + 1}-07-31` }, actorUserId))
      .rejects.toMatchObject({ name: "ZodError" });
    expect(transaction).not.toHaveBeenCalled();
  });

  it.each(["2025-07-31", "2026-08-01", "2026-02-30", "not-a-date"])(
    "rejects the out-of-cycle or invalid closing date %s before starting a transaction",
    async (closingDate) => {
      await expect(createAcademicYear({ startYear: 2025, closingDate }, actorUserId))
        .rejects.toMatchObject({ name: "ZodError" });
      expect(transaction).not.toHaveBeenCalled();
    },
  );

  it("audits a created year with its derived label", async () => {
    await createAcademicYear({ startYear: 2025, closingDate: "2026-07-31" }, actorUserId);

    expect(writeAudit).toHaveBeenCalledWith(
      actorUserId,
      "ACADEMIC_YEAR_CREATED",
      "academic_year",
      "2025",
      { startYear: 2025, label: "2025–2026", closingDate: "2026-07-31" },
      client,
    );
  });

  it("updates only the closing date and audits its old and new values", async () => {
    await updateAcademicYear({ startYear: 2025, closingDate: "2026-07-15" }, actorUserId);

    expect(updateAcademicYearClosingDateWithClient).toHaveBeenCalledWith(client, {
      startYear: 2025,
      closingDate: "2026-07-15",
      actorUserId,
    });
    expect(writeAudit).toHaveBeenCalledWith(
      actorUserId,
      "ACADEMIC_YEAR_CLOSING_DATE_UPDATED",
      "academic_year",
      "2025",
      { oldClosingDate: "2026-07-31", newClosingDate: "2026-07-15" },
      client,
    );
  });

  it("rejects deletion while snapshots are linked without deleting or auditing", async () => {
    await expect(deleteAcademicYear({ startYear: 2025 }, actorUserId)).rejects.toEqual(
      expect.objectContaining({
        code: "ACADEMIC_YEAR_IN_USE",
        status: 409,
        details: { linkedSnapshotCount: 3 },
      } satisfies Partial<AppError>),
    );
    expect(deleteAcademicYearWithClient).not.toHaveBeenCalled();
    expect(writeAudit).not.toHaveBeenCalled();
  });

  it("deletes and audits an unlinked academic year in one transaction", async () => {
    lockAcademicYearWithSnapshotCount.mockResolvedValue({ ...storedYear, linkedSnapshotCount: 0 });

    await expect(deleteAcademicYear({ startYear: 2025 }, actorUserId)).resolves.toEqual({ success: true });
    expect(deleteAcademicYearWithClient).toHaveBeenCalledWith(client, 2025);
    expect(writeAudit).toHaveBeenCalledWith(
      actorUserId,
      "ACADEMIC_YEAR_DELETED",
      "academic_year",
      "2025",
      { startYear: 2025, label: "2025–2026", closingDate: "2026-07-31" },
      client,
    );
  });

  it("returns not found for an unknown academic year", async () => {
    lockAcademicYearWithSnapshotCount.mockResolvedValue(undefined);

    await expect(updateAcademicYear({ startYear: 2025, closingDate: "2026-07-31" }, actorUserId))
      .rejects.toMatchObject({ code: "ACADEMIC_YEAR_NOT_FOUND", status: 404 });
    expect(updateAcademicYearClosingDateWithClient).not.toHaveBeenCalled();
    expect(writeAudit).not.toHaveBeenCalled();
  });
});
