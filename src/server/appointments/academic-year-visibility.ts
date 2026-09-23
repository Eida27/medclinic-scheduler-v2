import "server-only";
import type { PoolClient } from "pg";
import { manilaCalendarDate } from "@/lib/academic-year";
import { AppError } from "@/lib/errors";

export type AppointmentVisibilityScope = { kind: "CURRENT" } | { kind: "YEAR"; startYear: number };

/** Call within the mutation transaction so a boundary edit cannot race the write. */
export async function assertOpenAppointmentCycle(
  client: PoolClient,
  cycleStart: number | null | undefined,
  now: Date,
): Promise<void> {
  if (!Number.isInteger(cycleStart)) {
    throw new AppError("ACADEMIC_YEAR_MISSING", "The appointment has no configured academic year.", 409);
  }
  const result = await client.query<{ closingDate: string }>(
    `SELECT closing_date::text AS "closingDate" FROM academic_years WHERE start_year=$1 FOR SHARE`,
    [cycleStart],
  );
  const year = result.rows[0];
  if (!year) throw new AppError("ACADEMIC_YEAR_MISSING", "The appointment has no configured academic year.", 409);
  if (manilaCalendarDate(now) > year.closingDate) {
    throw new AppError("ACADEMIC_YEAR_ENDED", "The academic year has ended; this appointment is historical.", 409);
  }
}
