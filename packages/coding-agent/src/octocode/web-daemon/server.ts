import { handleTerminalCommands } from "../workspace/terminal-commands.ts";
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
} from "@octocodeai/octocode-contracts/daemon";
import { DAEMON_ROUTES, WORKSPACE_ROUTES } from "@octocodeai/octocode-contracts/protocol";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { livePageHeaderPolicy, WEB_PAGE_ASSETS, WEB_PREFS_ROUTE } from "@octocodeai/octocode-webview";
import {
	handleWebPrefsRequest,
	serveServiceWorker,
	settingsWebPrefs,
	type WebPrefsStore,
} from "../browser/page-routes.ts";
import { redactSecrets } from "@octocodeai/octocode-common/sanitize";

import { daemonPage, type DaemonPage } from "./build.ts";
import { type ConfigRoutes, handleConfigRequest } from "./config-routes.ts";
import { bearerOf, ownHost, ownOrigin, servePage } from "../workspace/page-access.ts";
import { replier, tokenAccess, type DaemonTokens, type Reply } from "./http-util.ts";
import { LAUNCH_CODE_ROUTE, LAUNCH_DOOR_PREFIX, LaunchCodes, openDoor } from "./launch-code.ts";
import { RemotePublisher } from "./remote/publisher.ts";
import { handleRemoteRequest } from "./remote/routes.ts";
import { handleRepoRequest } from "./repo-routes.ts";
import { RepoCatalog } from "./repos.ts";
import { SessionRegistry } from "./sessions.ts";
import { handleSessionRequest } from "./session-routes.ts";
import { handleSessionSettings } from "./session-settings.ts";
import { TabHub, type TabScope } from "./tabs.ts";

const SCOPE_ID = /^[\w.-]{1,128}$/;
/** The contracts' limit for a list reply; more is reported as `truncated`, never as an error. */
const MAX_LISTED = 200;
const ADMIN_PREFIX = "/api/admin/";

export interface DaemonServerOptions {
	env: NodeJS.ProcessEnv;
	page?: DaemonPage;
	/** Called on each sign of use (a tab, an attached session, an authenticated request) so the idle timer restarts. */
	onActivity: () => void;
	/** The idle limit the caller enforces, reported in the authenticated health answer so `/web` can say it. */
	idleMinutes?: number;
	/** Builds the configuration answer for `GET /api/config`; the caller validates its shape. */
	config: ConfigRoutes["config"];
	/** Checks whether a complete running MCP registry is available before showing the add form. */
	mcpAddStatus?: ConfigRoutes["mcpAddStatus"];
	/** Saves a validated MCP definition without starting or approving it. */
	addMcp?: ConfigRoutes["addMcp"];
	/** Applies a validated `POST /api/admin/config/settings` change to the settings files. */
	writeSetting?: ConfigRoutes["writeSetting"];
	/** Applies a validated `POST /api/admin/config/credentials` change; the command carries a key, so it is never logged. */
	writeCredential?: ConfigRoutes["writeCredential"];
	/** Applies a validated `POST /api/admin/config/providers` switch (a provider or the Pi source on or off). */
	writeProvider?: ConfigRoutes["writeProvider"];
	/** Runs a validated `POST /api/admin/config/providers/test`; the reply is a `ProviderTestReport`. */
	testProviders?: ConfigRoutes["testProviders"];
	/** Runs a validated `POST /api/admin/config/signin` command; the reply is a `SignInState`. */
	signIn?: ConfigRoutes["signIn"];
	/** Lists the Harness panel's switches (`GET /api/admin/config/harness`). */
	harness?: ConfigRoutes["harness"];
	/** Scans one harness switch before it is written (`GET /api/admin/config/harness/preview`). */
	previewHarness?: ConfigRoutes["previewHarness"];
	/** Applies a validated `POST /api/admin/config/harness` switch. */
	writeHarness?: ConfigRoutes["writeHarness"];
	/** Lists the Security panel's reviewed items (`GET /api/admin/config/security`). */
	security?: ConfigRoutes["security"];
	/** Applies a validated `POST /api/admin/config/security` approve, deny or forget. */
	writeSecurity?: ConfigRoutes["writeSecurity"];
	/** Lists the External agents panel's runners (`GET /api/admin/config/runners`). */
	runners?: ConfigRoutes["runners"];
	/** Applies a validated `POST /api/admin/config/runners` command. */
	writeRunners?: ConfigRoutes["writeRunners"];
	/** Lists the Tools panel's rows (`GET /api/admin/config/tools`). */
	tools?: ConfigRoutes["tools"];
	/** Applies a validated `POST /api/admin/config/tools` pin. */
	writeTools?: ConfigRoutes["writeTools"];
	/** Records a credential request refused before it reached `writeCredential`; see `ConfigRoutes.auditRefused`. */
	auditRefused?: ConfigRoutes["auditRefused"];
	/** Asked by `POST /api/admin/drain`. */
	onDrain: () => void;
	/** Where `/api/web-prefs` keeps the page's preferences; the global settings file unless replaced. */
	webPrefs?: WebPrefsStore;
}

