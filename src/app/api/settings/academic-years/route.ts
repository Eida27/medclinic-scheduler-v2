import { dataResponse, errorResponse } from "@/lib/api-response";
import { requireUser } from "@/server/auth/current-user";
import {
  createAcademicYear,
  deleteAcademicYear,
  listAcademicYears,
  updateAcademicYear,
} from "@/server/services/academic-years.service";

export async function GET() {
  try {
    await requireUser(["ADMIN"]);
    return dataResponse(await listAcademicYears());
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const actor = await requireUser(["ADMIN"]);
    return dataResponse(
      await createAcademicYear(await request.json(), actor.userId),
      { status: 201 },
    );
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const actor = await requireUser(["ADMIN"]);
    return dataResponse(await updateAcademicYear(await request.json(), actor.userId));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: Request) {
  try {
    const actor = await requireUser(["ADMIN"]);
    return dataResponse(await deleteAcademicYear(await request.json(), actor.userId));
  } catch (error) {
    return errorResponse(error);
  }
}
