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
import { AcpBroker } from "../src/modes/acp/broker.ts";
import type { PromptDisposition } from "../src/core/agent-session.ts";
import type { JsonAgentSessionEvent } from "../src/modes/json-event.ts";
import type { RpcClient } from "../src/modes/rpc/rpc-client.ts";
import type { RpcExtensionUIRequest, RpcExtensionUIResponse, RpcSessionState } from "../src/modes/rpc/rpc-types.ts";

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
type Worker = Pick<
	RpcClient,
	| "start"
	| "stop"
	| "getState"
	| "switchSession"
	| "persistSession"
	| "prompt"
	| "abort"
	| "onEvent"
	| "onClose"
	| "onExtensionUIRequest"
	| "respondToExtensionUIRequest"
>;
export class FakeWorker implements Worker {
	private events = new Set<(event: JsonAgentSessionEvent) => void>();
	private closes = new Set<(error: Error) => void>();
	private requests = new Set<(request: RpcExtensionUIRequest) => void>();
	private sessionId = randomUUID();
	start = vi.fn(async () => {});
	stop = vi.fn(async () => {
		this.fail(new Error("Worker stopped"));
	});
	getState = vi.fn(async (): Promise<RpcSessionState> => ({
		sessionId: this.sessionId,
		sessionFile: "/tmp/acp-fixture-session.jsonl",
		thinkingLevel: "off",
		isStreaming: false,
		isCompacting: false,
		steeringMode: "all",
		followUpMode: "all",
		autoCompactionEnabled: false,
		messageCount: 0,
		pendingMessageCount: 0,
	}));
	switchSession = vi.fn(async (_path: string) => ({ cancelled: false }));
	persistSession = vi.fn(async () => {});
	prompt = vi.fn(async (_message: string, _images?: ImageContent[]): Promise<PromptDisposition> => "started");
	abort = vi.fn(async () => {
		this.emit({ type: "agent_settled", aborted: true });
	});
	respondToExtensionUIRequest = vi.fn(async (_response: RpcExtensionUIResponse) => {});
	onEvent(listener: (event: JsonAgentSessionEvent) => void) {
		this.events.add(listener);
		return () => this.events.delete(listener);
	}
	onClose(listener: (error: Error) => void) {
		this.closes.add(listener);
		return () => this.closes.delete(listener);
	}
	onExtensionUIRequest(listener: (request: RpcExtensionUIRequest) => void) {
		this.requests.add(listener);
		return () => this.requests.delete(listener);
	}
	emit(event: JsonAgentSessionEvent) {
		for (const listener of Array.from(this.events)) listener(event);
	}
	fail(error = new Error("Worker crashed")) {
		for (const listener of Array.from(this.closes)) listener(error);
	}
	ask(request: RpcExtensionUIRequest) {
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
		createWorker?: (cwd: string, servers: McpServer[]) => Promise<Worker>;
		permission?: (request: RequestPermissionRequest) => Promise<RequestPermissionResponse>;
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
