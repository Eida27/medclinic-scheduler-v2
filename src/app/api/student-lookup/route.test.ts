// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const { publicStudentSchedule } = vi.hoisted(() => ({ publicStudentSchedule: vi.fn() }));

vi.mock("@/server/repositories/appointments.repository", () => ({ publicStudentSchedule }));

import { GET } from "./route";

const retiredResponse = {
  error: {
    code: "STUDENT_LOOKUP_RETIRED",
    message: "Public student schedule lookup has been retired. Sign in to the Student Portal to view your schedule.",
  },
};

describe("GET /api/student-lookup", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    ["missing", "http://localhost/api/student-lookup"],
    ["existing", "http://localhost/api/student-lookup?studentNumber=2026-0001"],
    ["malformed", "http://localhost/api/student-lookup?studentNumber=%20%20%3F%3F%20"],
    ["arbitrary", "http://localhost/api/student-lookup?studentNumber=does-not-exist"],
  ])("returns the identical generic retirement response for %s input", async (_input, url) => {
    publicStudentSchedule.mockResolvedValue({ studentNumber: "2026-0001", appointments: [] });

    const response = await GET(new Request(url));

    expect(response.status).toBe(410);
    await expect(response.json()).resolves.toEqual(retiredResponse);
    expect(publicStudentSchedule).not.toHaveBeenCalled();
  });
});
