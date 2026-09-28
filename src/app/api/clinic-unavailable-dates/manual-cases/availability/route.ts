import { getManualResolutionAvailability } from "@/server/services/manual-resolution-batch.service";
import { manualBatchResponse } from "../bulk/http";
export async function POST(request: Request) { return manualBatchResponse(request, getManualResolutionAvailability); }
