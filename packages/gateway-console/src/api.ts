let csrfToken = "";
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}
export function setCsrf(value: string): void {
  csrfToken = value;
}
export async function api<T = Record<string, unknown>>(
  path: string,
  body?: unknown,
  method = body === undefined ? "GET" : "POST",
): Promise<T> {
  const response = await fetch(`/api/console/${path}`, {
    method,
    credentials: "same-origin",
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(method === "GET" ? {} : { "x-csrf-token": csrfToken }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401 && !["login", "reauth"].includes(path))
      window.dispatchEvent(new Event("reach:unauthorized"));
    throw new ApiError(
      data.error ?? "Request failed",
      response.status,
      data.code,
    );
  }
  if (data.csrfToken) setCsrf(data.csrfToken);
  return data as T;
}
