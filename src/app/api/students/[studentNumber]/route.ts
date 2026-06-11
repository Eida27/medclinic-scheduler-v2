import { dataResponse, errorResponse } from "@/lib/api-response";
import { requireUser } from "@/server/auth/current-user";
import { deactivateStudent, getStudentDetails, updateStudent } from "@/server/services/students.service";

type Context = { params: Promise<{ studentNumber: string }> };

export async function GET(_: Request, context: Context) {
  try {
    await requireUser();
    return dataResponse(await getStudentDetails(decodeURIComponent((await context.params).studentNumber)));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH(request: Request, context: Context) {
  try {
    const user = await requireUser();
    const studentNumber = decodeURIComponent((await context.params).studentNumber);
    return dataResponse(await updateStudent(studentNumber, await request.json(), user.userId));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(_: Request, context: Context) {
  try {
    const user = await requireUser();
    const studentNumber = decodeURIComponent((await context.params).studentNumber);
    await deactivateStudent(studentNumber, user.userId);
    return dataResponse({ success: true });
  } catch (error) {
    return errorResponse(error);
  }
}
