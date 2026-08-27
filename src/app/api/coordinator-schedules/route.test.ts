// @vitest-environment node
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors";
import { pool } from "@/server/db/pool";

const { requireUser, addScheduleBatch } = vi.hoisted(() => ({
  requireUser: vi.fn(),
  addScheduleBatch: vi.fn(),
}));

vi.mock("@/server/auth/current-user", () => ({ requireUser }));
vi.mock("@/server/services/coordinator-schedules.service", () => ({ addScheduleBatch }));

import { POST } from "./route";

const retiredError = {
  error: {
    code: "SCHEDULING_WORKFLOW_RETIRED",
    message: "This scheduling workflow has been retired. Use Schedule Imports to create and publish student schedules.",
  },
};

describe("POST /api/coordinator-schedules", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireUser.mockResolvedValue({
      userId: "00000000-0000-4000-8000-000000000001",
      role: "ADMIN",
    });
  });

  afterAll(async () => {
    await pool.end();
  });

  it("preserves authentication precedence for retired creation", async () => {
    requireUser.mockRejectedValue(new AppError("UNAUTHORIZED", "Authentication required.", 401));
    const request = new Request("http://localhost/api/coordinator-schedules", { method: "POST" });
    const json = vi.spyOn(request, "json");

    const response = await POST(request);

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: { code: "UNAUTHORIZED", message: "Authentication required." },
    });
    expect(json).not.toHaveBeenCalled();
    expect(addScheduleBatch).not.toHaveBeenCalled();
  });

  it("returns the stable retirement response before parsing or persisting", async () => {
    const batchName = `Retired route sentinel ${crypto.randomUUID()}`;
    const before = await pool.query("SELECT COUNT(*)::int AS count FROM schedule_batches WHERE batch_name=$1", [batchName]);
    const request = new Request("http://localhost/api/coordinator-schedules", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ batchName, malformed: true }),
    });
    const json = vi.spyOn(request, "json");

    const response = await POST(request);

    expect(response.status).toBe(410);
    await expect(response.json()).resolves.toEqual(retiredError);
    expect(json).not.toHaveBeenCalled();
    expect(addScheduleBatch).not.toHaveBeenCalled();
    const after = await pool.query("SELECT COUNT(*)::int AS count FROM schedule_batches WHERE batch_name=$1", [batchName]);
    expect(after.rows[0].count).toBe(before.rows[0].count);
  });
});
