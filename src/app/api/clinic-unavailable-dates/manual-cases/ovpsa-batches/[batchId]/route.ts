import { dataResponse, errorResponse } from "@/lib/api-response";
import { requireUser } from "@/server/auth/current-user";
import { getOvpsaManualBatchContext } from "@/server/services/ovpsa-manual-batch-context.service";

type Context = { params: Promise<{ batchId: string }> };

export async function GET(_request: Request, context: Context) {
  try {
    const actor = await requireUser(["ADMIN"]);
    const { batchId } = await context.params;
    return dataResponse(await getOvpsaManualBatchContext(batchId, actor));
  } catch (error) { return errorResponse(error); }
}
