import { z } from "zod";
import { dataResponse, errorResponse } from "@/lib/api-response";
import { requireUser } from "@/server/auth/current-user";
import { publishScheduleBatch } from "@/server/services/appointments.service";

const schema = z.object({ batchId: z.string().uuid(), confirm: z.literal(true) });
export async function POST(request: Request) { try { const user = await requireUser(["ADMIN"]); const input = schema.parse(await request.json()); return dataResponse(await publishScheduleBatch(input.batchId, user.userId)); } catch (error) { return errorResponse(error); } }
