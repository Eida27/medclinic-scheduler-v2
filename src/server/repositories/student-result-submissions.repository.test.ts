import type { PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import { finalizeStudentResultDraft, invalidateFinalizedSubmissionMetadata } from "./student-result-submissions.repository";

describe("Laboratory document mutation boundaries", () => {
  it.each(["finalize", "invalidate"] as const)("rejects forged PE %s input before the first database write", async (operation) => {
    const query = vi.fn().mockResolvedValue({ rowCount: 1, rows: [] });
    const client = { query } as unknown as PoolClient;
    const forged = { id: "submission", appointmentId: "physical", studentNumber: "student", resultType: "PHYSICAL_EXAM" } as unknown as Parameters<typeof finalizeStudentResultDraft>[1];
    await expect(operation === "finalize"
      ? finalizeStudentResultDraft(client, forged, 1, 20)
      : invalidateFinalizedSubmissionMetadata(client, forged, "admin", "Wrong service"))
      .rejects.toMatchObject({ code: "PHYSICAL_EXAM_UPLOAD_RETIRED", status: 422 });
    expect(query).not.toHaveBeenCalled();
  });
});
