import { describe, expect, it } from "vitest";
import { errorResponse } from "./api-response";
import { AppError } from "./errors";

describe("errorResponse", () => {
  it("serializes structured AppError details without changing optional fields", async () => {
    const response = errorResponse(new AppError(
      "CLINIC_CALENDAR_BATCH_REJECTED",
      "No calendar changes were saved.",
      409,
      undefined,
      {
        issues: [{
          clinicId: "clinic-1",
          date: "2027-07-15",
          action: "UNBLOCK",
          code: "STALE_BLOCK",
          message: "The block changed.",
        }],
      },
    ));

    expect(await response.json()).toEqual({
      error: {
        code: "CLINIC_CALENDAR_BATCH_REJECTED",
        message: "No calendar changes were saved.",
        details: {
          issues: [expect.objectContaining({ code: "STALE_BLOCK" })],
        },
      },
    });
  });
});
