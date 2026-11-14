import { randomUUID } from "node:crypto";
import {
	methods,
	RequestError,
	type AgentContext,
	type ContentBlock,
	type PromptResponse,
	type SessionNotification,
	type SessionConfigOption,
} from "@agentclientprotocol/sdk";
import type { AcpUiRequest, AcpWorkerClient, AcpWorkerEvent } from "../host.ts";
import { askClient } from "./ask.ts";
import { modelConfigOptions } from "./config-options.ts";
import { advertiseCommands } from "./commands.ts";
import { AcpEventProjector, type CompactionText } from "./events.ts";
import { convertPrompt } from "./input.ts";
import { closeInBackground, reportFailure } from "./failure.ts";
import { askPermission } from "./permission.ts";
import { AcpStartup } from "./startup.ts";

export type AcpWorker = AcpWorkerClient & { onSessionIdentity: (listener: (id: string) => void) => () => void };

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

function createTurn(summaryText: CompactionText): Turn {
	const completion = Promise.withResolvers<PromptResponse>();
	void completion.promise.catch(() => {});
	return {
		...completion,
		id: randomUUID(),
		done: completion.promise,
		controller: new AbortController(),
		projector: new AcpEventProjector(summaryText),
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
	private changingModel = false;
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
	private readonly summaryText: CompactionText;
	/** The client advertised `elicitation.form`, so non-approval questions can be asked (`ask.ts`). */
	private readonly elicitationForm: boolean;

	constructor(
		id: string,
		worker: AcpWorker,
		client: AgentContext,
		cancelTimeoutMs: number,
		summaryText: CompactionText,
		onTerminated: () => void = () => {},
		elicitationForm = false,
	) {
		this.id = id;
		this.elicitationForm = elicitationForm;
		this.summaryText = summaryText;
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
				closeInBackground(this);
			}),
		);
		this.unsubscribes.push(
			worker.onExtensionUIRequest((request) => {
				void this.ui(request).catch(() => {
					closeInBackground(this);
					this.fail("Permission response could not reach the agent.");
				});
			}),
		);
	}

	async start(expectedId?: string, prepare: (id: string) => Promise<void> = async () => {}): Promise<string> {
		this.starting = true;
		const startup = new AcpStartup(expectedId, async (id) => {
			this.id = id;
			await prepare(id);
		});
		this.startup = startup;
		this.output = startup.output;
		void this.output.catch(() => closeInBackground(this));
		this.unsubscribes.push(this.worker.onSessionIdentity((id) => startup.identify(id)));
		await this.worker.start();
		await this.worker.persistSession();
		const state = await this.worker.getState();
		if (!state.sessionId || !state.sessionFile)
			throw RequestError.invalidRequest(undefined, "ACP requires persistent native sessions.");
		await startup.validate(state.sessionId);
		if (this.dead) throw RequestError.internalError(undefined, "Agent process closed during startup.");
		this.starting = false;
		// A round trip to the worker, so it follows the response that names this session.
		void advertiseCommands(this.worker, (update) => this.enqueue(update));
		return this.id;
	}

	isClosed(): boolean {
		return this.dead || this.closing !== undefined;
	}

	isBusy(): boolean {
		return this.changingModel || this.starting || Boolean(this.active ?? this.observed) || this.workerBusy;
	}

	/** The config options a client can change (the model); empty when the worker cannot list its models, which is reported. */
	async configOptions(): Promise<SessionConfigOption[]> {
		try {
			return modelConfigOptions(await this.worker.getModels());
		} catch (error) {
			reportFailure("ACP could not list the session's models")(error);
			return [];
		}
	}

	/** Switches the worker's model between turns; a value the worker does not offer is an invalid parameter. */
	async setModel(value: string): Promise<SessionConfigOption[]> {
		if (this.isClosed() || this.releasing) throw RequestError.invalidRequest(undefined, "Session is closed.");
		if (this.isBusy()) throw RequestError.invalidRequest(undefined, "Session is busy; the model was not changed.");
		const models = await this.worker.getModels();
		// A prompt or shutdown can begin while the worker lists its models.
		if (this.isClosed() || this.releasing) throw RequestError.invalidRequest(undefined, "Session is closed.");
		if (this.isBusy()) throw RequestError.invalidRequest(undefined, "Session is busy; the model was not changed.");
		if (!models.available.includes(value)) throw RequestError.invalidParams(undefined, `Unknown model "${value}".`);
		this.changingModel = true;
		try {
			await this.worker.setModel(value);
		} catch (error) {
			throw RequestError.internalError(undefined, error instanceof Error ? error.message : String(error));
		} finally {
			this.changingModel = false;
		}
		return modelConfigOptions({ ...models, current: value });
	}

	prompt(content: ContentBlock[]): Promise<PromptResponse> {
		if (this.dead || this.closing || this.releasing) throw RequestError.invalidRequest(undefined, "Session is closed.");
		if (this.active) throw RequestError.invalidRequest(undefined, "Session already has an active prompt.");
		if (this.isBusy()) throw RequestError.invalidRequest(undefined, "Session is busy; nothing was sent.");
		const input = convertPrompt(content);
		const turn = createTurn(this.summaryText);
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
						return this.reject(
							turn,
							// A client can route missing credentials to sign-in; any other refusal it can only report.
							"authRequired" in error && error.authRequired === true
								? RequestError.authRequired(undefined, error.message)
								: RequestError.internalError(undefined, error.message),
						);
					// Anything else (lost response, timeout) leaves execution uncertain: stop the worker without a replay.
					closeInBackground(this);
					this.fail("Agent rejected or failed the prompt; it was not replayed.");
				}
			},
		);
		return turn.done;
	}

	/** Fails one turn after its queued updates flush; the session and worker stay usable. */
	private reject(turn: Turn, failure: RequestError): void {
		if (turn.ending) return;
		turn.ending = true;
		turn.controller.abort();
		const finish = () => {
			if (this.active === turn) this.active = undefined;
			if (this.observed === turn) this.observed = undefined;
			turn.reject(failure);
		};
		void this.output.then(finish, finish);
	}

	private event(event: AcpWorkerEvent): void {
		if (event.type === "session_dispatch") {
			this.workerBusy = event.active;
			if (event.active)
				this.observed = this.active?.id === event.dispatchId ? this.active : createTurn(this.summaryText);
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
			closeInBackground(this);
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
			closeInBackground(this);
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
		} catch (error) {
			reportFailure("ACP cancellation did not complete; closing the session")(error);
			if (this.hasTurn(turn)) await this.close();
		} finally {
			clearTimeout(timer);
		}
	}

	private async ui(request: AcpUiRequest): Promise<void> {
		// The host forwards only dialogs; a UI notification (status, widget, title) has no one to answer it.
		if (!["select", "confirm", "input", "editor", "ask"].includes(request.method)) return;
		const turn = this.observed ?? this.active;
		if (request.method === "ask") {
			// No turn to answer for: every question is aborted (a closed signal).
			const signal = turn?.controller.signal ?? AbortSignal.abort();
			const onCancelled = () => void this.cancel().catch(reportFailure("ACP permission cancellation failed"));
			const env = {
				client: this.client,
				sessionId: this.id,
				signal,
				elicitationForm: this.elicitationForm,
				onCancelled,
			};
			const replies = await askClient(env, request.questions);
			if (!this.dead)
				await this.worker.respondToExtensionUIRequest({ type: "extension_ui_response", id: request.id, replies });
			return;
		}
		const value =
			request.method === "select"
				? await askPermission(
						{
							client: this.client,
							sessionId: this.id,
							signal: turn?.controller.signal,
							output: this.output,
							current: () => turn !== undefined && this.hasTurn(turn),
							// Send abort before releasing the worker's dialog; awaiting completion here would deadlock it.
							onCancelled: () => void this.cancel().catch(reportFailure("ACP permission cancellation failed")),
						},
						request,
					)
				: undefined;
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
