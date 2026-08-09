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

  it("adds the paired Laboratory status projection only when requested without changing the count query", async () => {
    await listAppointments({
      clinicCode: "CPU_CLINIC",
      scheduleType: "PHYSICAL_EXAM",
      page: 2,
      limit: 10,
      offset: 10,
      includeLaboratoryStatus: true,
    });

    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0][0]).not.toContain("LEFT JOIN LATERAL");
    // The repository appends pagination after issuing the count query, so the mock
    // observes the same values array after its later mutation.
    expect(query.mock.calls[0][1]).toEqual(["CPU_CLINIC", "PHYSICAL_EXAM", 10, 10]);
    expect(query.mock.calls[1][0]).toContain('laboratory.status AS "laboratoryStatus"');
    expect(query.mock.calls[1][0]).toContain("LEFT JOIN LATERAL");
    expect(query.mock.calls[1][0]).toContain("laboratory.student_number=a.student_number");
    expect(query.mock.calls[1][0]).toContain("laboratory.schedule_cycle_start=a.schedule_cycle_start");
    expect(query.mock.calls[1][0]).toContain("a.schedule_pair_id IS NOT NULL");
    expect(query.mock.calls[1][0]).toContain("laboratory.schedule_pair_id=a.schedule_pair_id");
    expect(query.mock.calls[1][0]).toContain("a.schedule_pair_id IS NULL");
    expect(query.mock.calls[1][0]).toContain("ORDER BY laboratory.appointment_date DESC, laboratory.created_at DESC, laboratory.id DESC");
    expect(query.mock.calls[1][1]).toEqual(["CPU_CLINIC", "PHYSICAL_EXAM", 10, 10]);
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
      isManuallyLocked: true,
      lockReason: "Inherited protection reason",
      lockedById: "00000000-0000-4000-8000-000000000001",
      lockedAt: new Date("2026-08-01T00:00:00.000Z"),
      updatedAt: new Date("2026-08-01T00:00:00.000Z"),
      latestLog: null,
      completedFromStatus: null,
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

    expect(client.query).toHaveBeenCalledTimes(4);
    expect(client.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("SET status='RESCHEDULED', is_published=FALSE"),
      [appointment.id, "PENDING", actorUserId],
    );
    expect(client.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("appointment_status_logs"),
      [appointment.id, "PENDING", "Student requested a replacement", actorUserId],
    );
    expect(client.query).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining("is_manually_locked,locked_by,locked_at,lock_reason"),
      [
        appointment.batchId,
        appointment.clinicId,
        appointment.studentNumber,
        appointment.scheduleType,
        "2026-08-19",
        true,
        "Student requested a replacement",
        appointment.id,
        actorUserId,
        appointment.schedulePairId,
        appointment.scheduleCycleStart,
        true,
        "Inherited protection reason",
      ],
    );
    expect(client.query).toHaveBeenNthCalledWith(
      4,
      expect.stringContaining("appointment_status_logs"),
      [replacementId, "Student requested a replacement", actorUserId],
    );
  });
});
