import { dataResponse, errorResponse } from "@/lib/api-response";
import { requireUser } from "@/server/auth/current-user";
import { listPriorityGroups } from "@/server/repositories/reference-data.repository";
import { addReference, editReference, removeReference } from "@/server/services/reference-data.service";

export async function GET() {
  try { await requireUser(); return dataResponse(await listPriorityGroups()); } catch (error) { return errorResponse(error); }
}
export async function POST(request: Request) {
  try { const user = await requireUser(["ADMIN"]); return dataResponse(await addReference("priorityGroup", await request.json(), user.userId), { status: 201 }); } catch (error) { return errorResponse(error); }
}
export async function PATCH(request: Request) {
  try { const user = await requireUser(["ADMIN"]); return dataResponse(await editReference("priorityGroup", await request.json(), user.userId)); } catch (error) { return errorResponse(error); }
}
export async function DELETE(request: Request) {
  try { const user = await requireUser(["ADMIN"]); return dataResponse(await removeReference("priorityGroup", await request.json(), user.userId)); } catch (error) { return errorResponse(error); }
}
