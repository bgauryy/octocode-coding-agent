import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { Readable, Writable } from "node:stream";
import {
	type ClientConnection,
	client,
	methods,
	ndJsonStream,
	PROTOCOL_VERSION,
	type RequestPermissionRequest,
	type RequestPermissionResponse,
	type SessionNotification,
} from "@agentclientprotocol/sdk";
import { adoptTree, KILL_GRACE_MS, prepareTree, stopTree } from "../../../coding-agent/src/octocode/shared/process.ts";
import { untilAborted } from "../../../coding-agent/src/octocode/shared/util.ts";
import type { ExternalBackend, ExternalReply } from "../../../coding-agent/src/octocode/external/protocol.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { AcpDiagnostics, AcpOutput } from "./output.ts";
import { type AcpModels, acpModels, modelRefusal } from "./session-config.ts";

interface AcpConnectInput {
	command: string;
	args?: string[];
	vendor: string;
	cwd: string;
	sessionId?: string;
	/** A value of the agent's model config option, set before the connection is returned. */
	model?: string;
	timeoutMs?: number;
}

export type AcpPermission = (
	request: RequestPermissionRequest,
	signal: AbortSignal,
) => Promise<RequestPermissionResponse>;

export class AcpError extends Error {
	readonly execution = "uncertain";
	readonly partial: ExternalReply;
	readonly stderr: string;
	constructor(message: string, partial: ExternalReply, stderr: string, cause: unknown) {
		super(`${message}; external execution may have occurred. The prompt was not replayed.`, { cause });
		this.partial = partial;
		this.stderr = stderr;

		this.name = "AcpError";
	}
}

/** A prompt refused before anything reached the agent: the model may retry once the cause is gone. */
class AcpRefusal extends Error {
	readonly execution = "not-sent";
	constructor(message: string) {
		super(message);
		this.name = "AcpRefusal";
	}
}

function timeoutSignal(timeoutMs: number): AbortSignal {
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2 ** 31 - 1)
		throw new Error("ACP timeoutMs must be a positive timer duration.");
	return AbortSignal.timeout(timeoutMs);
}

interface Turn {
	controller: AbortController;
	signal: AbortSignal;
	output: AcpOutput;
}

