import { dataResponse, errorResponse } from "@/lib/api-response";
import { AppError } from "@/lib/errors";
import { requireUser } from "@/server/auth/current-user";
import { resultsForStudent } from "@/server/repositories/tracking.repository";
import { recordResult } from "@/server/services/tracking.service";

export async function GET(request: Request) { try { await requireUser(); const studentNumber = new URL(request.url).searchParams.get("studentNumber")?.trim(); if (!studentNumber) throw new AppError("STUDENT_NUMBER_REQUIRED", "Enter a student number.", 422); const result = await resultsForStudent(studentNumber); if (!result) throw new AppError("STUDENT_NOT_FOUND", "Student not found.", 404); return dataResponse(result); } catch (error) { return errorResponse(error); } }
export async function POST(request: Request) { try { const user = await requireUser(); return dataResponse(await recordResult(await request.json(), user), { status: 201 }); } catch (error) { return errorResponse(error); } }
