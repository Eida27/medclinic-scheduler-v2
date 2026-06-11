import "server-only";
import { z } from "zod";
import { AppError, isPostgresUniqueViolation } from "@/lib/errors";
import { writeAudit } from "@/server/repositories/audit.repository";
import {
  deactivateStudentRecord,
  getStudent,
  insertStudent,
  listStudents,
  programBelongsToCollege,
  studentHistory,
  updateStudentRecord,
} from "@/server/repositories/students.repository";

const optionalText = z.union([z.string(), z.null(), z.undefined()]).transform((value) => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
});

export const studentInputSchema = z.object({
  studentNumber: z.string().trim().min(3).max(20),
  firstName: z.string().trim().min(1).max(100),
  middleName: optionalText,
  lastName: z.string().trim().min(1).max(100),
  suffix: optionalText,
  collegeId: z.string().uuid(),
  programId: z.string().uuid(),
  yearLevel: z.union([z.coerce.number().int().min(1).max(6), z.null()]).default(null),
  section: optionalText,
});

async function validateProgram(programId: string, collegeId: string) {
  if (!(await programBelongsToCollege(programId, collegeId))) {
    throw new AppError("PROGRAM_COLLEGE_MISMATCH", "The selected program does not belong to the selected college.", 422);
  }
}

export async function createStudent(raw: unknown, actorUserId: string) {
  const input = studentInputSchema.parse(raw);
  await validateProgram(input.programId, input.collegeId);
  try {
    const student = await insertStudent(input);
    await writeAudit(actorUserId, "STUDENT_CREATED", "student", input.studentNumber);
    return student;
  } catch (error) {
    if (isPostgresUniqueViolation(error)) {
      throw new AppError("DUPLICATE_STUDENT", "That student number already exists.", 409);
    }
    throw error;
  }
}

export async function updateStudent(studentNumber: string, raw: unknown, actorUserId: string) {
  const parsed = studentInputSchema.omit({ studentNumber: true }).parse(raw);
  await validateProgram(parsed.programId, parsed.collegeId);
  if (!(await getStudent(studentNumber))) throw new AppError("STUDENT_NOT_FOUND", "Student not found.", 404);
  const student = await updateStudentRecord(studentNumber, parsed);
  await writeAudit(actorUserId, "STUDENT_UPDATED", "student", studentNumber);
  return student;
}

export async function deactivateStudent(studentNumber: string, actorUserId: string) {
  if (!(await deactivateStudentRecord(studentNumber))) throw new AppError("STUDENT_NOT_FOUND", "Active student not found.", 404);
  await writeAudit(actorUserId, "STUDENT_DEACTIVATED", "student", studentNumber);
}

export async function getStudentDetails(studentNumber: string) {
  const student = await getStudent(studentNumber);
  if (!student) throw new AppError("STUDENT_NOT_FOUND", "Student not found.", 404);
  return { ...student, ...(await studentHistory(studentNumber)) };
}

export { listStudents };
