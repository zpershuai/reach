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
