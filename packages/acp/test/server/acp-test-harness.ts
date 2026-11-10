import {
	client,
	methods,
	PROTOCOL_VERSION,
	type AnyMessage,
	type McpServer,
	type RequestPermissionRequest,
	type RequestPermissionResponse,
	type SessionNotification,
} from "@agentclientprotocol/sdk";
import { randomUUID } from "node:crypto";
import type { AssistantMessage, ImageContent } from "@octocodeai/octocode-ai";
import { afterEach, vi } from "vitest";
import { AcpBroker, type AcpWorker } from "../../src/server/broker.ts";
import type { AcpServerHost, AcpUiRequest, AcpUiResponse, AcpWorkerEvent, AcpWorkerState } from "../../src/host.ts";
import { acpServerHost } from "../../../coding-agent/src/main/acp-host.ts";

export const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
export function assistant(text: string, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "fixture",
		model: "fixture",
		usage,
		stopReason,
		timestamp: 1,
	};
}
export function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
type Worker = AcpWorker;
export class FakeWorker implements Worker {
	private identities = new Set<(id: string) => void>();
	private events = new Set<(event: AcpWorkerEvent) => void>();
	private closes = new Set<(error: Error) => void>();
	private requests = new Set<(request: AcpUiRequest) => void>();
	private sessionId = randomUUID();
	start = vi.fn(async () => {});
	stop = vi.fn(async () => {
		this.fail(new Error("Worker stopped"));
	});
	getCommands = vi.fn(async (): Promise<Array<{ name: string; description?: string; argumentHint?: string }>> => []);
	getState = vi.fn(async (): Promise<AcpWorkerState> => ({
		sessionId: this.sessionId,
		sessionFile: "/tmp/acp-fixture-session.jsonl",
	}));
	model = "fixture/one";
	getModels = vi.fn(async () => ({ current: this.model, available: ["fixture/one", "fixture/two"] }));
	setModel = vi.fn(async (model: string) => {
		this.model = model;
	});
	persistSession = vi.fn(async () => {});
	prompt = vi.fn(async (_message: string, _images?: ImageContent[]): Promise<string> => "started");
	abort = vi.fn(async () => {
		this.emit({ type: "agent_settled", aborted: true });
	});
	respondToExtensionUIRequest = vi.fn(async (_response: AcpUiResponse) => {});
	onSessionIdentity(listener: (id: string) => void) {
		this.identities.add(listener);
		return () => this.identities.delete(listener);
	}
	identify(id: string) {
		for (const listener of this.identities) listener(id);
	}
	onEvent(listener: (event: AcpWorkerEvent) => void) {
		this.events.add(listener);
		return () => this.events.delete(listener);
	}
	onClose(listener: (error: Error) => void) {
		this.closes.add(listener);
		return () => this.closes.delete(listener);
	}
	onExtensionUIRequest(listener: (request: AcpUiRequest) => void) {
		this.requests.add(listener);
		return () => this.requests.delete(listener);
	}
	emit(event: AcpWorkerEvent) {
		for (const listener of Array.from(this.events)) listener(event);
	}
	fail(error = new Error("Worker crashed")) {
		for (const listener of Array.from(this.closes)) listener(error);
	}
	ask(request: AcpUiRequest) {
		for (const listener of Array.from(this.requests)) listener(request);
	}
	finish(text = "done") {
		this.emit({ type: "message_end", message: assistant(text) });
		this.emit({ type: "agent_settled", aborted: false });
	}
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const close of cleanups.splice(0)) await close();
});

export function harness(
	options: {
		maxSessions?: number;
		cancelTimeoutMs?: number;
		createWorker?: (cwd: string, servers: McpServer[], sessionPath?: string) => Promise<Worker>;
		permission?: (request: RequestPermissionRequest) => Promise<RequestPermissionResponse>;
		/** The user's folder-trust decision; defaults to trusted, since the suite's folder is not in the isolated trust records. */
		folderTrust?: AcpServerHost["folderTrust"];
	} = {},
) {
	const workers: FakeWorker[] = [];
	const createWorker = vi.fn(
		options.createWorker ??
			(async (_cwd: string, _servers: McpServer[]) => {
				const worker = new FakeWorker();
				workers.push(worker);
				return worker;
			}),
	);
	const updates: SessionNotification[] = [];
	const requests: RequestPermissionRequest[] = [];
	let input!: TransformStreamDefaultController<AnyMessage>;
	const toAgent = new TransformStream<AnyMessage, AnyMessage>({
		start(controller) {
			input = controller;
		},
	});
	const toClient = new TransformStream<AnyMessage, AnyMessage>();
	const broker = new AcpBroker({
		host: { ...acpServerHost, folderTrust: options.folderTrust ?? (() => ({ trusted: true })) },
		createWorker,
		maxSessions: options.maxSessions,
		cancelTimeoutMs: options.cancelTimeoutMs,
	});
	const server = broker.connect({ readable: toAgent.readable, writable: toClient.writable });
	const connection = client({ name: "octocode-acp-tests" })
		.onNotification(methods.client.session.update, ({ params }) => {
			updates.push(params);
		})
		.onRequest(methods.client.session.requestPermission, async ({ params }) => {
			requests.push(params);
			return options.permission?.(params) ?? { outcome: { outcome: "cancelled" } };
		})
		.connect({ readable: toClient.readable, writable: toAgent.writable });
	cleanups.push(async () => {
		await broker.close();
		connection.close();
		server.close();
	});
	return {
		broker,
		connection,
		server,
		workers,
		updates,
		requests,
		createWorker,
		disconnect: () => {
			input.terminate();
			connection.close();
		},
		initialize: (version = PROTOCOL_VERSION) =>
			connection.agent.request(methods.agent.initialize, { protocolVersion: version, clientCapabilities: {} }),
		newSession: (cwd = process.cwd(), mcpServers: McpServer[] = []) =>
			connection.agent.request(methods.agent.session.new, { cwd, mcpServers }),
		prompt: (sessionId: string, text = "hello") =>
			connection.agent.request(methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text }] }),
		cancel: (sessionId: string) => connection.agent.notify(methods.agent.session.cancel, { sessionId }),
	};
}
