import { dataResponse, errorResponse, pagination } from "@/lib/api-response";
import { requireUser } from "@/server/auth/current-user";
import { createStudent, listStudents } from "@/server/services/students.service";

export async function GET(request: Request) {
  try {
    await requireUser();
    const url = new URL(request.url);
    const paging = pagination(url.searchParams);
    const result = await listStudents({
      ...paging,
      search: url.searchParams.get("search")?.trim() || undefined,
      collegeId: url.searchParams.get("collegeId") || undefined,
      programId: url.searchParams.get("programId") || undefined,
      yearLevel: Number(url.searchParams.get("yearLevel")) || undefined,
    });
    return dataResponse({ ...result, page: paging.page, limit: paging.limit });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const user = await requireUser();
    return dataResponse(await createStudent(await request.json(), user.userId), { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
