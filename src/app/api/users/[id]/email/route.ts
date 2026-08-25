import { z } from "zod";
import { dataResponse, errorResponse } from "@/lib/api-response";
import { requireUser } from "@/server/auth/current-user";
import { changeStaffEmail } from "@/server/services/staff-administration.service";

const schema = z.object({ email: z.string() });

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireUser(["ADMIN"]);
    const { id } = await context.params;
    const input = schema.parse(await request.json());
    const account = await changeStaffEmail(actor.userId, id, input.email);
    return dataResponse({
      account,
      sessionRevoked: actor.userId === id,
      nextPath: actor.userId === id ? "/login" : null,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
