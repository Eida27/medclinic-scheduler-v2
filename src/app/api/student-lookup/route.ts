import { dataResponse, errorResponse } from "@/lib/api-response";
import { AppError } from "@/lib/errors";
import { publicStudentSchedule } from "@/server/repositories/appointments.repository";

export async function GET(request: Request) {
  try { const studentNumber = new URL(request.url).searchParams.get("studentNumber")?.trim(); if (!studentNumber) throw new AppError("STUDENT_NUMBER_REQUIRED", "Enter a student number.", 422); const result = await publicStudentSchedule(studentNumber); if (!result) throw new AppError("STUDENT_NOT_FOUND", "No active student record was found.", 404); return dataResponse(result); } catch (error) { return errorResponse(error); }
}
