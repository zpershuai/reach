import { afterEach, expect, it, vi } from "vitest";
import { api, ApiError } from "./api";
afterEach(() => vi.unstubAllGlobals());
it("reports HTML proxy errors using their HTTP status", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response("<html>Bad Gateway</html>", {
        status: 502,
        headers: { "content-type": "text/html" },
      }),
    ),
  );
  const error = await api("snapshot").catch((error) => error);
  expect(error).toBeInstanceOf(ApiError);
  expect(error.status).toBe(502);
  expect(error.message).toContain("502");
  expect(error.message).not.toContain("Unexpected token");
});
it("accepts empty successful responses", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(new Response(null, { status: 204 })),
  );
  expect(await api("logout", {})).toEqual({});
});
it("still expires the session for HTML 401 responses", async () => {
  const unauthorized = vi.fn();
  window.addEventListener("reach:unauthorized", unauthorized);
  try {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response("<html>Sign in</html>", { status: 401 }),
        ),
    );
    await expect(api("snapshot")).rejects.toMatchObject({ status: 401 });
    expect(unauthorized).toHaveBeenCalledOnce();
  } finally {
    window.removeEventListener("reach:unauthorized", unauthorized);
  }
});

import { errorText } from "./api";
import { i18n, setLang } from "./i18n";
it("localizes known codes and preserves unknown server diagnostics", () => {
  setLang("zh-CN");
  expect(
    errorText(
      new ApiError("Invalid credentials", 401, "INVALID_CREDENTIALS"),
      i18n.t,
    ),
  ).toBe("密码或验证码错误");
  expect(
    errorText(
      new ApiError("Specific Gateway diagnostic", 400, "FUTURE_CODE"),
      i18n.t,
    ),
  ).toBe("Specific Gateway diagnostic");
  expect(
    errorText(
      new ApiError("Too many attempts", 429, "RATE_LIMITED", 120),
      i18n.t,
    ),
  ).toContain("120 秒");
});
it("localizes an HTML 502 proxy response", async () => {
  setLang("zh-CN");
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(
        new Response("<html>Bad Gateway</html>", {
          status: 502,
          headers: { "content-type": "text/html" },
        }),
      ),
  );
  await expect(api("snapshot")).rejects.toThrow("Gateway 返回 HTTP 502");
});
it.each(["null", "[]", "{broken"])(
  "uses localized HTTP fallback for unusable JSON: %s",
  async (body) => {
    setLang("zh-CN");
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(body, {
            status: 502,
            headers: { "content-type": "application/json" },
          }),
        ),
    );
    const error = await api("snapshot").catch((error) => error);
    expect(errorText(error, i18n.t)).toContain("Gateway 返回 HTTP 502");
    setLang("en");
    expect(errorText(error, i18n.t)).toContain("Gateway returned HTTP 502");
  },
);

it.each(["en", "zh-CN"] as const)("preserves an older Gateway response without a code in %s", async (lang) => {
  setLang(lang);
  const message = "Engine is managed by Gateway configuration";
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: message }), {
    status: 409, headers: { "content-type": "application/json" },
  })));
  const error = await api("engines/engine-a/rotate", {}).catch(error => error);
  expect(error.code).toBeUndefined();
  expect(errorText(error, i18n.t)).toBe(message);
});
it("distinguishes each known resource error in Chinese and preserves its English meaning", () => {
  const errors = [
    ["ENGINE_ID_EXISTS", "Engine id already exists", "Engine ID 已存在"],
    ["ENGINE_AUTH_REQUIRED", "Multiple Engines require Gateway authentication", "管理多个 Engine 需要配置 Gateway 身份验证"],
    ["ENGINE_CONFIG_MANAGED", "Engine is managed by Gateway configuration", "此 Engine 由 Gateway 配置管理"],
    ["INVALID_CREDENTIAL_EXPIRY", "Credential expiry must be a future timestamp", "凭证到期时间必须晚于当前时间"],
    ["INVALID_CLIENT_CREDENTIAL", "Invalid or expired client credential", "客户端凭证无效或已过期"],
  ];
  for (const [code, english, chinese] of errors) {
    const error = new ApiError(english, 400, code);
    expect(errorText(error, i18n.getFixedT("en"))).toBe(english);
    expect(errorText(error, i18n.getFixedT("zh-CN"))).toBe(chinese);
  }
});
it.each(["fetch", "body"])("localizes network failures during %s and follows language switches", async (stage) => {
  const networkError = new TypeError("Failed to fetch");
  vi.stubGlobal("fetch", stage === "fetch"
    ? vi.fn().mockRejectedValue(networkError)
    : vi.fn().mockResolvedValue({ text: () => Promise.reject(networkError) }));
  setLang("zh-CN");
  const error = await api("me").catch(error => error);
  expect(errorText(error, i18n.t)).toBe("无法连接 Gateway");
  setLang("en");
  expect(errorText(error, i18n.t)).toBe("Gateway unavailable");
});

it("translates the malformed-auth-request code", () => {
  expect(errorText(new ApiError("Invalid request", 400, "INVALID_REQUEST"), i18n.getFixedT("zh-CN"))).toBe("控制台请求无效");
});
