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

  it("uses deterministic tie-breakers for paginated appointment rows", async () => {
    await listAppointments({ page: 1, limit: 150, offset: 0, isPublished: true });

    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1][0]).toContain(
      "ORDER BY a.appointment_date, s.last_name, s.first_name, a.student_number, a.id",
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
      "10:00",
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
