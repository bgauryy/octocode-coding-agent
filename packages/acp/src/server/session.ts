import { randomUUID } from "node:crypto";
import {
	methods,
	RequestError,
	type AgentContext,
	type ContentBlock,
	type PromptResponse,
	type SessionNotification,
} from "@agentclientprotocol/sdk";
import type { RpcClient, RpcEvent } from "../../../coding-agent/src/modes/rpc/rpc-client.ts";
import type { RpcExtensionUIRequest } from "../../../coding-agent/src/modes/rpc/rpc-types.ts";
import { AcpEventProjector } from "./events.ts";
import { convertPrompt } from "./input.ts";
import { AcpStartup } from "./startup.ts";

export type AcpWorker = Pick<
	RpcClient,
	| "start"
	| "stop"
	| "getState"
	| "persistSession"
	| "prompt"
	| "abort"
	| "onEvent"
	| "onClose"
	| "onExtensionUIRequest"
	| "respondToExtensionUIRequest"
> & { onSessionIdentity: (listener: (id: string) => void) => () => void };

interface Turn {
	id: string;
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

function createTurn(): Turn {
	const completion = Promise.withResolvers<PromptResponse>();
	void completion.promise.catch(() => {});
	return {
		...completion,
		id: randomUUID(),
		done: completion.promise,
		controller: new AbortController(),
		projector: new AcpEventProjector(),
		accepted: false,
		settled: false,
		cancelled: false,
		ending: false,
	};
}

/** One protocol session and exactly one independently owned native process. */
export class AcpSession {
	private active?: Turn;
	private observed?: Turn;
	private workerBusy = false;
	private dead = false;
	private releasing = false;
	private closing?: Promise<void>;
	private startup?: AcpStartup;
	private starting = false;
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

	async start(expectedId?: string, prepare: (id: string) => Promise<void> = async () => {}): Promise<string> {
		this.starting = true;
		const startup = (this.startup = new AcpStartup(expectedId, async (id) => {
			this.id = id;
			await prepare(id);
		}));
		this.output = startup.output;
		void this.output.catch(() => this.close());
		this.unsubscribes.push(this.worker.onSessionIdentity((id) => startup.identify(id)));
		await this.worker.start();
		await this.worker.persistSession();
		const state = await this.worker.getState();
		if (!state.sessionId || !state.sessionFile)
			throw RequestError.invalidRequest(undefined, "ACP requires persistent native sessions.");
		await startup.validate(state.sessionId);
		if (this.dead) throw RequestError.internalError(undefined, "Agent process closed during startup.");
		this.starting = false;
		return this.id;
	}

	isClosed(): boolean {
		return this.dead || this.closing !== undefined;
	}

	isBusy(): boolean {
		return this.starting || this.active !== undefined || this.observed !== undefined || this.workerBusy;
	}

	prompt(content: ContentBlock[]): Promise<PromptResponse> {
		if (this.dead || this.closing || this.releasing) throw RequestError.invalidRequest(undefined, "Session is closed.");
		if (this.active) throw RequestError.invalidRequest(undefined, "Session already has an active prompt.");
		if (this.starting || this.observed || this.workerBusy)
			throw RequestError.invalidRequest(undefined, "Session is busy; nothing was sent.");
		const input = convertPrompt(content);
		const turn = createTurn();
		this.active = turn;
		void this.worker.prompt(input.text, input.images, undefined, { waitForCompletion: true, dispatchId: turn.id }).then(
			(disposition) => {
				if (this.active !== turn) return;
				turn.accepted = true;
				if (disposition === "handled") turn.settled = true;
				this.complete(turn);
			},
			(error: unknown) => {
				if (this.active === turn) {
					if (turn.cancelled) {
						turn.accepted = true;
						turn.settled = true;
						this.complete(turn);
						return;
					}
					if (error && typeof error === "object" && "execution" in error && error.execution === "not-sent") {
						this.active = undefined;
						turn.controller.abort();
						turn.reject(RequestError.invalidRequest(undefined, "Session is busy; nothing was sent."));
						return;
					}
					// RpcClient sets `execution` (possibly undefined) only on a `success: false` response, so a live worker
					// refused this prompt (e.g. an interactive-only command): fail that prompt, keep the session.
					if (!this.isClosed() && error instanceof Error && "execution" in error)
						return this.reject(turn, error.message);
					// Anything else (lost response, timeout) leaves execution uncertain: stop the worker without a replay.
					void this.close().catch((error) => console.error("ACP session cleanup failed", error));
					this.fail("Agent rejected or failed the prompt; it was not replayed.");
				}
			},
		);
		return turn.done;
	}

	/** Fails one turn after its queued updates flush; the session and worker stay usable. */
	private reject(turn: Turn, message: string): void {
		if (turn.ending) return;
		turn.ending = true;
		turn.controller.abort();
		const finish = () => {
			if (this.active === turn) this.active = undefined;
			if (this.observed === turn) this.observed = undefined;
			turn.reject(RequestError.internalError(undefined, message));
		};
		void this.output.then(finish, finish);
	}

	private event(event: RpcEvent): void {
		if (event.type === "session_dispatch") {
			this.workerBusy = event.active;
			if (event.active) this.observed = this.active?.id === event.dispatchId ? this.active : createTurn();
			else if (this.observed) {
				if (this.observed !== this.active) this.observed.accepted = true;
				this.observed.settled = true;
				this.complete(this.observed);
			}
			return;
		}
		const turn = this.observed ?? this.active;
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
		if (!this.hasTurn(turn) || turn.ending || !turn.accepted || !turn.settled) return;
		turn.ending = true;
		turn.controller.abort();
		void this.output.then(
			() => {
				if (this.active === turn) this.active = undefined;
				if (this.observed === turn) this.observed = undefined;
				if (turn.projector.error && !turn.cancelled)
					turn.reject(RequestError.internalError(undefined, turn.projector.error));
				else turn.resolve({ stopReason: turn.cancelled ? "cancelled" : turn.projector.stopReason });
			},
			() => {
				if (turn.cancelled) turn.resolve({ stopReason: "cancelled" });
				else turn.reject(RequestError.internalError(undefined, "Client output connection failed."));
				this.fail("Client output connection failed.");
			},
		);
	}

	private fail(message: string): void {
		const turns = new Set([this.active, this.observed]);
		this.active = undefined;
		this.observed = undefined;
		for (const turn of turns) {
			if (!turn) continue;
			turn.controller.abort();
			if (turn.cancelled) turn.resolve({ stopReason: "cancelled" });
			else turn.reject(RequestError.internalError(undefined, message));
		}
	}
	private hasTurn(turn: Turn): boolean {
		return this.active === turn || this.observed === turn;
	}

	async cancel(): Promise<void> {
		const turn = this.observed ?? this.active;
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
			if (this.hasTurn(turn)) await this.close();
		} finally {
			clearTimeout(timer);
		}
	}

	private async ui(request: RpcExtensionUIRequest): Promise<void> {
		if (!["select", "confirm", "input", "editor"].includes(request.method)) return;
		const turn = this.observed ?? this.active;
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
				if (this.hasTurn(turn) && !turn.controller.signal.aborted) {
					if (response.outcome.outcome === "cancelled") {
						// Send abort before releasing the worker's dialog; awaiting completion here would deadlock it.
						void this.cancel().catch((error) => console.error("ACP permission cancellation failed", error));
					} else if (response.outcome.optionId === "allow-once") value = permission.allowOnce;
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
		this.startup?.close();
		this.active?.controller.abort();
		this.observed?.controller.abort();
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
