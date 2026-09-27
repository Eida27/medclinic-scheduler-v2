import { z } from "zod";

const printable = (value: string) => !/[\x00-\x1f\x7f]/u.test(value);
const printableMultiline = (value: string) => !/[\x00-\x09\x0b-\x1f\x7f]/u.test(value);
const field = (maximum: number) => z.string().trim().min(1).max(maximum).refine(printable, "Control characters are not allowed.");
const optionalField = (maximum: number) => z.string().trim().max(maximum).refine(printable, "Control characters are not allowed.").nullable().optional();
const remarksField = z.string().transform((value) => value.replace(/\r\n?/gu, "\n").trim())
  .pipe(z.string().max(1000).refine(printableMultiline, "Control characters are not allowed."));

export const physicianRevisionSchema = z.object({
  displayName: field(200),
  licenseNumber: field(60),
  specialty: optionalField(120),
  active: z.boolean(),
}).strict();

export const certificateCompletionSchema = z.object({
  requestId: z.uuid(),
  physicianId: z.uuid(),
  physicianVersion: z.number().int().positive(),
  examinationDate: z.iso.date().refine((value) => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }, "Enter a valid examination date."),
  sex: field(30),
  classification: z.enum(["A", "B", "C", "D"]),
  remarks: remarksField.optional(),
  lateReason: optionalField(1000),
  attested: z.literal(true),
}).strict().superRefine((value, context) => {
  if (value.classification !== "A" && !value.remarks?.trim()) {
    context.addIssue({ code: "custom", path: ["remarks"], message: "Remarks are required for this classification." });
  }
});

export const certificateCorrectionSchema = certificateCompletionSchema.safeExtend({
  expectedRevisionId: z.uuid(),
  reason: field(1000),
});

export const certificateRevocationSchema = z.object({
  requestId: z.uuid(),
  expectedRevisionId: z.uuid(),
  reason: field(1000),
}).strict();

export type CertificateCompletionInput = z.infer<typeof certificateCompletionSchema>;
export type PhysicianRevisionInput = z.infer<typeof physicianRevisionSchema>;
export type CertificateCorrectionInput = z.infer<typeof certificateCorrectionSchema>;