export class AcpBackend implements ExternalBackend {
	private connection?: ClientConnection;
	private readonly lifetime = new AbortController();
	private active?: Turn;
	private closing?: Promise<void>;
	private cancelling?: Promise<void>;
	private readonly stderr = new AcpDiagnostics();
	private readonly child: ChildProcessWithoutNullStreams;
	readonly cwd: string;
	private currentSessionId: string;
	private currentModels?: AcpModels;
	private readonly permission: AcpPermission;
	private constructor(
		child: ChildProcessWithoutNullStreams,
		cwd: string,
		currentSessionId: string,
		permission: AcpPermission,
	) {
		this.child = child;
		this.cwd = cwd;
		this.currentSessionId = currentSessionId;
		this.permission = permission;

		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (text: string) => {
			this.stderr.append(text);
		});
		child.once("error", (error) => {
			void this.shutdown(error);
		});
		child.once("exit", (code, signal) => {
			void this.shutdown(new Error(`ACP process exited (${signal ?? code}).`));
		});
		child.stdin.on("error", (error) => {
			void this.shutdown(error);
		});
		child.stdout.on("error", (error) => {
			void this.shutdown(error);
		});
	}

	get sessionId(): string {
		return this.currentSessionId;
	}

	get models(): AcpModels | undefined {
		return this.currentModels;
	}

	get isClosed(): boolean {
		return this.lifetime.signal.aborted;
	}

	get isBusy(): boolean {
		return this.active !== undefined && !this.isClosed;
	}

	static async connect(input: AcpConnectInput, permission: AcpPermission, signal?: AbortSignal): Promise<AcpBackend> {
		const startup = AbortSignal.any([timeoutSignal(input.timeoutMs ?? 60_000), ...(signal ? [signal] : [])]);
		startup.throwIfAborted();
		const cwd = realpathSync(input.cwd);
		if (!statSync(cwd).isDirectory()) throw new Error("ACP cwd must be a directory.");
		if (!input.command.trim() || !input.vendor.trim())
			throw new Error("ACP requires an executable and the real host vendor.");
		await untilAborted(prepareTree(), startup);
		startup.throwIfAborted();
		const child = spawn(input.command, input.args ?? [], {
			cwd,
			stdio: ["pipe", "pipe", "pipe"],
			detached: process.platform !== "win32",
			windowsHide: true,
		});
		adoptTree(child.pid);
		const backend = new AcpBackend(child, cwd, input.sessionId ?? "", permission);
		let phase = "initialize";
		try {
			const stream = ndJsonStream(
				Writable.toWeb(child.stdin),
				Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>,
			);
			const connection = client({ name: "octocode-external" })
				.onRequest(methods.client.session.requestPermission, (ctx) => backend.requestPermission(ctx.params, ctx.signal))
				.onNotification(methods.client.session.update, (ctx) => backend.update(ctx.params))
				.connect(stream);
			backend.connection = connection;
			connection.signal.addEventListener(
				"abort",
				() => {
					void backend.shutdown(new Error("ACP connection closed."));
				},
				{ once: true },
			);
			const initialization = await untilAborted(
				connection.agent.request(methods.agent.initialize, {
					protocolVersion: PROTOCOL_VERSION,
					clientCapabilities: {},
				}),
				AbortSignal.any([startup, backend.lifetime.signal]),
			);
			if (initialization.protocolVersion !== PROTOCOL_VERSION)
				throw new Error(`Unsupported ACP protocol version ${initialization.protocolVersion}.`);
			if (input.sessionId) {
				phase = "session/load";
				if (!initialization.agentCapabilities?.loadSession)
					throw new Error("ACP agent does not advertise session/load; existing session was not replaced.");
				const loaded = await untilAborted(
					connection.agent.request(methods.agent.session.load, {
						sessionId: input.sessionId,
						cwd,
						mcpServers: [],
					}),
					startup,
				);
				backend.currentModels = acpModels(loaded ?? {});
			} else {
				phase = "session/new";
				const session = await untilAborted(
					connection.agent.request(methods.agent.session.new, { cwd, mcpServers: [] }),
					startup,
				);
				if (!session.sessionId) throw new Error("ACP agent returned an empty session ID.");
				backend.currentSessionId = session.sessionId;
				backend.currentModels = acpModels(session);
			}
			if (input.model) {
				phase = "session/set_config_option";
				const refusal = modelRefusal(backend.currentModels, input.model);
				if (refusal) throw new Error(refusal);
				const selected = await untilAborted(
					connection.agent.request(methods.agent.session.setConfigOption, {
						sessionId: backend.currentSessionId,
						configId: backend.currentModels!.configId!,
						value: input.model,
					}),
					startup,
				);
				backend.currentModels = acpModels(selected) ?? { ...backend.currentModels!, current: input.model };
			}
			startup.throwIfAborted();
			backend.lifetime.signal.throwIfAborted();
			return backend;
		} catch (error) {
			await backend.shutdown(error);
			throw new Error(`ACP connection failed during ${phase}: ${errorMessage(error)}`, { cause: error });
		}
	}

	async prompt(
		text: string,
		options: { timeoutMs: number; signal?: AbortSignal; key?: string },
	): Promise<ExternalReply> {
		if (this.active) throw new AcpRefusal("ACP session already has an active prompt.");
		if (!this.connection || this.closing)
			throw new AcpRefusal("ACP connection is closed; connect explicitly before sending another prompt.");
		const controller = new AbortController();
		const requestSignal = AbortSignal.any([
			this.lifetime.signal,
			controller.signal,
			...(options.signal ? [options.signal] : []),
		]);
		const deadline = timeoutSignal(options.timeoutMs);
		const signal = AbortSignal.any([requestSignal, deadline]);
		if (signal.aborted) throw new AcpRefusal("ACP prompt aborted before it was sent.");
		const turn: Turn = { controller, signal, output: new AcpOutput() };
		this.active = turn;
		// A timed-out request can still emit session-scoped updates. Keep its slot until the peer
		// settles it so a new turn cannot receive those updates. Cancellation still closes the process.
		const cancelled = () => {
			void this.terminatePrompt(options.signal?.reason);
		};
		options.signal?.addEventListener("abort", cancelled, { once: true });
		const pending = this.connection.agent
			.request(
				methods.agent.session.prompt,
				{ sessionId: this.sessionId, prompt: [{ type: "text", text }] },
				{ cancellationSignal: requestSignal },
			)
			.finally(() => {
				options.signal?.removeEventListener("abort", cancelled);
				if (this.active === turn) this.active = undefined;
			});
		try {
			const response = await untilAborted(pending, signal);
			return turn.output.reply(response);
		} catch (error) {
			if (!deadline.aborted || requestSignal.aborted) await this.terminatePrompt(error);
			throw new AcpError(
				`ACP prompt failed: ${errorMessage(error)}`,
				turn.output.reply(),
				this.stderr.toString(),
				error,
			);
		}
	}

	/**
	 * Ignore unrelated sessions and thoughts; the turn capture owns bounded previews and overflow evidence. Config updates
	 * refresh the model state between turns too. Slash-command catalogs are the peer's own UI: they can run to hundreds of
	 * entries and repeat every turn, so they never reach the reply.
	 */
	private update(notification: SessionNotification): void {
		if (notification.sessionId !== this.sessionId) return;
		const update = notification.update;
		if (update.sessionUpdate === "config_option_update") {
			this.currentModels = acpModels(update) ?? this.currentModels;
			return;
		}
		if (update.sessionUpdate === "available_commands_update") return;
		const turn = this.active;
		if (!turn || turn.signal.aborted || update.sessionUpdate === "agent_thought_chunk") return;
		turn.output.append(notification);
	}

	private async requestPermission(
		request: RequestPermissionRequest,
		requestSignal: AbortSignal,
	): Promise<RequestPermissionResponse> {
		const cancelled: RequestPermissionResponse = { outcome: { outcome: "cancelled" } };
		const turn = this.active;
		if (!turn || request.sessionId !== this.sessionId || turn.signal.aborted) return cancelled;
		const signal = AbortSignal.any([requestSignal, turn.signal]);
		try {
			signal.throwIfAborted();
			const response = await untilAborted(this.permission(request, signal), signal);
			signal.throwIfAborted();
			const outcome = response.outcome;
			if (outcome.outcome === "selected" && !request.options.some((option) => option.optionId === outcome.optionId)) {
				throw new Error("ACP permission callback selected an unadvertised option.");
			}
			return response;
		} catch (error) {
			if (!signal.aborted) void this.shutdown(error);
			return cancelled;
		}
	}

	async cancel(): Promise<void> {
		if (this.active) await this.terminatePrompt(new Error("ACP prompt cancelled"));
	}

	private terminatePrompt(reason: unknown): Promise<void> {
		if (this.cancelling) return this.cancelling;
		this.active?.controller.abort(reason);
		this.cancelling = Promise.resolve().then(async () => {
			try {
				if (this.connection && !this.connection.signal.aborted) {
					await untilAborted(
						this.connection.agent.notify(methods.agent.session.cancel, { sessionId: this.sessionId }),
						timeoutSignal(KILL_GRACE_MS),
					);
				}
			} catch {
				/* Closing the owned process is authoritative when cooperative cancellation cannot be sent. */
			}
			await this.shutdown(reason);
		});
		return this.cancelling;
	}

	close(): Promise<void> {
		return this.shutdown(new Error("ACP connection closed"));
	}

	private shutdown(reason: unknown): Promise<void> {
		if (this.closing) return this.closing;
		this.lifetime.abort(reason);
		this.closing = Promise.resolve().then(async () => {
			this.connection?.close(reason);
			await stopTree(this.child.pid);
			this.child.stdin.destroy();
			this.child.stdout.destroy();
			this.child.stderr.destroy();
		});
		return this.closing;
	}
}
