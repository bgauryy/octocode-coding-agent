import { handleTerminalCommands, sessionCommand } from "./terminal-commands.ts";
import {
	ApplicationCommandSchema,
	type ApplicationConnection,
	type ApplicationCursor,
} from "@octocodeai/octocode-contracts";
import { sharedClock } from "@octocodeai/octocode-common/clock";
import { sameSecret } from "@octocodeai/octocode-common/env";
import { redactData, redactSecrets, registerSecretValue } from "@octocodeai/octocode-common/sanitize";
import { livePageHeaderPolicy, renderBacklogHtml, WEB_PAGE_ASSETS } from "@octocodeai/octocode-webview";
import {
	handleWebPrefsRequest,
	serveServiceWorker,
	settingsWebPrefs,
	type WebPrefsStore,
} from "../browser/page-routes.ts";
import {
	WorkspaceCommandSchema,
	WORKSPACE_ROUTES,
	type WorkspaceServerEvent,
} from "@octocodeai/octocode-contracts/protocol";
import { STATES, type Snapshot } from "@octocodeai/octocode-contracts/snapshot";
import { randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer, WebSocket } from "ws";
import { Value } from "typebox/value";
import type { Backlog, BacklogWeb } from "../backlog/context.ts";
import { backlogSnapshot } from "../backlog/snapshot.ts";
import { BacklogError, TaskError } from "../backlog/store.ts";
import { applyBoardWrite } from "../backlog/web-commands.ts";
import { handleApplicationDataRequest } from "./application-data.ts";
import { pumpApplicationFrames } from "./application-stream.ts";
import { handleDocsRequest, repoDocsNeverTrusted, type RepoDocsTrusted } from "./docs.ts";
import { inlineScriptHash } from "./inline-script-hash.ts";
import { bearerOf, ownHost, ownOrigin, readHello, servePage } from "./page-access.ts";

import { handleProfilerRequest } from "../profiler/route.ts";
import { handleReportsRequest } from "./reports.ts";
import { workspaceChanges, type RevisedWorkspace } from "./revision.ts";
import { readerStalled } from "./socket-pressure.ts";
import type { SessionConfig } from "./session-config-port.ts";
import { handleEvidenceRequest, localEvidence } from "./evidence-route.ts";
import { BacklogProjection } from "./backlog-projection.ts";

