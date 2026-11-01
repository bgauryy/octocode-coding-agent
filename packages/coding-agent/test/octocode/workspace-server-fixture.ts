import { EventEmitter } from "node:events";
import fs from "node:fs";
import http from "node:http";
import { Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import type { ApplicationFrame } from "@octocodeai/octocode-contracts";
import { vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import type { AgentSession, AgentSessionEvent } from "../../src/core/agent-session.ts";
import { ApplicationService } from "../../src/core/application/index.ts";
import { openAgentDb } from "../../src/octocode/agentdb/db.ts";
import { BacklogStore } from "../../src/octocode/backlog/store.ts";
import { WorkspaceRuntime } from "../../src/octocode/workspace/runtime.ts";
import { startWorkspaceWeb } from "../../src/octocode/workspace/server.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";

interface Packet {
	type: string;
	data: unknown;
}

/** Only transport I/O is replaced: request routing, authorization, stores and the application stream stay real. */
export class MemorySocket extends EventEmitter {
	readyState: number = WebSocket.OPEN;
	bufferedAmount = 0;
	packets: Packet[] = [];
	closed: { code: number; reason: string } | undefined;
	send(text: string) {
		this.packets.push(JSON.parse(text) as Packet);
	}
	close(code = 1000, reason = "") {
		if (this.readyState === WebSocket.CLOSED) return;
		this.closed = { code, reason };
		this.readyState = WebSocket.CLOSED;
		this.emit("close", code, Buffer.from(reason));
	}
	terminate() {
		this.close(1006, "Terminated");
	}
	hello(payload: unknown, binary = false) {
		this.emit("message", Buffer.from(typeof payload === "string" ? payload : JSON.stringify(payload)), binary);
	}
	frames(): ApplicationFrame[] {
		return this.packets.flatMap((packet) => (packet.type === "application" ? [packet.data as ApplicationFrame] : []));
	}
}

export async function workspaceServerFixture() {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-handler-"));
	const db = openAgentDb(path.join(directory, "db"));
	const store = new BacklogStore(() => db, "repo");
	const fake = fakeHost();
	const ctx = fakeCtx({ cwd: directory });
	const listeners = new Set<(event: AgentSessionEvent) => void>();
	const session = {
		sessionId: ctx.sessionManager.getSessionId(),
		isStreaming: false,
		messages: [],
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		sendUserMessage: vi.fn(async (_text: string, _options: unknown) => {}),
		prompt: vi.fn(async (_text: string, _options: unknown) => {}),
		steer: vi.fn(async () => {}),
		followUp: vi.fn(async () => {}),
		abort: vi.fn(async () => {}),
	};
	const application = new ApplicationService(session as unknown as AgentSession);
	const runtime = new WorkspaceRuntime(fake.api, {
		application: () => application,
		database: () => db,
		members: () => [],
		traffic: () => [],
		tell: async () => ({}),
		stop: () => undefined,
		expiry: () => "fixed",
	});
	const backlog = {
		store,
		actor: { id: session.sessionId },
		session: session.sessionId,
		repoName: "repo",
		repoRoot: directory,
	};
	const workspace = runtime.bind(ctx, backlog);
	const changed = vi.fn();
	let server!: http.Server;
	let upgrading: MemorySocket | undefined;
	vi.spyOn(http.Server.prototype, "listen").mockImplementation(function (this: http.Server, ...args: unknown[]) {
		// oxlint-disable-next-line typescript/no-this-alias -- capture the real server so tests dispatch through its registered handlers.
		server = this;
		const callback = args.at(-1);
		if (typeof callback === "function") queueMicrotask(() => callback());
		return this;
	});
	vi.spyOn(http.Server.prototype, "address").mockReturnValue({ address: "127.0.0.1", family: "IPv4", port: 49151 });
	vi.spyOn(WebSocketServer.prototype, "handleUpgrade").mockImplementation(function (
		this: WebSocketServer,
		request,
		_socket,
		_head,
		callback,
	) {
		const client = new MemorySocket();
		upgrading = client;
		const transport = client as unknown as WebSocket;
		this.clients.add(transport);
		client.once("close", () => this.clients.delete(transport));
		callback(transport, request);
	});
	const web = await startWorkspaceWeb(backlog, changed, workspace);
	const url = new URL(web.url);
	const token = url.hash.slice(8);
	return {
		db,
		store,
		session,
		application,
		workspace,
		changed,
		url,
		token,
		emit: (event: AgentSessionEvent) => listeners.forEach((listener) => listener(event)),
		request: (
			route: string,
			body?: unknown,
			options: { method?: string; headers?: http.IncomingHttpHeaders; raw?: string } = {},
		) =>
			new Promise<{ status: number; body: Record<string, unknown>; text: string }>((resolve) => {
				const request = new http.IncomingMessage(new Socket());
				request.method = options.method ?? (body === undefined && options.raw === undefined ? "GET" : "POST");
				request.url = route;
				request.headers = {
					host: url.host,
					origin: url.origin,
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
					...options.headers,
				};
				const input = options.raw ?? (body === undefined ? "" : JSON.stringify(body));
				request.push(Buffer.from(input));
				request.push(null);
				const response = new http.ServerResponse(request);
				vi.spyOn(response, "end").mockImplementation(function (this: http.ServerResponse, value: unknown) {
					const text = String(value ?? "");
					resolve({ status: this.statusCode, body: text.startsWith("{") ? JSON.parse(text) : {}, text });
					return this;
				});
				server.emit("request", request, response);
			}),
		upgrade: (
			headers: http.IncomingHttpHeaders = {},
			route = "/api/backlogs/live",
		): { client: MemorySocket | undefined; raw: { end: ReturnType<typeof vi.fn>; on: ReturnType<typeof vi.fn> } } => {
			upgrading = undefined;
			// The server listens for the raw socket's errors before it decides; the stub accepts the listener.
			const raw = { end: vi.fn(), on: vi.fn() };
			server.emit(
				"upgrade",
				{ url: route, headers: { host: url.host, origin: url.origin, ...headers } },
				raw,
				Buffer.alloc(0),
			);
			return { client: upgrading, raw };
		},
		close: async () => {
			await web.close();
			application.dispose();
			db.close();
			fs.rmSync(directory, { recursive: true, force: true });
		},
	};
}
