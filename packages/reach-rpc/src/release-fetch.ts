const origins = new Set(["https://api.github.com", "https://github.com", "https://release-assets.githubusercontent.com", "https://objects.githubusercontent.com"]);

export function approvedReleaseUrl(value: string): URL {
  const url = new URL(value);
  if (/[\x00-\x20\x7f]/.test(value) || url.username || url.password || url.hash || !origins.has(url.origin)) throw new Error("Unapproved release origin");
  return url;
}

export async function fetchRelease(url: string, headers: Record<string, string>, fetcher: typeof fetch = fetch): Promise<Response> {
  let current = approvedReleaseUrl(url);
  const forwarded = { ...headers };
  for (let redirects = 0; redirects <= 5; redirects++) {
    const response = await fetcher(current.href, { headers: { ...forwarded }, redirect: "manual", signal: AbortSignal.timeout(30_000) });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get("location");
    if (!location) throw new Error("Release redirect missing location");
    await response.body?.cancel();
    const next = approvedReleaseUrl(new URL(location, current).href);
    if (next.origin !== current.origin) {
      for (const key of Object.keys(forwarded)) if (["authorization", "cookie", "proxy-authorization"].includes(key.toLowerCase())) delete forwarded[key];
    }
    current = next;
  }
  throw new Error("Too many release redirects");
}
