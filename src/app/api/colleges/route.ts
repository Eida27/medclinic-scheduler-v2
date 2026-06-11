import { dataResponse, errorResponse } from "@/lib/api-response";
import { requireUser } from "@/server/auth/current-user";
import { listColleges } from "@/server/repositories/reference-data.repository";
import { addReference, editReference } from "@/server/services/reference-data.service";

export async function GET() {
  try { await requireUser(); return dataResponse(await listColleges()); } catch (error) { return errorResponse(error); }
}
export async function POST(request: Request) {
  try { const user = await requireUser(["ADMIN"]); return dataResponse(await addReference("college", await request.json(), user.userId), { status: 201 }); } catch (error) { return errorResponse(error); }
}
export async function PATCH(request: Request) {
  try { const user = await requireUser(["ADMIN"]); return dataResponse(await editReference("college", await request.json(), user.userId)); } catch (error) { return errorResponse(error); }
}
