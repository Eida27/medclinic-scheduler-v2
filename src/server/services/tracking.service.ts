import "server-only";
import { z } from "zod";
import { AppError } from "@/lib/errors";
import { writeAudit } from "@/server/repositories/audit.repository";
import { upsertResult } from "@/server/repositories/tracking.repository";

export const resultSchema = z.object({
  studentNumber: z.string().trim().min(3).max(20), appointmentId: z.union([z.string().uuid(), z.literal(""), z.null(), z.undefined()]).transform((value) => value || null),
  resultType: z.enum(["PHYSICAL_EXAM","LABORATORY"]), resultStatus: z.enum(["PENDING","COMPLETED","REQUIRES_FOLLOW_UP","NOT_APPLICABLE"]),
  completedAt: z.union([z.iso.date(), z.literal(""), z.null(), z.undefined()]).transform((value) => value || null),
  remarks: z.union([z.string().max(2000),z.null(),z.undefined()]).transform((value) => value?.trim() || null),
}).superRefine((input, context) => { if (input.resultStatus === "COMPLETED" && !input.completedAt) context.addIssue({ code: "custom", path: ["completedAt"], message: "Completion date is required." }); });

export async function recordResult(raw: unknown, actorUserId: string) {
  const input = resultSchema.parse(raw); const result = await upsertResult({ ...input, actorUserId });
  if ("error" in result && result.error) throw new AppError(result.error, result.error === "APPOINTMENT_NOT_FOUND" ? "Appointment not found." : "The appointment does not match this student and result type.", 422);
  await writeAudit(actorUserId, "RESULT_RECORDED", input.resultType.toLowerCase(), result.id, { studentNumber: input.studentNumber, status: input.resultStatus });
  return result;
}
