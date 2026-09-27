import { describe, expect, it } from "vitest";
import { bulkReplacementPayloadSchema, signBulkReplacementPreview, verifyBulkReplacementPreview } from "./bulk-replacement.service";

const payload = {
  appointments: [{ id: "10000000-0000-4000-8000-000000000001", expectedUpdatedAt: "2027-08-01T00:00:00.000Z" }],
  replacementDate: "2027-08-12",
  reason: "Schedule adjustment",
};

describe("bulk replacement review tokens", () => {
  it("rejects duplicate IDs and more than 100 rows", () => {
    expect(bulkReplacementPayloadSchema.safeParse({ ...payload, appointments: [...payload.appointments, ...payload.appointments] }).success).toBe(false);
    expect(bulkReplacementPayloadSchema.safeParse({ ...payload, appointments: Array.from({ length: 101 }, (_, index) => ({
      id: `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      expectedUpdatedAt: payload.appointments[0].expectedUpdatedAt,
    })) }).success).toBe(false);
  });

  it("binds a 10-minute token to its actor and exact reviewed payload", () => {
    const secret = "s".repeat(40);
    const now = 1_800_000_000_000;
    const token = signBulkReplacementPreview({ actorId: "staff-1", payload, fingerprint: "f", now, secret });
    expect(verifyBulkReplacementPreview(token, { actorId: "staff-1", payload, now: now + 600_000, secret })).toMatchObject({ fingerprint: "f" });
    expect(() => verifyBulkReplacementPreview(token, { actorId: "staff-2", payload, now, secret })).toThrow();
    expect(() => verifyBulkReplacementPreview(token, { actorId: "staff-1", payload: { ...payload, reason: "Other" }, now, secret })).toThrow();
    expect(() => verifyBulkReplacementPreview(token, { actorId: "staff-1", payload, now: now + 600_001, secret })).toThrow();
  });
});
