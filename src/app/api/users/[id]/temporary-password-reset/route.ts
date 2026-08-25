import { z } from "zod";
import { dataResponse, errorResponse } from "@/lib/api-response";
import { requireUser } from "@/server/auth/current-user";
import { resetStaffTemporaryPassword } from "@/server/services/staff-administration.service";

const schema = z.object({ temporaryPassword: z.string(), confirmTemporaryPassword: z.string() });

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireUser(["ADMIN"]);
    const { id } = await context.params;
    const account = await resetStaffTemporaryPassword(actor.userId, id, schema.parse(await request.json()));
    return dataResponse({
      account,
      sessionRevoked: actor.userId === id,
      nextPath: actor.userId === id ? "/login" : null,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
