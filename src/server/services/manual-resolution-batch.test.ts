// @vitest-environment node
import { describe, expect, it } from "vitest";
import { manualResolutionBatchSchema, signManualResolutionPreview, verifyManualResolutionPreview, projectedManualCapacity } from "./manual-resolution-batch.service";
const payload = { cases: [{ caseId: "11111111-1111-4111-8111-111111111111", expectedOptimisticToken: "22222222-2222-4222-8222-222222222222" }], physicalExamDate: "2026-10-06", replaceRelatedServices: false, preservationAcknowledged: true as const, reason: "New schedule" };
describe("ordinary manual resolution contract", () => {
  it("bounds selection and rejects duplicates, unknown fields and invalid dates", () => {
    expect(manualResolutionBatchSchema.safeParse(payload).success).toBe(true);
    for (const value of [{ ...payload, cases: [] }, { ...payload, cases: Array(101).fill(payload.cases[0]) }, { ...payload, cases: [payload.cases[0], payload.cases[0]] }, { ...payload, physicalExamDate: "2026-02-30" }, { ...payload, preservationAcknowledged: false }, { ...payload, clinicId: "untrusted" }]) expect(manualResolutionBatchSchema.safeParse(value).success).toBe(false);
  });
  it("binds proof to actor, exact input and ten minute expiry", () => {
    const token = signManualResolutionPreview({ actorId: "admin", payload, fingerprint: "state", now: 1000, secret: "secret" });
    expect(verifyManualResolutionPreview(token, { actorId: "admin", payload, now: 1001, secret: "secret" }).fingerprint).toBe("state");
    for (const input of [{ actorId: "other", payload, now: 1001 }, { actorId: "admin", payload: { ...payload, reason: "Changed reason" }, now: 1001 }, { actorId: "admin", payload, now: 601001 }]) expect(() => verifyManualResolutionPreview(token, { ...input, secret: "secret" })).toThrow();
  });
  it("counts consuming departures once and never subtracts awaiting sources", () => {
    expect(projectedManualCapacity(8, [{ id: "a", consumes: false }, { id: "b", consumes: true }, { id: "b", consumes: true }], 5)).toBe(12);
    expect(projectedManualCapacity(8, [{ id: "a", consumes: false }], 5)).toBe(13);
  });
});