export interface DaemonServer {
	readonly port: number;
	/** The launch capability for the local browser and CLI: the page's full surface and every admin route. */
	readonly token: string;
	/** The capability in published control links: the page's full surface, no `/api/admin/*`. Replaced by `/remote stop`. */
	readonly remoteToken: string;
	/** The read-only capability for `/remote view` links: every GET and the live stream, never a command. Replaced by `/remote stop`. */
	readonly viewToken: string;
	readonly nonce: string;
	readonly build: string;
	readonly registry: SessionRegistry;
	readonly tabs: TabHub;
	readonly remote: RemotePublisher;
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
 * The daemon's loopback server. Rules enforced here for every route: the Host header must be the
 * daemon's own `127.0.0.1:<port>`; a request with an Origin must carry exactly the daemon's origin, and a socket
 * upgrade always needs it; only `GET /`, `GET /api/health` and a one-time `GET /open/<code>` need no bearer
 * token, and `/` embeds no data; the page is served with a script-hash Content-Security-Policy; the token is read only from the
 * `Authorization` header or the socket hello, never from a URL; no cookies, no CORS headers, no OPTIONS answer;
 * every scoped route names a session or repository id the daemon itself indexed, never a path.
 */
export async function startDaemonServer(options: DaemonServerOptions): Promise<DaemonServer> {
	const page = options.page ?? daemonPage();
	const token = randomBytes(32).toString("hex");
	// One object, read on every check: a rotated token applies to HTTP and to the next socket hello alike.
	const fresh = () => randomBytes(32).toString("hex");
	const tokens: DaemonTokens = { launch: token, remote: fresh(), view: fresh() };
	const nonce = randomBytes(16).toString("hex");
	const startedAt = Date.now();
	let origin = "";
	let port = 0;
	const notify = () => options.onActivity();
	const launchCodes = new LaunchCodes();
	const registry = new SessionRegistry(options.env, notify);
	const catalog = new RepoCatalog(options.env, registry);
	const state = { draining: false };
	const tabs = new TabHub({
		tokens,
		origin: () => origin,
		catalog,
		env: options.env,
		activity: notify,
		accepting: () => !state.draining,
	});
	const remote = new RemotePublisher({
		port: () => port,
		origin: () => origin,
		tokens: () => tokens,
		// Every published link dies: new requests fail at once and tabs opened through a link are closed.
		rotate: () => {
			tokens.remote = fresh();
			tokens.view = fresh();
			tabs.revoke(["remote", "view"]);
		},
		build: page.build,
		activity: notify,
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
		...(options.idleMinutes ? { idleMinutes: options.idleMinutes } : {}),
	});

	// The page's own script and the Mermaid text its docs view runs inline; the rest of the policy is the page's own.
	const webPrefs = options.webPrefs ?? settingsWebPrefs();
	const csp = livePageHeaderPolicy(page.scriptHash);

	// A board edit from the page repaints the footer counts of every session of that repository, as an edit on the
	// session's own server does.
	const boardWritten = (repoId: string) => () => registry.boardChanged(repoId);

	const handle = async (req: http.IncomingMessage, res: http.ServerResponse, reply: Reply) => {
		if (!ownHost(req, origin) || !ownOrigin(req, origin))
			return reply(403, { error: "The Octocode web workspace accepts requests only from its own local address." });
		const url = requestUrl(req.url, origin);
		if (!url) return reply(400, { error: "Bad request target" });
		if (req.method === "GET" && url.pathname === "/") return servePage(res, page.html, csp);
		if (serveServiceWorker(req, url.pathname, res, WEB_PAGE_ASSETS)) return;
		if (req.method === "GET" && url.pathname.startsWith(LAUNCH_DOOR_PREFIX))
			return openDoor(url, launchCodes, tokens.launch, res, reply);
		const access = tokenAccess(bearerOf(req), tokens);
		if (req.method === "GET" && url.pathname === DAEMON_ROUTES.health) return reply(200, access ? status() : health());
		if (!access) return reply(401, { error: "Reopen /web to connect to the Octocode web workspace." });
		// A view link reads what the page reads and changes nothing: no command, no board write, no admin call.
		if (access === "view" && req.method !== "GET")
			return reply(403, { error: "This link is view-only. Open the workspace from a terminal to act." });
		// Admin routes (drain, publishing, stopping) belong to the launch token: a published control link, SSH or relay, never reaches them.
		if (access !== "launch" && url.pathname.startsWith(ADMIN_PREFIX))
			return reply(403, { error: "This link cannot use admin routes. Run the command in the Octocode terminal." });
		notify();
		if (req.method === "GET" && url.pathname === DAEMON_ROUTES.access)
			return reply(200, { writable: access !== "view", terminalCommands: access === "launch" });
		// Preferences change with the launch capability only, like settings; a published link reads them.
		if (req.method === "POST" && url.pathname === WEB_PREFS_ROUTE && access !== "launch")
			return reply(403, {
				error: "This link cannot change preferences. Use the page opened from the Octocode terminal.",
			});
		if (await handleWebPrefsRequest(req, url.pathname, webPrefs, reply, WEB_PAGE_ASSETS)) return;
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
		if (await handleConfigRequest(req, url, access, { catalog, ...options }, reply)) return;
		// Links carry capabilities: only the launch token may issue or revoke them.
		if (url.pathname === DAEMON_ROUTES.remote) {
			if (await handleRemoteRequest(req, reply, remote)) return;
			return reply(405, { error: "Method not allowed" });
		}
		if (req.method === "POST" && url.pathname === LAUNCH_CODE_ROUTE) return reply(200, { code: launchCodes.issue() });
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
			if (!session) return reply(404, { error: "That session is not attached. Open /web in a running session." });
			const repo = catalog.resolve(session.record.repo.key);
			if (!repo) return reply(404, { error: "Unknown repository" });
			if (
				await handleTerminalCommands(
					req,
					scopedUrl,
					access === "launch",
					(request) => session.client.request("session.commands", request),
					reply,
				)
			)
				return;
			if (await handleSessionSettings(req, scopedUrl, access, options, session, repo, reply)) return;
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
			if (await handleRepoRequest(req, scopedUrl, repo, catalog, scope.id, reply, boardWritten(repo.id))) return;
			return reply(404, { error: "Not found" });
		}
		const repo = catalog.resolve(scope.id);
		if (!repo) return reply(404, { error: "Unknown repository" });
		if (
			scopedUrl.pathname === WORKSPACE_ROUTES.workspace ||
			scopedUrl.pathname === WORKSPACE_ROUTES.application ||
			scopedUrl.pathname.startsWith(WORKSPACE_ROUTES.profiler)
		)
			return reply(503, { error: "Agent controls need a running session; open one from the session list." });
		if (await handleRepoRequest(req, scopedUrl, repo, catalog, undefined, reply, boardWritten(repo.id))) return;
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
		if (!ownHost(req, origin)) return reject("403 Forbidden");
		const url = requestUrl(req.url, origin);
		if (!url) return reject("400 Bad Request");
		// The origin is checked before the scope is looked up, so a foreign page learns nothing about which sessions exist.
		if (!ownOrigin(req, origin, true)) return reject("403 Forbidden");
		const scope = scoped(url.pathname);
		if (!scope || scope.rest !== WORKSPACE_ROUTES.live) return reject("404 Not Found");
		let tabScope: TabScope | undefined;
		if (scope.kind === "session") {
			const session = registry.get(scope.id);
			const repo = session && catalog.resolve(session.record.repo.key);
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
	port = (server.address() as AddressInfo).port;
	origin = `http://127.0.0.1:${port}`;
	registry.start();
	tabs.start();
	return {
		port,
		token,
		get remoteToken() {
			return tokens.remote;
		},
		get viewToken() {
			return tokens.view;
		},
		remote,
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
