// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors";

const {
  client,
  createReference,
  deleteReference,
  transaction,
  updateReference,
  writeAudit,
} = vi.hoisted(() => ({
  client: { query: vi.fn() },
  createReference: vi.fn(),
  deleteReference: vi.fn(),
  transaction: vi.fn(),
  updateReference: vi.fn(),
  writeAudit: vi.fn(),
}));

vi.mock("@/server/db/pool", () => ({ transaction }));
vi.mock("@/server/repositories/reference-data.repository", () => ({
  createReference,
  deleteReference,
  updateReference,
}));
vi.mock("@/server/repositories/audit.repository", () => ({ writeAudit }));

import { removeReference } from "./reference-data.service";

const referenceId = "20000000-0000-4000-8000-000000000099";
const actorUserId = "00000000-0000-4000-8000-000000000001";

describe("removeReference", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    transaction.mockImplementation(async (callback) => callback(client));
    deleteReference.mockResolvedValue({ id: referenceId });
    writeAudit.mockResolvedValue(undefined);
  });

  it("deletes and audits a reference in one transaction", async () => {
    await expect(removeReference("program", { id: referenceId }, actorUserId))
      .resolves.toEqual({ success: true });

    expect(transaction).toHaveBeenCalledOnce();
    expect(deleteReference).toHaveBeenCalledWith("program", referenceId, client);
    expect(writeAudit).toHaveBeenCalledWith(
      actorUserId,
      "REFERENCE_DELETED",
      "program",
      referenceId,
      {},
      client,
    );
  });

  it("rejects an invalid UUID before opening a transaction", async () => {
    await expect(removeReference("college", { id: "not-a-uuid" }, actorUserId))
      .rejects.toMatchObject({ name: "ZodError" });

    expect(transaction).not.toHaveBeenCalled();
    expect(deleteReference).not.toHaveBeenCalled();
  });

  it("returns a structured not-found error and does not audit", async () => {
    deleteReference.mockResolvedValue(undefined);

    await expect(removeReference("priorityGroup", { id: referenceId }, actorUserId))
      .rejects.toEqual(expect.objectContaining({
        code: "REFERENCE_NOT_FOUND",
        message: "Reference value not found.",
        status: 404,
      } satisfies Partial<AppError>));

    expect(writeAudit).not.toHaveBeenCalled();
  });

  it("maps a foreign-key violation to a conflict and does not audit", async () => {
    deleteReference.mockRejectedValue({ code: "23503" });

    await expect(removeReference("college", { id: referenceId }, actorUserId))
      .rejects.toEqual(expect.objectContaining({
        code: "REFERENCE_IN_USE",
        message: "This reference value is already in use and cannot be deleted.",
        status: 409,
      } satisfies Partial<AppError>));

    expect(writeAudit).not.toHaveBeenCalled();
  });

  it("does not mislabel an audit foreign-key failure as a reference conflict", async () => {
    const auditError = { code: "23503", constraint: "audit_logs_actor_user_id_fkey" };
    writeAudit.mockRejectedValue(auditError);

    await expect(removeReference("program", { id: referenceId }, actorUserId))
      .rejects.toBe(auditError);
  });
});
