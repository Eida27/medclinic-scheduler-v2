type ApiPayload<T = unknown> = {
  data?: T;
  error?: { message?: string };
};

export async function readApiPayload<T = unknown>(response: Response): Promise<ApiPayload<T> | undefined> {
  try {
    const payload: unknown = await response.json();
    return typeof payload === "object" && payload !== null
      ? payload as ApiPayload<T>
      : undefined;
  } catch {
    return undefined;
  }
}

export function apiErrorMessage(payload: ApiPayload | undefined, fallback: string) {
  const message = payload?.error?.message;
  return typeof message === "string" && message.trim() ? message : fallback;
}
