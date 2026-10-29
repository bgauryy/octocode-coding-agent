import { randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Value } from "typebox/value";
import {
	DAEMON_PROTOCOL_VERSION,
	DaemonReposSchema,
	DaemonSessionsSchema,
	type DaemonHealth,
	type DaemonStatus,
} from "@octocodeai/octocode-contacts/daemon";
import { DAEMON_ROUTES, WORKSPACE_ROUTES } from "@octocodeai/octocode-contacts/protocol";
import { errorMessage } from "../../utils/guards.ts";
import { redactSecrets } from "../shared/sanitize.ts";
import { daemonPage, type DaemonPage } from "./build.ts";
import { bearerOf, replier, tokenMatches, type Reply } from "./http-util.ts";
import { handleRepoRequest } from "./repo-routes.ts";
import { RepoCatalog } from "./repos.ts";
import { repoId, SessionRegistry } from "./sessions.ts";
import { handleSessionRequest } from "./session-routes.ts";
import { TabHub, type TabScope } from "./tabs.ts";

const SCOPE_ID = /^[\w.-]{1,128}$/;
/** The contracts' limit for a list reply; more is reported as `truncated`, never as an error. */
const MAX_LISTED = 200;

export interface DaemonServerOptions {
	env: NodeJS.ProcessEnv;
	page?: DaemonPage;
	/** Called on each sign of use (a tab, an attached session, an authenticated request) so the idle timer restarts. */
	onActivity: () => void;
	/** Builds the read-only configuration answer for `GET /api/config`; the caller validates its shape. */
	config: (repo: { root?: string } | undefined) => Promise<unknown>;
	/** Asked by `POST /api/admin/drain`. */
	onDrain: () => void;
}

export interface DaemonServer {
	readonly port: number;
	readonly token: string;
	readonly nonce: string;
	readonly build: string;
	readonly registry: SessionRegistry;
	readonly tabs: TabHub;
	draining: boolean;
	status(): DaemonStatus;
	close(): Promise<void>;
}

/** Parses `/s/<id>/<rest>` or `/r/<repoId>/<rest>` into its scope and the workspace route it carries. */
function scoped(pathname: string): { kind: "session" | "repo"; id: string; rest: string } | undefined {
	for (const [kind, prefix] of [
		["session", DAEMON_ROUTES.scope.session],
		["repo", DAEMON_ROUTES.scope.repo],
	] as const) {
		if (!pathname.startsWith(prefix + "/")) continue;
		const tail = pathname.slice(prefix.length + 1);
		const slash = tail.indexOf("/");
		const id = slash < 0 ? tail : tail.slice(0, slash);
		if (!SCOPE_ID.test(id)) return undefined;
		const rest = slash < 0 ? "/" : tail.slice(slash);
		// A rest of `//...` would read as a network-path reference when joined to the origin.
		return rest.startsWith("//") ? undefined : { kind, id, rest };
	}
	return undefined;
}

/** The URL of a request target that is an origin-form path (`/x`); undefined for `//x`, absolute or `*` targets. */
function requestUrl(target: string | undefined, origin: string): URL | undefined {
	if (!target || !target.startsWith("/") || target.startsWith("//")) return undefined;
	try {
		return new URL(origin + target);
	} catch {
		return undefined;
	}
}

/**
 * The daemon's loopback server. Rules enforced here for every route (R1-R9 of the RFC): the Host header must be the
 * daemon's own `127.0.0.1:<port>` (R3); a request with an Origin must carry exactly the daemon's origin, and a socket
 * upgrade always needs it (R2, R4); only `GET /` and `GET /api/health` need no bearer token (R5), and `/` embeds no
 * data; the page is served with a script-hash Content-Security-Policy (R6); the token is read only from the
 * `Authorization` header or the socket hello, never from a URL (R1); no cookies, no CORS headers, no OPTIONS answer (R2);
 * every scoped route names a session or repository id the daemon itself indexed, never a path (R8).
 */
