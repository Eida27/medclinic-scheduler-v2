// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { verifySessionToken, verifyStudentSessionToken } = vi.hoisted(() => ({
  verifySessionToken: vi.fn(),
  verifyStudentSessionToken: vi.fn(),
}));

vi.mock("@/server/auth/session", () => ({
  SESSION_COOKIE: "medclinic_session",
  verifySessionToken,
}));
vi.mock("@/server/auth/student-session", () => ({
  STUDENT_SESSION_COOKIE: "medclinic_student_session",
  verifyStudentSessionToken,
}));

import { config, proxy } from "./proxy";

describe("proxy route boundaries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    verifySessionToken.mockResolvedValue({ role: "COORDINATOR" });
    verifyStudentSessionToken.mockResolvedValue({ sessionType: "STUDENT" });
  });

  it("keeps /students staff routes out of the /student portal guard", async () => {
    const request = new NextRequest("http://localhost/students/schedule-imports/new", {
      headers: { cookie: "medclinic_session=staff-token" },
    });

    const response = await proxy(request);

    expect(response.headers.get("location")).toBeNull();
    expect(verifySessionToken).toHaveBeenCalledWith("staff-token");
    expect(verifyStudentSessionToken).not.toHaveBeenCalled();
  });

  it("continues protecting /student and /student descendants separately", async () => {
    const request = new NextRequest("http://localhost/student/results", {
      headers: { cookie: "medclinic_student_session=student-token" },
    });

    await proxy(request);

    expect(verifyStudentSessionToken).toHaveBeenCalledWith("student-token");
    expect(verifySessionToken).not.toHaveBeenCalled();
  });

  it("allows signed-out students to open token-only email confirmation", async () => {
    const request = new NextRequest(
      "http://localhost/student/email-verification/confirm?token=verification-token",
    );

    const response = await proxy(request);

    expect(response.headers.get("location")).toBeNull();
    expect(verifyStudentSessionToken).not.toHaveBeenCalled();
    expect(verifySessionToken).not.toHaveBeenCalled();
  });

  it("authenticates reports while retaining appointment route matching", () => {
    expect(config.matcher).toContain("/reports/:path*");
    expect(config.matcher).toContain("/appointments/:path*");
  });
});
