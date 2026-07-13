import { beforeEach, describe, expect, it, vi } from "vitest";

const { query } = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("@/server/db/pool", () => ({ query, transaction: vi.fn() }));

import { listAppointments } from "./appointments.repository";

describe("listAppointments", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    query
      .mockResolvedValueOnce({ rows: [{ count: "2" }] })
      .mockResolvedValueOnce({ rows: [] });
  });

  it("uses deterministic tie-breakers for paginated appointment rows", async () => {
    await listAppointments({ page: 1, limit: 150, offset: 0, isPublished: true });

    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1][0]).toContain(
      "ORDER BY a.appointment_date, s.last_name, s.first_name, a.student_number, a.id",
    );
  });
});
