import { bareHostname } from "./web-guard.ts";

/**
 * The key an approval, a grant and the filtering proxy's allowance share for one host and port. The proxy
 * (`browser-proxy.ts`) refuses a page's request to a private or unresolved host unless the agent opened that host and
 * port itself; the browser preset records the hosts the permission check allowed under these keys.
 */

const DEFAULT_PORTS: Readonly<Record<string, number>> = { "http:": 80, "ws:": 80, "https:": 443, "wss:": 443 };
export const portOf = (url: URL): number => (url.port ? Number(url.port) : (DEFAULT_PORTS[url.protocol] ?? 0));
/** `hostname:port` with brackets off an IPv6 literal: what an approval, a grant and the proxy's allowance are keyed by (see `keyOf`). */
export const hostKey = (hostname: string, port: number): string => `${bareHostname(hostname)}:${port}`;
/** `hostKey` of a URL, the port being the effective one (80 and 443 when the URL omits it). */
export const keyOf = (url: URL): string => hostKey(url.hostname, portOf(url));
