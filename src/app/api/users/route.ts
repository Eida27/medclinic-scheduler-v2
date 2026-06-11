import { dataResponse, errorResponse } from "@/lib/api-response";
import { requireUser } from "@/server/auth/current-user";
import { createUser, listUsers, updateUser } from "@/server/services/users.service";

export async function GET() {
  try { await requireUser(["ADMIN"]); return dataResponse(await listUsers()); } catch (error) { return errorResponse(error); }
}
export async function POST(request: Request) {
  try { const user = await requireUser(["ADMIN"]); return dataResponse(await createUser(await request.json(), user.userId), { status: 201 }); } catch (error) { return errorResponse(error); }
}
export async function PATCH(request: Request) {
  try { const user = await requireUser(["ADMIN"]); return dataResponse(await updateUser(await request.json(), user.userId)); } catch (error) { return errorResponse(error); }
}
