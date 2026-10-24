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
  const text = await response.text();
  let data: Record<string, unknown> = {};
  if (text && response.headers.get("content-type")?.includes("json")) {
    try {
      data = JSON.parse(text);
    } catch {
      // Proxies can mislabel their error pages as JSON.
    }
  }
  if (!response.ok) {
    if (response.status === 401 && !["login", "reauth"].includes(path))
      window.dispatchEvent(new Event("reach:unauthorized"));
    throw new ApiError(
      typeof data.error === "string"
        ? data.error
        : `Gateway returned HTTP ${response.status} ${response.statusText}`.trim(),
      response.status,
      typeof data.code === "string" ? data.code : undefined,
    );
  }
  if (typeof data.csrfToken === "string") setCsrf(data.csrfToken);
  return data as T;
}
