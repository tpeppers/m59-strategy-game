const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export function isLoopbackHostname(hostname: string) {
  return LOOPBACK_HOSTS.has(hostname.toLowerCase());
}

export function isLocalCommandRequest(request: Request, write = false) {
  const requestUrl = new URL(request.url);
  if (!isLoopbackHostname(requestUrl.hostname)) return false;
  if (!write) return true;

  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite === "cross-site") return false;

  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    const originUrl = new URL(origin);
    return isLoopbackHostname(originUrl.hostname) && originUrl.origin === requestUrl.origin;
  } catch {
    return false;
  }
}
