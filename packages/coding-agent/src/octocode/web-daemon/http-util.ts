import { sameSecret } from "@octocodeai/octocode-common/env";
import type { ServerResponse } from "node:http";

export type Reply = (status: number, body: unknown, headers?: Record<string, string>) => void;

export function replier(res: ServerResponse): Reply {
	return (status, body, headers) => {
		if (res.headersSent) return;
		res.writeHead(status, {
			...headers,
			"content-type": "application/json",
			"cache-control": "no-store",
			"x-content-type-options": "nosniff",
		});
		res.end(JSON.stringify(body));
	};
}

/** The daemon's three capabilities. `launch` is the local browser's and CLI's; `remote` and `view` go into published links. */
export interface DaemonTokens {
	launch: string;
	remote: string;
	view: string;
}

/** What a presented token is: `launch` (the page's full surface and every admin route), `remote` (the same page, no admin), `view` (reads only). */
export type TokenAccess = "launch" | "remote" | "view";

/** Which capability a presented token is, or undefined. Every comparison always runs. */
export function tokenAccess(supplied: string, tokens: DaemonTokens): TokenAccess | undefined {
	const launch = sameSecret(tokens.launch, supplied);
	const remote = sameSecret(tokens.remote, supplied);
	const view = sameSecret(tokens.view, supplied);
	return launch ? "launch" : remote ? "remote" : view ? "view" : undefined;
}
