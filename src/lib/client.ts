export interface ApiSuccess<T> {
  ok: true;
  data: T;
}

export interface ApiFailure {
  ok: false;
  error: string;
}

export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;

/**
 * Typed fetch helper for the local JSON API. Throws an Error with the server's
 * message on failure so callers can surface it in a toast.
 */
export async function apiFetch<T>(
  input: string,
  init?: RequestInit
): Promise<T> {
  const res = await fetch(input, {
    ...init,
    headers: {
      ...(init?.body && !(init.body instanceof FormData)
        ? { "Content-Type": "application/json" }
        : {}),
      ...init?.headers,
    },
  });

  let payload: ApiResponse<T> | null = null;
  try {
    payload = (await res.json()) as ApiResponse<T>;
  } catch {
    payload = null;
  }

  if (!res.ok || !payload || payload.ok === false) {
    const message =
      payload && payload.ok === false
        ? payload.error
        : `Request failed with status ${res.status}`;
    throw new Error(message);
  }

  return payload.data;
}
