import { z } from "zod";
import { dataResponse, errorResponse } from "@/lib/api-response";
import { verifyStudentEmail } from "@/server/services/student-email.service";

const schema = z.object({ token: z.string().min(1).max(256) });

export async function POST(request: Request) {
  try {
    const input = schema.parse(await request.json());
    return dataResponse(await verifyStudentEmail(input.token));
  } catch (error) {
    return errorResponse(error);
  }
}
