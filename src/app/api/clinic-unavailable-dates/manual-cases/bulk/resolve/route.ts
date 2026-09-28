import { resolveManualResolutionBatch } from "@/server/services/manual-resolution-batch.service";
import { manualBatchResponse } from "../http";
export async function POST(request: Request) { return manualBatchResponse(request, resolveManualResolutionBatch); }
