import { selectManualResolutionCases } from "@/server/services/manual-resolution-batch.service";
import { manualBatchResponse } from "../bulk/http";
export async function GET(request: Request) { return manualBatchResponse(request, selectManualResolutionCases, true); }
