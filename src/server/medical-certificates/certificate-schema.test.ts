import { describe, expect, it } from "vitest";
import { certificateCompletionSchema, certificateCorrectionSchema, certificateRevocationSchema, physicianRevisionSchema } from "./certificate-schema";

const completion = {
  requestId: "af729e8b-2945-4100-b706-bbd47780a9df",
  physicianId: "a42ec5b1-2867-4a6f-ab07-51d6b13f4053",
  physicianVersion: 1,
  examinationDate: "2026-09-22",
  sex: "Female",
  classification: "A",
  attested: true,
};

describe("certificate input", () => {
  it("requires an explicit class and attestation", () => {
    expect(certificateCompletionSchema.safeParse({ ...completion, classification: undefined }).success).toBe(false);
    expect(certificateCompletionSchema.safeParse({ ...completion, attested: false }).success).toBe(false);
  });

  it("requires remarks for Classes B, C, and D", () => {
    for (const classification of ["B", "C", "D"]) {
      expect(certificateCompletionSchema.safeParse({ ...completion, classification, remarks: " " }).success).toBe(false);
      expect(certificateCompletionSchema.safeParse({ ...completion, classification, remarks: "Follow-up required" }).success).toBe(true);
    }
  });

  it("rejects invalid dates, absent sex, and control characters", () => {
    expect(certificateCompletionSchema.safeParse({ ...completion, examinationDate: "2026-02-30" }).success).toBe(false);
    expect(certificateCompletionSchema.safeParse({ ...completion, sex: " " }).success).toBe(false);
    expect(certificateCompletionSchema.safeParse({ ...completion, sex: "Female\u0000" }).success).toBe(false);
    expect(certificateCompletionSchema.safeParse({ ...completion, remarks: "unsafe\u0007" }).success).toBe(false);
  });

  it("validates configured physician identity", () => {
    expect(physicianRevisionSchema.safeParse({ displayName: "Dr. Ada Reyes", licenseNumber: "PRC 1234", specialty: "General Medicine", active: true }).success).toBe(true);
    expect(physicianRevisionSchema.safeParse({ displayName: "Dr. Ada\nReyes", licenseNumber: "PRC 1234", active: true }).success).toBe(false);
  });

  it("requires an expected revision and reason for correction or revocation", () => {
    expect(certificateCorrectionSchema.safeParse({ ...completion, expectedRevisionId: completion.requestId, reason: "Wrong finding" }).success).toBe(true);
    expect(certificateCorrectionSchema.safeParse({ ...completion, expectedRevisionId: completion.requestId }).success).toBe(false);
    expect(certificateRevocationSchema.safeParse({ requestId: completion.requestId, expectedRevisionId: completion.requestId, reason: "Incorrect student" }).success).toBe(true);
    expect(certificateRevocationSchema.safeParse({ requestId: completion.requestId, expectedRevisionId: completion.requestId, reason: " " }).success).toBe(false);
  });
});