export async function startDaemonServer(options: DaemonServerOptions): Promise<DaemonServer> {
	const page = options.page ?? daemonPage();
	const token = randomBytes(32).toString("hex");
	const nonce = randomBytes(16).toString("hex");
	const startedAt = Date.now();
	let origin = "";
	let host = "";
	const notify = () => options.onActivity();
	const registry = new SessionRegistry(options.env, notify);
	const catalog = new RepoCatalog(options.env, registry);
	const state = { draining: false };
	const tabs = new TabHub({
		token,
		origin: () => origin,
		catalog,
		env: options.env,
		activity: notify,
		accepting: () => !state.draining,
	});
	const health = (): DaemonHealth => ({ ok: true, protocolVersion: DAEMON_PROTOCOL_VERSION, build: page.build });
	const status = (): DaemonStatus => ({
		...health(),
		nonce,
		pid: process.pid,
		startedAt,
		tabs: tabs.count,
		sessions: registry.attached,
		draining: state.draining,
	});

	const csp = [
		"default-src 'none'",
		`script-src '${page.scriptHash}'`,
		"style-src 'unsafe-inline'",
		"img-src data:",
		"connect-src 'self'",
		"base-uri 'none'",
		"form-action 'none'",
		"frame-ancestors 'none'",
	].join("; ");

	const handle = async (req: http.IncomingMessage, res: http.ServerResponse, reply: Reply) => {
		if (req.headers.host !== host || (req.headers.origin !== undefined && req.headers.origin !== origin))
			return reply(403, { error: "The Octocode web workspace accepts requests only from its own local address." });
		const url = requestUrl(req.url, origin);
		if (!url) return reply(400, { error: "Bad request target" });
		if (req.method === "GET" && url.pathname === "/") {
			res.writeHead(200, {
				"content-type": "text/html; charset=utf-8",
				"cache-control": "no-store",
				"referrer-policy": "no-referrer",
				"x-frame-options": "DENY",
				"x-content-type-options": "nosniff",
				"content-security-policy": csp,
			});
			res.end(page.html);
			return;
		}
		const authorized = tokenMatches(bearerOf(req), token);
		if (req.method === "GET" && url.pathname === DAEMON_ROUTES.health)
			return reply(200, authorized ? status() : health());
		if (!authorized) return reply(401, { error: "Reopen /octocode to connect to the Octocode web workspace." });
		notify();
		if (req.method === "GET" && url.pathname === DAEMON_ROUTES.sessions) {
			const all = registry.list();
			const unavailable = registry.unavailable();
			const body = {
				sessions: all.slice(0, MAX_LISTED),
				...(unavailable.length ? { unavailable } : {}),
				...(all.length > MAX_LISTED ? { truncated: true } : {}),
			};
			if (!Value.Check(DaemonSessionsSchema, body)) return reply(500, { error: "Session list is invalid" });
			return reply(200, body);
		}
		if (req.method === "GET" && url.pathname === DAEMON_ROUTES.repos) {
			const all = catalog.summaries();
			const body = { repos: all.slice(0, MAX_LISTED), ...(all.length > MAX_LISTED ? { truncated: true } : {}) };
			if (!Value.Check(DaemonReposSchema, body)) return reply(500, { error: "Repository list is invalid" });
			return reply(200, body);
		}
		if (req.method === "GET" && url.pathname === DAEMON_ROUTES.config) {
			const repoParam = url.searchParams.get("repoId");
			const repo = repoParam ? catalog.resolve(repoParam) : undefined;
			if (repoParam && !repo) return reply(404, { error: "Unknown repository" });
			try {
				return reply(200, await options.config(repo));
			} catch (error) {
				return reply(500, { error: redactSecrets(errorMessage(error)).slice(0, 500) });
			}
		}
		if (req.method === "POST" && url.pathname === DAEMON_ROUTES.drain) {
			reply(200, { draining: true });
			options.onDrain();
			return;
		}
		const scope = scoped(url.pathname);
		if (!scope) return reply(404, { error: "Not found" });
		const scopedUrl = new URL(origin + scope.rest + url.search);
		if (scope.kind === "session") {
			const session = registry.get(scope.id);
			if (!session) return reply(404, { error: "That session is not attached. Open /octocode in a running session." });
			const repo = catalog.resolve(repoId(session.record.repo.key));
			if (!repo) return reply(404, { error: "Unknown repository" });
			if (
				await handleSessionRequest(
					req,
					scopedUrl,
					scope.id,
					session.client,
					reply,
					() => void tabs.workspaceChanged(scope.id, true).catch(() => undefined),
				)
			)
				return;
			if (await handleRepoRequest(req, scopedUrl, repo, catalog, scope.id, reply)) return;
			return reply(404, { error: "Not found" });
		}
		const repo = catalog.resolve(scope.id);
		if (!repo) return reply(404, { error: "Unknown repository" });
		if (scopedUrl.pathname === WORKSPACE_ROUTES.workspace || scopedUrl.pathname === WORKSPACE_ROUTES.application)
			return reply(503, { error: "Agent controls need a running session; open one from the session list." });
		if (await handleRepoRequest(req, scopedUrl, repo, catalog, undefined, reply)) return;
		return reply(404, { error: "Not found" });
	};

	const server = http.createServer((req, res) => {
		const reply = replier(res);
		void handle(req, res, reply).catch((error: unknown) =>
			reply(500, { error: redactSecrets(errorMessage(error)).slice(0, 500) }),
		);
	});
	server.on("upgrade", (req, socket, head) => {
		// Node hands the socket over without its own error listener: a peer that resets must not become an uncaught error.
		socket.on("error", () => socket.destroy());
		const reject = (status: string) => void socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
		if (req.headers.host !== host) return reject("403 Forbidden");
		const url = requestUrl(req.url, origin);
		if (!url) return reject("400 Bad Request");
		// The origin is checked before the scope is looked up, so a foreign page learns nothing about which sessions exist.
		if (req.headers.origin !== origin) return reject("403 Forbidden");
		const scope = scoped(url.pathname);
		if (!scope || scope.rest !== WORKSPACE_ROUTES.live) return reject("404 Not Found");
		let tabScope: TabScope | undefined;
		if (scope.kind === "session") {
			const session = registry.get(scope.id);
			const repo = session && catalog.resolve(repoId(session.record.repo.key));
			if (session && repo) tabScope = { repo, session: { id: scope.id, client: session.client } };
		} else {
			const repo = catalog.resolve(scope.id);
			if (repo) tabScope = { repo };
		}
		if (!tabScope) return reject("404 Not Found");
		tabs.upgrade(req, socket, head, tabScope);
	});
	server.requestTimeout = 10000;
	server.headersTimeout = 10000;
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
	const port = (server.address() as AddressInfo).port;
	host = `127.0.0.1:${port}`;
	origin = `http://${host}`;
	registry.start();
	tabs.start();
	return {
		port,
		token,
		nonce,
		build: page.build,
		registry,
		tabs,
		get draining() {
			return state.draining;
		},
		set draining(value: boolean) {
			state.draining = value;
			registry.paused = value;
			if (value) tabs.announceDrain();
		},
		status,
		close: () =>
			new Promise<void>((resolve) => {
				registry.close();
				tabs.closeAll();
				server.close(() => resolve());
				server.closeAllConnections();
			}),
	};
}
