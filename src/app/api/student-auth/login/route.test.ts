// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors";

const { authenticateStudent } = vi.hoisted(() => ({ authenticateStudent: vi.fn() }));

vi.mock("@/server/services/student-auth.service", () => ({ authenticateStudent }));

import { POST } from "./route";

function loginRequest(body: Record<string, unknown>) {
  return new Request("http://localhost/api/student-auth/login", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": "203.0.113.9, 10.0.0.1",
    },
    body: JSON.stringify(body),
  });
}

describe("POST /api/student-auth/login", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authenticateStudent.mockRejectedValue(new AppError(
      "INVALID_STUDENT_CREDENTIALS",
      "Invalid Student Number, Date of Birth, or Middle Name.",
      401,
    ));
  });

  it("passes the untouched Middle Name and request IP to authentication", async () => {
    const response = await POST(loginRequest({
      studentNumber: "23-1212-97",
      dateOfBirth: "2004-08-04",
      middleName: " Maria  Angela ",
    }));

    expect(response.status).toBe(401);
    expect(authenticateStudent).toHaveBeenCalledWith({
      studentNumber: "23-1212-97",
      dateOfBirth: "2004-08-04",
      middleName: " Maria  Angela ",
      ipAddress: "203.0.113.9",
    });
  });

  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["whitespace-only", "   "],
    ["over 100 characters", "M".repeat(101)],
  ])("rejects a %s Middle Name before authentication", async (_label, middleName) => {
    const body: Record<string, unknown> = {
      studentNumber: "23-1212-97",
      dateOfBirth: "2004-08-04",
    };
    if (middleName !== undefined) body.middleName = middleName;

    const response = await POST(loginRequest(body));

    expect(response.status).toBe(422);
    expect(authenticateStudent).not.toHaveBeenCalled();
  });

  it("returns the same generic message for credential mismatches", async () => {
    const response = await POST(loginRequest({
      studentNumber: "23-1212-97",
      dateOfBirth: "2004-08-04",
      middleName: "Wrong",
    }));

    expect(await response.json()).toEqual({
      error: {
        code: "INVALID_STUDENT_CREDENTIALS",
        message: "Invalid Student Number, Date of Birth, or Middle Name.",
      },
    });
  });
});
