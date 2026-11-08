/** Browser-side calls to /api/publisher/*. Errors carry the server's message. */
import type { ApiErrorBody } from "./types";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      cache: "no-store",
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, "network", "Could not reach BotFare. Check your connection.");
  }
  const data = (await res.json().catch(() => null)) as (T & Partial<ApiErrorBody>) | null;
  if (!res.ok) {
    throw new ApiError(
      res.status,
      data?.error ?? "error",
      data?.message ??
        (res.status === 401 ? "Your session ended. Sign in again." : "Something went wrong."),
    );
  }
  return data as T;
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : "Something went wrong.";
}
