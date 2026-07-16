import "server-only";
import { z } from "zod";
import { AppError } from "@/lib/errors";
import { transaction } from "@/server/db/pool";
import { writeAudit } from "@/server/repositories/audit.repository";
import {
  getResultAppointmentForUpdate,
  upsertResult,
  type ResultType,
} from "@/server/repositories/tracking.repository";
import type { SessionUser } from "@/types/roles";
import { completeAppointmentWithClient } from "./appointments.service";

export const resultSchema = z.object({
  studentNumber: z.string().trim().min(3).max(20), appointmentId: z.union([z.string().uuid(), z.literal(""), z.null(), z.undefined()]).transform((value) => value || null),
  resultType: z.enum(["PHYSICAL_EXAM","LABORATORY"]), resultStatus: z.enum(["PENDING","COMPLETED","REQUIRES_FOLLOW_UP","NOT_APPLICABLE"]),
  completedAt: z.union([z.iso.date(), z.literal(""), z.null(), z.undefined()]).transform((value) => value || null),
  remarks: z.union([z.string().max(2000),z.null(),z.undefined()]).transform((value) => value?.trim() || null),
}).superRefine((input, context) => { if (input.resultStatus === "COMPLETED" && !input.completedAt) context.addIssue({ code: "custom", path: ["completedAt"], message: "Completion date is required." }); });

function validateResultAppointmentMatch(
  appointment: { studentNumber: string; scheduleType: ResultType } | null,
  input: { appointmentId: string | null; studentNumber: string; resultType: ResultType },
) {
  if (!input.appointmentId) return;
  if (!appointment) {
    throw new AppError("APPOINTMENT_NOT_FOUND", "Appointment not found.", 422);
  }
  if (
    appointment.studentNumber !== input.studentNumber
    || appointment.scheduleType !== input.resultType
  ) {
    throw new AppError(
      "APPOINTMENT_MISMATCH",
      "The appointment does not match this student and result type.",
      422,
    );
  }
}

export async function recordResult(raw: unknown, actor: SessionUser) {
  const input = resultSchema.parse(raw);
  return transaction(async (client) => {
    const appointment = input.appointmentId
      ? await getResultAppointmentForUpdate(input.appointmentId, client)
      : null;
    validateResultAppointmentMatch(appointment, input);

    if (input.appointmentId && input.resultStatus === "COMPLETED") {
      const completedAppointment = await completeAppointmentWithClient(
        input.appointmentId,
        actor,
        input.remarks,
        client,
      );
      if (completedAppointment.status !== "COMPLETED") {
        await writeAudit(
          actor.userId,
          completedAppointment.status === "NO_SHOW"
            ? "APPOINTMENT_STATUS_CORRECTED"
            : "APPOINTMENT_STATUS_CHANGED",
          "appointment",
          input.appointmentId,
          {
            oldStatus: completedAppointment.status,
            newStatus: "COMPLETED",
            reason: input.remarks,
            source: "LINKED_RESULT",
          },
          client,
        );
      }
    }

    const result = await upsertResult({
      ...input,
      actorUserId: actor.userId,
    }, client);
    await writeAudit(
      actor.userId,
      "RESULT_RECORDED",
      input.resultType.toLowerCase(),
      result.id,
      { studentNumber: input.studentNumber, status: input.resultStatus },
      client,
    );
    return result;
  });
}
