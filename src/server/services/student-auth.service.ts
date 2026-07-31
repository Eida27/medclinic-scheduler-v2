import "server-only";
import { z } from "zod";
import { AppError } from "@/lib/errors";
import { transaction } from "@/server/db/pool";
import {
  clearStudentLoginAttempt,
  findStudentCredential,
  lockStudentLoginAttempt,
  normalizeStudentNumber,
  recordStudentLoginFailure,
} from "@/server/repositories/student-auth.repository";
import type { StudentSession } from "@/server/auth/student-session";

const inputSchema = z.object({
  studentNumber: z.string().trim().min(1).max(20),
  dateOfBirth: z.iso.date(),
  middleName: z.string()
    .min(1)
    .max(100)
    .refine((value) => value.trim().length > 0, "Middle Name is required."),
  ipAddress: z.string().trim().min(1).max(64),
});

const invalidCredentials = () => new AppError(
  "INVALID_STUDENT_CREDENTIALS",
  "Invalid Student Number, Date of Birth, or Middle Name.",
  401,
);
const throttled = () => new AppError(
  "STUDENT_LOGIN_THROTTLED",
  "Too many sign-in attempts. Try again in 15 minutes.",
  429,
);

export async function authenticateStudent(input: {
  studentNumber: string;
  dateOfBirth: string;
  middleName: string;
  ipAddress: string;
}): Promise<StudentSession> {
  const parsed = inputSchema.parse(input);
  const studentNumber = normalizeStudentNumber(parsed.studentNumber);
  const outcome = await transaction(async (client) => {
    const attempt = await lockStudentLoginAttempt(client, studentNumber, parsed.ipAddress);
    if (attempt.lockedUntil && attempt.lockedUntil.getTime() > Date.now()) {
      return { type: "throttled" as const };
    }
    const student = await findStudentCredential(client, studentNumber);
    if (
      student?.isActive
      && student.dateOfBirth === parsed.dateOfBirth
      && student.middleName !== null
      && student.middleName.toLowerCase() === parsed.middleName.toLowerCase()
    ) {
      await clearStudentLoginAttempt(client, studentNumber, parsed.ipAddress);
      return { type: "success" as const };
    }
    const failure = await recordStudentLoginFailure(
      client,
      studentNumber,
      parsed.ipAddress,
      attempt,
    );
    return { type: failure.locked ? "throttled" as const : "invalid" as const };
  });
  if (outcome.type === "throttled") throw throttled();
  if (outcome.type === "invalid") throw invalidCredentials();
  return { studentNumber, sessionType: "STUDENT" };
}
