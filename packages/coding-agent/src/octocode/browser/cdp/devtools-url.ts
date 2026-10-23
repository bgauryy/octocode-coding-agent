import { isLoopbackHostname } from "../../shared/net.ts";

/**
 * Refuses a DevTools WebSocket URL that is not the local browser's own, in every mode: a browser on `port` (even an
 * attached one the user started) answers `/json/list` with a `webSocketDebuggerUrl`, and a hostile or confused answer
 * must not point the session at another host, port or service. The scheme is `ws:`, the host this machine, the port
 * the one asked for and the path under `/devtools/`.
 */
export function checkDevtoolsUrl(raw: string, port: number): void {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new Error(`Refused a DevTools URL that is not a URL: ${raw}`);
	}
	const problem =
		url.protocol !== "ws:"
			? `scheme ${url.protocol} is not ws:`
			: !isLoopbackHostname(url.hostname)
				? `host ${url.hostname} is not this machine`
				: Number(url.port) !== port
					? `port ${url.port || "(default)"} is not ${port}`
					: !url.pathname.startsWith("/devtools/")
						? `path ${url.pathname} is not under /devtools/`
						: undefined;
	if (problem) throw new Error(`Refused the DevTools URL ${url.protocol}//${url.host}${url.pathname}: ${problem}.`);
}
