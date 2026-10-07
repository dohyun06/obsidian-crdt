const LOCAL_HOSTS: readonly string[] = ["localhost", "127.0.0.1", "[::1]"];

export class InsecureServerUrlError extends Error {
  constructor(url: string) {
    super(`server URL must use wss:// (ws:// only for localhost): "${url}"`);
    this.name = "InsecureServerUrlError";
  }
}

export function assertSecureServerUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new InsecureServerUrlError(url);
  }
  if (parsed.protocol === "wss:") return;
  if (parsed.protocol === "ws:" && LOCAL_HOSTS.includes(parsed.hostname)) return;
  throw new InsecureServerUrlError(url);
}
