import type http from "node:http";

/** Settings routes injected by the root composer: the workspace domain cannot import `web-daemon`, which owns them. */
export interface SessionConfig {
	/** Answers a settings request (the caller checked the token) and returns true, or returns false for another route. */
	handle(req: http.IncomingMessage, url: URL, reply: (status: number, body: unknown) => void): Promise<boolean>;
	/** Cancels running sign-ins; called when the server closes. */
	close(): void;
}
