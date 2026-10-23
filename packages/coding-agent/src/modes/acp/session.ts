import { randomUUID } from "node:crypto";
import {
	methods,
	RequestError,
	type AgentContext,
	type ContentBlock,
	type PromptResponse,
	type SessionNotification,
} from "@agentclientprotocol/sdk";
import type { RpcClient } from "../rpc/rpc-client.ts";
import type { RpcExtensionUIRequest } from "../rpc/rpc-types.ts";
import type { JsonAgentSessionEvent } from "../json-event.ts";
import { AcpEventProjector } from "./events.ts";
import { convertPrompt } from "./input.ts";

export type AcpWorker = Pick<
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

interface Turn {
	controller: AbortController;
	projector: AcpEventProjector;
	accepted: boolean;
	settled: boolean;
	cancelled: boolean;
	ending: boolean;
	done: Promise<PromptResponse>;
	resolve: (value: PromptResponse) => void;
	reject: (error: Error) => void;
}

/** One protocol session and exactly one independently owned native process. */
export class AcpSession {
	private active?: Turn;
	private dead = false;
	private releasing = false;
	private closing?: Promise<void>;
	private readonly unsubscribes: Array<() => void> = [];
	private output: Promise<void> = Promise.resolve();
	private queuedChars = 0;

	id: string;
	private readonly worker: AcpWorker;
	private readonly client: AgentContext;
	private readonly cancelTimeoutMs: number;
	private readonly onTerminated: () => void;

	constructor(
		id: string,
		worker: AcpWorker,
		client: AgentContext,
		cancelTimeoutMs: number,
		onTerminated: () => void = () => {},
	) {
		this.id = id;
		this.worker = worker;
		this.client = client;
		this.cancelTimeoutMs = cancelTimeoutMs;
		this.onTerminated = onTerminated;
		this.unsubscribes.push(worker.onEvent((event) => this.event(event)));
		this.unsubscribes.push(
			worker.onClose(() => {
				this.dead = true;
				this.onTerminated();
				if (this.closing) return;
				this.fail("Agent process closed; execution may have occurred. The prompt was not replayed.");
				void this.close().catch((error) => console.error("ACP session cleanup failed", error));
			}),
		);
		this.unsubscribes.push(
			worker.onExtensionUIRequest((request) => {
				void this.ui(request).catch(() => {
					void this.close().catch((error) => console.error("ACP session cleanup failed", error));
					this.fail("Permission response could not reach the agent.");
				});
			}),
		);
	}

	async start(expectedId?: string, path?: string): Promise<string> {
		await this.worker.start();
		if (path) {
			const switched = await this.worker.switchSession(path);
			if (switched.cancelled) throw RequestError.invalidRequest(undefined, "Session load was cancelled.");
		} else await this.worker.persistSession();
		const state = await this.worker.getState();
		if (expectedId && state.sessionId !== expectedId)
			throw RequestError.invalidRequest(undefined, "Loaded transcript identity changed.");
		if (!state.sessionId || (!state.sessionFile && !path))
			throw RequestError.invalidRequest(undefined, "ACP requires persistent native sessions.");
		if (this.dead) throw RequestError.internalError(undefined, "Agent process closed during startup.");
		return state.sessionId;
	}

	isClosed(): boolean {
		return this.dead || this.closing !== undefined;
	}

	prompt(content: ContentBlock[]): Promise<PromptResponse> {
		if (this.dead || this.closing || this.releasing) throw RequestError.invalidRequest(undefined, "Session is closed.");
		if (this.active) throw RequestError.invalidRequest(undefined, "Session already has an active prompt.");
		const input = convertPrompt(content);
		const completion = Promise.withResolvers<PromptResponse>();
		const turn: Turn = {
			...completion,
			done: completion.promise,
			controller: new AbortController(),
			projector: new AcpEventProjector(),
			accepted: false,
			settled: false,
			cancelled: false,
			ending: false,
		};
		// An early worker failure may precede the SDK attaching its request handler.
		void turn.done.catch(() => {});
		this.active = turn;
		void this.worker.prompt(input.text, input.images).then(
			(disposition) => {
				if (this.active !== turn) return;
				turn.accepted = true;
				if (disposition === "handled") turn.settled = true;
				this.complete(turn);
			},
			() => {
				if (this.active === turn) {
					void this.close().catch((error) => console.error("ACP session cleanup failed", error));
					this.fail("Agent rejected or failed the prompt; it was not replayed.");
				}
			},
		);
		return turn.done;
	}

	private event(event: JsonAgentSessionEvent): void {
		const turn = this.active;
		if (!turn || turn.ending) return;
		for (const update of turn.projector.update(event)) this.enqueue(update);
		if (event.type === "agent_settled") {
			turn.settled = true;
			turn.cancelled ||= event.aborted;
			this.complete(turn);
		}
	}

