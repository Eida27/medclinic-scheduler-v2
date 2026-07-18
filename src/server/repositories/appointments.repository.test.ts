import type { PoolClient } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { query } = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("@/server/db/pool", () => ({ query, transaction: vi.fn() }));

import {
  listAppointments,
  rescheduleAppointmentWithClient,
  type AppointmentMutationContext,
} from "./appointments.repository";

describe("listAppointments", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    query
      .mockResolvedValueOnce({ rows: [{ count: "2" }] })
      .mockResolvedValueOnce({ rows: [] });
  });

  it.each([
    ["soonest", "ORDER BY a.appointment_date ASC, s.last_name ASC, s.first_name ASC, a.student_number ASC, a.id ASC"],
    ["latest", "ORDER BY a.appointment_date DESC, s.last_name ASC, s.first_name ASC, a.student_number ASC, a.id ASC"],
    ["surname_asc", "ORDER BY s.last_name ASC, s.first_name ASC, a.appointment_date ASC, a.student_number ASC, a.id ASC"],
    ["surname_desc", "ORDER BY s.last_name DESC, s.first_name ASC, a.appointment_date ASC, a.student_number ASC, a.id ASC"],
  ] as const)("uses deterministic %s ordering for paginated appointment rows", async (sort, expectedOrder) => {
    await listAppointments({
      page: 1,
      limit: 150,
      offset: 0,
      isPublished: true,
      sort,
    });

    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1][0]).toContain(expectedOrder);
  });

  it("defaults to soonest ordering when no sort is provided", async () => {
    await listAppointments({ page: 1, limit: 150, offset: 0, isPublished: true });

    expect(query.mock.calls[1][0]).toContain(
      "ORDER BY a.appointment_date ASC, s.last_name ASC, s.first_name ASC, a.student_number ASC, a.id ASC",
    );
  });
});

describe("rescheduleAppointmentWithClient", () => {
  it("guards the original update with the locked status and creates the replacement history", async () => {
    const appointment = {
      id: "11111111-1111-4111-8111-111111111111",
      batchId: "33333333-3333-4333-8333-333333333333",
      studentNumber: "2026-0001",
      scheduleType: "LABORATORY",
      status: "PENDING",
      clinicId: "60000000-0000-4000-8000-000000000001",
      clinicCode: "KABALAKA_CLINIC",
      isPublished: true,
      schedulePairId: "44444444-4444-4444-8444-444444444444",
      scheduleCycleStart: 2026,
      isManuallyLocked: false,
      lockReason: null,
      latestLog: null,
    } satisfies AppointmentMutationContext;
    const replacementId = "22222222-2222-4222-8222-222222222222";
    const actorUserId = "00000000-0000-4000-8000-000000000001";
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: appointment.id }] })
        .mockResolvedValueOnce({ rowCount: 1, rows: [] })
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: replacementId }] })
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }),
    } as unknown as PoolClient;

    await expect(rescheduleAppointmentWithClient(
      client,
      appointment,
      "2026-08-19",
      "Student requested a replacement",
      actorUserId,
    )).resolves.toBe(replacementId);

    expect(client.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("WHERE id=$1 AND status=$2 AND is_published=TRUE"),
      [appointment.id, "PENDING", actorUserId],
    );
    expect(client.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("appointment_status_logs"),
      [appointment.id, "PENDING", "Student requested a replacement", actorUserId],
    );
    expect(client.query).toHaveBeenNthCalledWith(
      4,
      expect.stringContaining("appointment_status_logs"),
      [replacementId, "Student requested a replacement", actorUserId],
    );
  });
});
