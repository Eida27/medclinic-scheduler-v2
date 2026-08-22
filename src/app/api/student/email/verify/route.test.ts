// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const { verifyStudentEmail } = vi.hoisted(() => ({ verifyStudentEmail: vi.fn() }));
vi.mock("@/server/services/student-email.service", () => ({ verifyStudentEmail }));

import { POST } from "./route";

describe("POST /api/student/email/verify", () => {
  beforeEach(() => vi.resetAllMocks());

  it("verifies using only the token and creates no session cookie", async () => {
    verifyStudentEmail.mockResolvedValue({ email: "student@example.test", firstVerification: true });
    const response = await POST(new Request("http://localhost/api/student/email/verify", {
      method: "POST",
      body: JSON.stringify({ token: "any-device-token" }),
    }));

    expect(verifyStudentEmail).toHaveBeenCalledWith("any-device-token");
    expect(response.headers.has("set-cookie")).toBe(false);
    expect(await response.json()).toEqual({
      data: { email: "student@example.test", firstVerification: true },
    });
  });
});