	private enqueue(update: SessionNotification["update"]): void {
		const size = JSON.stringify(update).length;
		if (this.queuedChars + size > 2 * 1024 * 1024) {
			this.fail("Client output backlog exceeded its limit; the agent was stopped.");
			void this.close().catch((error) => console.error("ACP session cleanup failed", error));
			return;
		}
		this.queuedChars += size;
		this.output = this.output
			.then(() => this.client.notify(methods.client.session.update, { sessionId: this.id, update }))
			.finally(() => {
				this.queuedChars -= size;
			});
		void this.output.catch(() => {
			this.fail("Client output connection failed.");
			void this.close().catch((error) => console.error("ACP session cleanup failed", error));
		});
	}

	private complete(turn: Turn): void {
		if (this.active !== turn || turn.ending || !turn.accepted || !turn.settled) return;
		turn.ending = true;
		turn.controller.abort();
		void this.output.then(
			() => {
				if (this.active !== turn) return;
				this.active = undefined;
				if (turn.projector.error && !turn.cancelled)
					turn.reject(RequestError.internalError(undefined, turn.projector.error));
				else turn.resolve({ stopReason: turn.cancelled ? "cancelled" : turn.projector.stopReason });
			},
			() => this.fail("Client output connection failed."),
		);
	}

	private fail(message: string): void {
		const turn = this.active;
		if (!turn) return;
		turn.controller.abort();
		this.active = undefined;
		if (turn.cancelled) turn.resolve({ stopReason: "cancelled" });
		else turn.reject(RequestError.internalError(undefined, message));
	}

	async cancel(): Promise<void> {
		const turn = this.active;
		if (!turn) return;
		turn.cancelled = true;
		turn.controller.abort();
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				this.worker.abort().then(() => turn.done),
				turn.done,
				new Promise<never>((_resolve, reject) => {
					timer = setTimeout(() => reject(new Error("Cancellation deadline")), this.cancelTimeoutMs);
				}),
			]);
		} catch {
			if (this.active === turn) await this.close();
		} finally {
			clearTimeout(timer);
		}
	}

	private async ui(request: RpcExtensionUIRequest): Promise<void> {
		if (!["select", "confirm", "input", "editor"].includes(request.method)) return;
		const turn = this.active;
		const permission = request.method === "select" ? request.permission : undefined;
		let value: string | undefined;
		if (
			turn &&
			!turn.controller.signal.aborted &&
			permission &&
			request.method === "select" &&
			permission.allowOnce !== permission.rejectOnce &&
			request.options.includes(permission.allowOnce) &&
			request.options.includes(permission.rejectOnce)
		) {
			try {
				await this.output;
				turn.controller.signal.throwIfAborted();
				const response = await withAbort(
					turn.controller.signal,
					this.client.request(
						methods.client.session.requestPermission,
						{
							sessionId: this.id,
							toolCall: {
								toolCallId: permission.toolCallId ?? randomUUID(),
								title: request.title,
								status: "pending",
								kind: "other",
								name: permission.toolName,
								content: [{ type: "content", content: { type: "text", text: permission.targets.join("\n") } }],
							},
							options: [
								{ optionId: "allow-once", name: permission.allowOnce, kind: "allow_once" },
								{ optionId: "reject-once", name: permission.rejectOnce, kind: "reject_once" },
							],
						},
						{ cancellationSignal: turn.controller.signal },
					),
				);
				if (this.active === turn && !turn.controller.signal.aborted && response.outcome.outcome === "selected") {
					if (response.outcome.optionId === "allow-once") value = permission.allowOnce;
					else if (response.outcome.optionId === "reject-once") value = permission.rejectOnce;
				}
			} catch {
				/* Cancellation, invalid options and client failures never grant permission. */
			}
		}
		if (!this.dead)
			await this.worker.respondToExtensionUIRequest({
				type: "extension_ui_response",
				id: request.id,
				...(value === undefined ? { cancelled: true } : { value }),
			});
	}

	/** Protocol session/close cancels the current turn before releasing its worker. */
	async release(): Promise<void> {
		this.releasing = true;
		try {
			await this.cancel();
		} finally {
			await this.close();
		}
	}

	close(): Promise<void> {
		return (this.closing ??= Promise.resolve().then(() => this.shutdown()));
	}
	private async shutdown(): Promise<void> {
		this.dead = true;
		this.active?.controller.abort();
		try {
			await this.worker.stop();
		} finally {
			this.fail("Session closed; execution may have occurred. The prompt was not replayed.");
			for (const unsubscribe of this.unsubscribes.splice(0)) unsubscribe();
		}
	}
}

async function withAbort<T>(signal: AbortSignal, pending: Promise<T>): Promise<T> {
	if (signal.aborted) {
		void pending.catch(() => {});
		throw new Error("Cancelled");
	}
	let onAbort: () => void = () => {};
	const cancelled = new Promise<never>((_resolve, reject) => {
		onAbort = () => reject(new Error("Cancelled"));
		signal.addEventListener("abort", onAbort, { once: true });
	});
	try {
		return await Promise.race([pending, cancelled]);
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}