/** A loopback board with a per-launch capability; the general session API stays browser-inaccessible. */
export async function startWorkspaceWeb(
	backlog: Backlog,
	changed: () => void = () => {},
	workspace?: RevisedWorkspace,
	repoDocsTrusted: RepoDocsTrusted = repoDocsNeverTrusted,
	webPrefs: WebPrefsStore = settingsWebPrefs(),
	sessionConfig?: SessionConfig,
): Promise<BacklogWeb> {
	const token = randomBytes(32).toString("hex");
	// The page's address carries it (`url`), and `/web` says that address in a notice the session's pages and an attached
	// daemon's tabs (a view link's included) receive: registered, every redacted copy reads `[redacted]`.
	registerSecretValue(token);
	const page = () =>
		renderBacklogHtml(
			{ repo: backlog.repoName, generatedAt: Date.now(), states: STATES, idleMs: 604800000, items: [] },
			true,
		);
	// The page's script text never depends on its data, so one hash covers every render.
	const csp = livePageHeaderPolicy(inlineScriptHash(page()));
	const notifyChanged = () => {
		try {
			changed();
		} catch {
			// Refreshing a view cannot turn a committed mutation into a failed request.
		}
	};
	let origin = "";
	const sockets = new WebSocketServer({ noServer: true, maxPayload: 1024, perMessageDeflate: false });
	const authenticated = new Set<WebSocket>();
	const applicationStreams = new Map<WebSocket, ApplicationConnection>();
	const streamApplication = async (socket: WebSocket, cursor?: ApplicationCursor) => {
		if (!workspace?.application) return;
		let connection: ApplicationConnection;
		try {
			connection = workspace.application.connect({ sessionId: backlog.session, cursor });
		} catch {
			socket.close(1008, "Session changed; reopen the workspace");
			return;
		}
		applicationStreams.set(socket, connection);
		try {
			await pumpApplicationFrames(socket, connection);
		} finally {
			applicationStreams.delete(socket);
		}
	};
	const authorized = (value: string) => sameSecret(token, value);
	let revision = backlog.store.revision;
	const projection = new BacklogProjection(
		(now) => backlogSnapshot(backlog.store, backlog.repoName, now, backlog.session),
		(id) => backlog.store.liveHolder(id, true) !== undefined,
		backlog.session,
	);
	const snapshot = () => projection.read();
	const sendSnapshot = (socket: WebSocket, data: Snapshot) => {
		if (readerStalled(socket)) return socket.terminate();
		if (socket.readyState === WebSocket.OPEN)
			socket.send(JSON.stringify({ type: "snapshot", data } satisfies WorkspaceServerEvent));
	};
	const sendWorkspace = (socket: WebSocket) => {
		if (!workspace || socket.readyState !== WebSocket.OPEN) return;
		if (readerStalled(socket)) return socket.terminate();
		socket.send(JSON.stringify({ type: "workspace", data: workspace.snapshot() } satisfies WorkspaceServerEvent));
	};
	const broadcast = (data?: Snapshot) => {
		if (!authenticated.size) return;
		if (!data) revision = backlog.store.revision;
		const value = data ?? snapshot();
		for (const socket of authenticated) {
			try {
				sendSnapshot(socket, value);
			} catch {
				socket.terminate();
			}
		}
	};
	// One profiler subscription while a page is connected: a finished request of a listed agent goes to every page.
	let stopProfiler: (() => void) | undefined;
	const profilerLive = () => {
		if (!workspace?.profiler || stopProfiler || !authenticated.size) return;
		stopProfiler = workspace.profiler.subscribe((update) => {
			const text = JSON.stringify({ type: "profiler", data: redactData(update) } satisfies WorkspaceServerEvent);
			for (const socket of authenticated) {
				if (socket.readyState !== WebSocket.OPEN) continue;
				if (readerStalled(socket)) socket.terminate();
				else socket.send(text);
			}
		});
	};
	const profilerIdle = () => {
		if (authenticated.size) return;
		stopProfiler?.();
		stopProfiler = undefined;
	};
	const workspaceChanged = workspace && workspaceChanges(workspace);
	const workspaceUpdates = () => {
		if (!workspaceChanged || !authenticated.size) return;
		try {
			if (!workspaceChanged()) return;
		} catch {
			for (const socket of authenticated) socket.terminate();
			return;
		}
		for (const socket of authenticated) {
			try {
				sendWorkspace(socket);
			} catch {
				socket.terminate();
			}
		}
	};
	const unsubscribe = workspace?.subscribe(workspaceUpdates);
	const server = http.createServer((req, res) => {
		const reply = (status: number, body: unknown, headers?: Record<string, string>) => {
			// A failure after the answer went out must not write headers again: that throws inside the rejection handler.
			if (res.headersSent) {
				res.end();
				return;
			}
			res.writeHead(status, {
				...headers,
				"content-type": "application/json",
				"cache-control": "no-store",
				"x-content-type-options": "nosniff",
			});
			res.end(JSON.stringify(body));
		};
		const handle = async () => {
			if (!ownHost(req, origin) || !ownOrigin(req, origin))
				return reply(403, { error: "This board accepts requests only from its own local address." });
			if (req.method === "GET" && req.url === "/") return servePage(res, page(), csp);
			// Static code like the page: no token, but the host and origin checks above still apply.
			if (serveServiceWorker(req, req.url ?? "", res, WEB_PAGE_ASSETS)) return;
			if (!authorized(bearerOf(req)))
				return reply(401, { error: "Reopen /web to connect to the Octocode web workspace." });
			if (req.url === WORKSPACE_ROUTES.application && !workspace?.application)
				return reply(503, { error: "Application controls are unavailable in this session." });
			if (req.url === WORKSPACE_ROUTES.workspace && !workspace)
				return reply(503, { error: "Agent controls are unavailable in this session." });
			const requestUrl = new URL(req.url ?? "/", origin);
			if (await handleWebPrefsRequest(req, requestUrl.pathname, webPrefs, reply, WEB_PAGE_ASSETS)) return;
			if (await handleApplicationDataRequest(req, requestUrl, workspace?.application, backlog.session, reply)) return;
			if (await handleEvidenceRequest(req, requestUrl, localEvidence(backlog.repoRoot), backlog.session, reply)) return;
			if (
				await handleTerminalCommands(
					req,
					requestUrl,
					true,
					(request) => sessionCommand(backlog.session, request),
					reply,
				)
			)
				return;
			if (await sessionConfig?.handle(req, requestUrl, reply)) return;
			if (await handleProfilerRequest(req, requestUrl, workspace?.profiler, reply)) return;
			if (requestUrl.pathname === WORKSPACE_ROUTES.audit && req.method === "GET") {
				const before = requestUrl.searchParams.get("before");
				if (before !== null && !/^[1-9][0-9]*$/.test(before)) return reply(400, { error: "Invalid audit cursor" });
				const events = await backlog.store.auditAsync(
					requestUrl.searchParams.get("backlogId") ?? undefined,
					100,
					before ? Number(before) : undefined,
				);
				return reply(200, { events, before: events.length === 100 ? events[0].id : undefined });
			}
			if (handleReportsRequest(req, requestUrl, backlog.repoRoot, reply)) return;
			if (await handleDocsRequest(req, requestUrl, backlog.repoRoot, reply, repoDocsTrusted)) return;
			if (
				req.url !== WORKSPACE_ROUTES.backlogs &&
				req.url !== WORKSPACE_ROUTES.workspace &&
				req.url !== WORKSPACE_ROUTES.application
			)
				return reply(404, { error: "Not found" });
			if (req.method === "GET" && req.url === WORKSPACE_ROUTES.workspace) return reply(200, workspace!.snapshot());
			if (req.method === "GET" && req.url === WORKSPACE_ROUTES.application)
				return reply(405, { error: "Use the application stream for state." });
			if (req.method === "GET")
				return reply(200, backlogSnapshot(backlog.store, backlog.repoName, Date.now(), backlog.session));
			if (req.method !== "POST" || req.headers["content-type"] !== "application/json")
				return reply(400, { error: "Use JSON" });
			let bytes = 0;
			const chunks: Buffer[] = [];
			for await (const chunk of req) {
				bytes += chunk.length;
				if (bytes > 262144) {
					reply(413, { error: "Request too large" });
					return;
				}
				chunks.push(chunk);
			}
			let input: unknown;
			try {
				input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
			} catch {
				return reply(400, { error: "Invalid JSON" });
			}
			if (req.url === WORKSPACE_ROUTES.application) {
				if (!Value.Check(ApplicationCommandSchema, input)) return reply(400, { error: "Invalid application command" });
				if (input.sessionId !== backlog.session) return reply(409, { error: "Session changed" });
				const receipt = await workspace!.application!.execute(input);
				return reply(200, { receipt: redactData(receipt) });
			}
			if (req.url === WORKSPACE_ROUTES.workspace) {
				if (!Value.Check(WorkspaceCommandSchema, input)) return reply(400, { error: "Invalid workspace command" });
				const receipt = await workspace!.execute(input);
				if (receipt.status === "accepted") notifyChanged();
				broadcast();
				workspaceUpdates();
				return reply(200, { receipt });
			}
			const outcome = await applyBoardWrite(backlog.store, input, backlog.session);
			if (!outcome.ok) return reply(400, { error: outcome.error });
			notifyChanged();
			broadcast();
			reply(200, outcome.result);
		};
		void handle().catch((error: unknown) =>
			reply(409, {
				// Application and agent commands fail with arbitrary text (provider, tool, git): redact it as the daemon does.
				error: error instanceof Error ? redactSecrets(error.message) : "Backlog change failed",
				...(error instanceof BacklogError && error.current ? { current: error.current } : {}),
				...(error instanceof TaskError && error.task ? { task: error.task } : {}),
			}),
		);
	});
	server.on("upgrade", (req, socket, head) => {
		// Node hands the socket over without its own error listener: a peer that resets must not end the session.
		socket.on("error", () => socket.destroy());
		if (
			req.url !== WORKSPACE_ROUTES.live ||
			!ownHost(req, origin) ||
			!ownOrigin(req, origin, true) ||
			sockets.clients.size >= 32
		) {
			socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
			return;
		}
		sockets.handleUpgrade(req, socket, head, (client) => {
			const timeout = setTimeout(() => client.terminate(), 5000);
			timeout.unref();
			client.on("error", () => client.terminate());
			client.on("close", () => {
				clearTimeout(timeout);
				authenticated.delete(client);
				if (!authenticated.size) projection.clear();
				profilerIdle();
				applicationStreams.get(client)?.close();
				applicationStreams.delete(client);
			});
			client.on("message", (data, binary) => {
				if (authenticated.has(client)) return client.close(1008, "Updates only");
				const hello = readHello(data as Buffer, binary);
				if ("refusal" in hello) return client.close(1008, hello.refusal);
				const { token: supplied, cursor } = hello;
				if (!authorized(supplied)) return client.close(1008, "Reopen /web");
				clearTimeout(timeout);
				authenticated.add(client);
				profilerLive();
				try {
					broadcast();
					sendWorkspace(client);
					void streamApplication(client, cursor).catch(() => client.terminate());
				} catch {
					client.terminate();
				}
			});
		});
	});
	// Other agent processes share SQLite; watch its revision without polling from each browser.
	const stopUpdates = sharedClock.subscribe(
		() => {
			if (!authenticated.size) return;
			try {
				workspaceUpdates();
				const next = backlog.store.revision;
				if (next !== revision) {
					revision = next;
					broadcast();
				} else {
					const volatile = projection.refresh();
					if (volatile) broadcast(volatile);
				}
			} catch {
				for (const socket of authenticated) socket.terminate();
			}
		},
		{ everyMs: 500 },
	);
	server.requestTimeout = 10000;
	server.headersTimeout = 10000;
	await new Promise<void>((resolve, reject) => {
		const onError = (error: Error) => {
			stopUpdates();
			stopProfiler?.();
			unsubscribe?.();
			workspace?.close();
			sessionConfig?.close();
			sockets.close();
			reject(error);
		};
		server.once("error", onError);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", onError);
			resolve();
		});
	});
	server.unref();
	origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	let closed = false;
	return {
		url: `${origin}/#access=${token}`,
		isUp: () => !closed && server.listening,
		close: () =>
			new Promise<void>((resolve) => {
				closed = true;
				stopUpdates();
				stopProfiler?.();
				unsubscribe?.();
				workspace?.close();
				sessionConfig?.close();
				for (const socket of sockets.clients) socket.terminate();
				sockets.close();
				server.close(() => resolve());
				server.closeAllConnections();
			}),
	};
}
