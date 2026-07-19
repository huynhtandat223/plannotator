/**
 * Builds the URL for an isolated full-review listener from the browser that
 * initiated it. The Herdr process runs on WSL, so its own `localhost` is not
 * necessarily the reviewer's browser (for example, a Tailscale mobile client).
 * The Herdr host returns the listener port only after binding it to the same
 * network interface as the host service.
 */
export function fullReviewUrlForBrowser(browserUrl: string, port: number): string {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("Full review did not provide a valid listener port");
  }

  const url = new URL(browserUrl);
  // The isolated server is an HTTP listener. Use the browser's host (including
  // a Tailscale address) rather than the WSL process's localhost.
  url.protocol = "http:";
  url.port = String(port);
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url.toString();
}
