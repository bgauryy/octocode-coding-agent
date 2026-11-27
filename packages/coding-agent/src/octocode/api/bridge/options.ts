/** Which transports the API serves on, from the `sessionApi` setting and `OCTOCODE_API_HTTP`, or from `/api on`. */

const API_HTTP_ENV = "OCTOCODE_API_HTTP";

export interface ApiOptions {
	/** Serve on a Unix socket (default when enabled; not available on Windows). */
	socket: boolean;
	/** Serve on loopback HTTP: a port, 0 for any free port, or undefined for no HTTP. */
	http?: number | undefined;
}

/**
 * The transports a session starts with. The owner-only Unix socket is on unless `enabled` (the `sessionApi` setting) says
 * no. Loopback HTTP takes `OCTOCODE_API_HTTP` naming a port, because any local program can open that port and only the
 * token stands in its way. Windows has no owner-only socket here, so it starts nothing unless a port is named. A bad port
 * throws its reason instead of silently serving nothing.
 */
export function startupOptions(
	enabled: boolean,
	env: NodeJS.ProcessEnv = process.env,
	platform = process.platform,
): ApiOptions | undefined {
	if (!enabled) return undefined;
	const httpText = env[API_HTTP_ENV]?.trim();
	const port =
		httpText === undefined || httpText === "" ? undefined : /^\d+$/.test(httpText) ? Number(httpText) : Number.NaN;
	if (port !== undefined && !(port >= 0 && port <= 65_535))
		throw new Error(`Octocode API is off: ${API_HTTP_ENV}=${httpText} is not a port (0-65535; 0 picks a free one).`);
	const socket = platform !== "win32";
	return socket || port !== undefined ? { socket, http: port } : undefined;
}

/** The transports of an API a person switched on: a Unix socket where there are any, and loopback HTTP on `http` (0: a free port) or, where there is no socket, on a free port. */
export function transportsFor(http: number | undefined, platform = process.platform): ApiOptions {
	const socket = platform !== "win32";
	return { socket, http: http ?? (socket ? undefined : 0) };
}
