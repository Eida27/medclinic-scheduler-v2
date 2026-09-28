// @vitest-environment node
import { beforeEach, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors";

const { transaction } = vi.hoisted(() => ({ transaction: vi.fn() }));
vi.mock("@/server/db/pool", () => ({ transaction, pool: {} }));

import { completePhysicalExam } from "./certificate.service";

beforeEach(() => transaction.mockReset());

it("returns a committed identical request when preparation sees the examination completed", async () => {
  const outcome = {
    certificateId: "11111111-1111-4111-8111-111111111111",
    revisionId: "22222222-2222-4222-8222-222222222222",
    appointmentId: "33333333-3333-4333-8333-333333333333",
    certificateNumber: "MC-2026-11111111",
  };
  transaction.mockResolvedValueOnce(null)
    .mockRejectedValueOnce(new AppError("EXAMINATION_NOT_PENDING", "This examination cannot be completed.", 409))
    .mockResolvedValueOnce(outcome);

  await expect(completePhysicalExam(outcome.appointmentId, {
    requestId: "44444444-4444-4444-8444-444444444444",
    physicianId: "55555555-5555-4555-8555-555555555555",
    physicianVersion: 1,
    examinationDate: "2026-09-28",
    sex: "Female",
    classification: "A",
    attested: true,
  }, { userId: "66666666-6666-4666-8666-666666666666", fullName: "Clinician", email: "test@example.com", role: "ADMIN" }))
    .resolves.toEqual(outcome);
  expect(transaction).toHaveBeenCalledTimes(3);
});

it("keeps the preparation error when no identical request committed", async () => {
  const error = new AppError("EXAMINATION_NOT_PENDING", "This examination cannot be completed.", 409);
  transaction.mockResolvedValueOnce(null).mockRejectedValueOnce(error).mockResolvedValueOnce(null);
  await expect(completePhysicalExam("33333333-3333-4333-8333-333333333333", {
    requestId: "44444444-4444-4444-8444-444444444444",
    physicianId: "55555555-5555-4555-8555-555555555555",
    physicianVersion: 1,
    examinationDate: "2026-09-28",
    sex: "Female",
    classification: "A",
    attested: true,
  }, { userId: "66666666-6666-4666-8666-666666666666", fullName: "Clinician", email: "test@example.com", role: "ADMIN" }))
    .rejects.toBe(error);
  expect(transaction).toHaveBeenCalledTimes(3);
});
