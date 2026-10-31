import {
	ApplicationCommandSchema,
	APPLICATION_PROTOCOL_VERSION,
	type ApplicationConnection,
	type ApplicationCursor,
} from "@octocodeai/octocode-contracts";
import { redactData } from "../../../../common/src/sanitize.ts";
import { renderBacklogHtml } from "@octocodeai/octocode-webview";
import {
	WorkspaceCommandSchema,
	BacklogMutationSchema,
	WORKSPACE_ROUTES,
	type WorkspaceServerEvent,
} from "@octocodeai/octocode-contracts/protocol";
import { STATES } from "@octocodeai/octocode-contracts/snapshot";
import { randomBytes, timingSafeEqual } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer, WebSocket } from "ws";
import { Value } from "typebox/value";
import { USER_AUTHOR } from "../agentdb/author.ts";
import type { Backlog, BacklogWeb } from "../backlog/context.ts";
import { backlogSnapshot } from "../backlog/snapshot.ts";
import { BacklogError } from "../backlog/store.ts";
import { handleApplicationDataRequest } from "./application-data.ts";
import { pumpApplicationFrames } from "./application-stream.ts";
import { handleReportsRequest } from "./reports.ts";
import { workspaceChanges, type RevisedWorkspace } from "./revision.ts";

/** A loopback board with a per-launch capability; the general session API stays browser-inaccessible. */
export async function startWorkspaceWeb(
	backlog: Backlog,
	changed: () => void = () => {},
	workspace?: RevisedWorkspace,
): Promise<BacklogWeb> {
	const token = randomBytes(32).toString("hex");
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
	const authorized = (value: string) => {
		const supplied = Buffer.from(value);
		const expected = Buffer.from(token);
		return supplied.length === expected.length && timingSafeEqual(supplied, expected);
	};
	const snapshot = () => backlogSnapshot(backlog.store, backlog.repoName, Date.now(), backlog.session);
	const sendSnapshot = (socket: WebSocket) => {
		if (socket.bufferedAmount > 1048576) return socket.terminate();
		if (socket.readyState === WebSocket.OPEN)
			socket.send(JSON.stringify({ type: "snapshot", data: snapshot() } satisfies WorkspaceServerEvent));
	};
	const sendWorkspace = (socket: WebSocket) => {
		if (!workspace || socket.readyState !== WebSocket.OPEN) return;
		if (socket.bufferedAmount > 1048576) return socket.terminate();
		socket.send(JSON.stringify({ type: "workspace", data: workspace.snapshot() } satisfies WorkspaceServerEvent));
	};
	const broadcast = () => {
		for (const socket of authenticated) {
			try {
				sendSnapshot(socket);
			} catch {
				socket.terminate();
			}
		}
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
		const reply = (status: number, body: unknown) => {
			res.writeHead(status, {
				"content-type": "application/json",
				"cache-control": "no-store",
				"x-content-type-options": "nosniff",
			});
			res.end(JSON.stringify(body));
		};
		const handle = async () => {
			if (req.headers.host !== origin.slice(7) || (req.headers.origin !== undefined && req.headers.origin !== origin))
				return reply(403, { error: "This board accepts requests only from its own local address." });
			if (req.method === "GET" && req.url === "/") {
				res.writeHead(200, {
					"content-type": "text/html; charset=utf-8",
					"cache-control": "no-store",
					"referrer-policy": "no-referrer",
					"x-frame-options": "DENY",
					"content-security-policy": "frame-ancestors 'none'",
				});
				res.end(
					renderBacklogHtml(
						{ repo: backlog.repoName, generatedAt: Date.now(), states: STATES, idleMs: 604800000, items: [] },
						true,
					),
				);
				return;
			}
			const supplied = Buffer.from((req.headers.authorization ?? "").replace(/^Bearer /, ""));
			const expected = Buffer.from(token);
			if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
				return reply(401, { error: "Reopen /backlog to connect to this board." });
			if (req.url === WORKSPACE_ROUTES.application && !workspace?.application)
				return reply(503, { error: "Application controls are unavailable in this session." });
			if (req.url === WORKSPACE_ROUTES.workspace && !workspace)
				return reply(503, { error: "Agent controls are unavailable in this session." });
			const requestUrl = new URL(req.url ?? "/", origin);
			if (await handleApplicationDataRequest(req, requestUrl, workspace?.application, backlog.session, reply)) return;
			if (requestUrl.pathname === WORKSPACE_ROUTES.audit && req.method === "GET") {
				const before = requestUrl.searchParams.get("before");
				if (before !== null && !/^[1-9][0-9]*$/.test(before)) return reply(400, { error: "Invalid audit cursor" });
				const events = backlog.store.audit(
					requestUrl.searchParams.get("backlogId") ?? undefined,
					100,
					before ? Number(before) : undefined,
				);
				return reply(200, { events, before: events.length === 100 ? events[0].id : undefined });
			}
			if (handleReportsRequest(req, requestUrl, backlog.repoRoot, reply)) return;
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
			if (!Value.Check(BacklogMutationSchema, input)) return reply(400, { error: "Invalid backlog fields" });
			const actor = { ...backlog.actor, kind: "human" as const };
			const { op, id, reason, ...fields } = input;
			// `reason` is the former name of `why`, still accepted from older clients.
			if (reason !== undefined) {
				if (fields.why !== undefined && fields.why !== reason)
					return reply(400, { error: "reason is the former name of why: give only why." });
				fields.why = reason;
			}
			if (op !== "add" && (!id || fields.version === undefined))
				return reply(400, { error: "An item and its current version are required." });
			const item =
				op === "add"
					? backlog.store.add(
							{
								...fields,
								title: fields.title ?? "",
								createdBy: USER_AUTHOR,
								sourceSession: backlog.session,
							},
							actor,
						)
					: op === "remove"
						? backlog.store.remove(id!, fields.version, actor)
						: op === "comment"
							? backlog.store.comment(id!, fields.note ?? "", { id: USER_AUTHOR, kind: "human" }, fields.version)
							: backlog.store.update(id!, fields, actor);
			notifyChanged();
			broadcast();
			reply(200, { item });
		};
		void handle().catch((error: unknown) =>
			reply(409, {
				error: error instanceof Error ? error.message : "Backlog change failed",
				...(error instanceof BacklogError && error.current ? { current: error.current } : {}),
			}),
		);
	});
	server.on("upgrade", (req, socket, head) => {
		if (
			req.url !== WORKSPACE_ROUTES.live ||
			req.headers.host !== origin.slice(7) ||
			req.headers.origin !== origin ||
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
				applicationStreams.get(client)?.close();
				applicationStreams.delete(client);
			});
			client.on("message", (data, binary) => {
				if (authenticated.has(client)) return client.close(1008, "Updates only");
				if (binary) return client.close(1008, "Reopen /backlog");
				// The default binaryType ("nodebuffer") delivers each message as one Buffer.
				let supplied = (data as Buffer).toString();
				let cursor: ApplicationCursor | undefined;
				if (supplied.startsWith("{")) {
					let hello: { token?: unknown; protocolVersion?: unknown; cursor?: unknown };
					try {
						hello = JSON.parse(supplied);
					} catch {
						return client.close(1008, "Invalid handshake");
					}
					if (!hello || hello.protocolVersion !== APPLICATION_PROTOCOL_VERSION || typeof hello.token !== "string")
						return client.close(1008, "Unsupported protocol; reopen workspace");
					supplied = hello.token;
					if (hello.cursor !== undefined) {
						const value = hello.cursor as ApplicationCursor;
						if (
							!value ||
							typeof value.sessionId !== "string" ||
							typeof value.epoch !== "string" ||
							!Number.isSafeInteger(value.sequence) ||
							value.sequence < 0
						)
							return client.close(1008, "Invalid cursor");
						cursor = value;
					}
				}
				if (!authorized(supplied)) return client.close(1008, "Reopen /backlog");
				clearTimeout(timeout);
				authenticated.add(client);
				try {
					sendSnapshot(client);
					sendWorkspace(client);
					void streamApplication(client, cursor).catch(() => client.terminate());
				} catch {
					client.terminate();
				}
			});
		});
	});
	// Other agent processes share SQLite; watch its revision without polling from each browser.
	let revision = backlog.store.revision;
	const updates = setInterval(() => {
		if (!authenticated.size) return;
		try {
			workspaceUpdates();
			const next = backlog.store.revision;
			if (next !== revision) {
				revision = next;
				broadcast();
			}
		} catch {
			for (const socket of authenticated) socket.terminate();
		}
	}, 500);
	updates.unref();
	server.requestTimeout = 10000;
	server.headersTimeout = 10000;
	await new Promise<void>((resolve, reject) => {
		const onError = (error: Error) => {
			clearInterval(updates);
			unsubscribe?.();
			workspace?.close();
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
				clearInterval(updates);
				unsubscribe?.();
				workspace?.close();
				for (const socket of sockets.clients) socket.terminate();
				sockets.close();
				server.close(() => resolve());
				server.closeAllConnections();
			}),
	};
}
