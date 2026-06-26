import "server-only";

import { AppError } from "@/lib/errors";
import { isClinicCode, type ClinicCode } from "@/server/clinics";
import type { SessionUser } from "@/types/roles";

export function assertClinicAccess(user: SessionUser, clinicCode: ClinicCode) {
  if (user.role === "ADMIN") return;
  if (!isClinicCode(user.clinicCode) || user.clinicCode !== clinicCode) {
    throw new AppError("CLINIC_ACCESS_DENIED", "You can only manage your assigned clinic.", 403);
  }
}
