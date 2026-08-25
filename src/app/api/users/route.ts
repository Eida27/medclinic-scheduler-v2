import { dataResponse, errorResponse } from "@/lib/api-response";
import { requireUser } from "@/server/auth/current-user";
import { createStaffUser, listStaffUsers } from "@/server/services/staff-administration.service";

export async function GET() {
  try { await requireUser(["ADMIN"]); return dataResponse(await listStaffUsers()); } catch (error) { return errorResponse(error); }
}
export async function POST(request: Request) {
  try { const user = await requireUser(["ADMIN"]); return dataResponse(await createStaffUser(await request.json(), user.userId), { status: 201 }); } catch (error) { return errorResponse(error); }
}
