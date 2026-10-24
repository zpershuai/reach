import { i18n } from "./i18n";
import type { TFunction } from "i18next";
import { en } from "./i18n/en";
let csrfToken = "";
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly retryAfter?: number,
    readonly statusText = "",
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
  let response: Response;
  let text: string;
  try {
    response = await fetch(`/api/console/${path}`, {
      method,
      credentials: "same-origin",
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(method === "GET" ? {} : { "x-csrf-token": csrfToken }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    text = await response.text();
  } catch {
    throw new ApiError(i18n.t("errors.GATEWAY_UNAVAILABLE"), 0, "GATEWAY_UNAVAILABLE");
  }
  let data: Record<string, unknown> = {};
  if (text && response.headers.get("content-type")?.includes("json")) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
        data = parsed as Record<string, unknown>;
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
        : i18n
            .t("errors.http", {
              status: response.status,
              statusText: response.statusText,
            })
            .trim(),
      response.status,
      typeof data.code === "string"
        ? data.code
        : typeof data.error === "string"
          ? undefined
          : "HTTP_ERROR",
      typeof data.retryAfter === "number"
        ? data.retryAfter
        : Number(response.headers.get("retry-after")) || undefined,
      response.statusText,
    );
  }
  if (typeof data.csrfToken === "string") setCsrf(data.csrfToken);
  return data as T;
}

/** Translate stable Gateway codes while preserving unknown server diagnostics. */
export function errorText(error: unknown, t: TFunction): string {
  if (error instanceof ApiError && error.code === "HTTP_ERROR")
    return t("errors.http", {
      status: error.status,
      statusText: error.statusText,
    }).trim();
  if (
    error instanceof ApiError &&
    error.code &&
    Object.hasOwn(en.errors, error.code)
  ) {
    const key = `errors.${error.code}` as `errors.${keyof typeof en.errors}`;
    return t(key, {
      seconds: error.retryAfter ?? 60,
      status: error.status,
      statusText: "",
    });
  }
  if (error instanceof Error) return error.message;
  return typeof error === "string" && error ? error : t("errors.requestFailed");
}
