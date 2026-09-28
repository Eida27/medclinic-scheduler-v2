import { dataResponse, errorResponse } from "@/lib/api-response";
import { AppError } from "@/lib/errors";
import { requireUser } from "@/server/auth/current-user";
import type { SessionUser } from "@/types/roles";

export async function manualBatchResponse(request: Request, action: (input: unknown, actor: SessionUser) => Promise<unknown>, query = false) {
  try {
    const actor = await requireUser(["ADMIN"]);
    let input: unknown;
    if (query) input = Object.fromEntries(new URL(request.url).searchParams);
    else {
      // Bound actual bytes as well as Content-Length, which clients may omit.
      const reader = request.body?.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (reader) for (;;) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > 65536) { await reader.cancel(); throw new AppError("REQUEST_TOO_LARGE", "This selection is too large.", 413); }
        chunks.push(part.value);
      }
      try { input = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
      catch { throw new AppError("VALIDATION_ERROR", "Send a valid JSON request.", 422); }
    }
    return dataResponse(await action(input, actor), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    const response = errorResponse(error);
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  }
}
