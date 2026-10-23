import { spawn } from "node:child_process";
import { DapProtocol, type DapMessage } from "./protocol.ts";

const MAX_OUTPUT = 24_000;
const MAX_ITEMS = 100;
const INITIALIZED_MS = 10_000;

function body(message: DapMessage): Record<string, unknown> {
	return message.body && typeof message.body === "object" && !Array.isArray(message.body)
		? (message.body as Record<string, unknown>)
		: {};
}

function objects(value: unknown): Record<string, unknown>[] {
	return Array.isArray(value)
		? value.slice(0, MAX_ITEMS).filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
		: [];
}

export interface LaunchInput {
	adapter: string;
	adapterArgs?: string[];
	cwd: string;
	launch: Record<string, unknown>;
	breakpoints?: Array<{ source: string; lines: number[] }>;
}

/** Owns the adapter process, stop-scoped handles and all DAP state for a native session. */
export class DebugSession {
	readonly protocol: DapProtocol;
	readonly capabilities: Record<string, unknown> = {};
	#output = "";
	#state: "starting" | "running" | "stopped" | "ended" = "starting";
	#generation = 0;
	#thread?: number;
	#frames = new Set<number>();
	#variables = new Set<number>();
	#queue: Promise<unknown> = Promise.resolve();
	private constructor(protocol: DapProtocol) {
		this.protocol = protocol;
		protocol.onClose(() => {
			if (this.#state !== "ended") {
				this.#state = "ended";
				this.#invalidate();
			}
		});
		protocol.on("output", (event) => {
			const output = body(event).output;
			if (typeof output === "string") this.#append(output);
		});
		protocol.child.stderr.on("data", (chunk: Buffer) => this.#append(chunk.toString("utf8")));
		protocol.on("stopped", (event) => {
			this.#invalidate();
			this.#state = "stopped";
			const thread = body(event).threadId;
			this.#thread = typeof thread === "number" ? thread : undefined;
		});
		protocol.on("continued", () => this.#resume());
		protocol.on("terminated", () => this.close());
	}

	static async launch(
		input: LaunchInput,
		signal?: AbortSignal,
	): Promise<{ session: DebugSession; breakpoints: unknown[] }> {
		if (!input.adapter || !input.adapter.trim() || input.adapter.includes("\0"))
			throw new Error("Explicit adapter executable required");
		const child = spawn(input.adapter, input.adapterArgs ?? [], {
			cwd: input.cwd,
			stdio: "pipe",
			shell: false,
			windowsHide: true,
		});
		const session = new DebugSession(new DapProtocol(child));
		let cancelInitialized = () => {};
		try {
			const initialized = new Promise<void>((resolve, reject) => {
				let settled = false;
				const finish = (error?: Error) => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					off();
					signal?.removeEventListener("abort", abort);
					if (error) reject(error);
					else resolve();
				};
				const timer = setTimeout(() => {
					finish(new Error("DAP initialized event timed out"));
				}, INITIALIZED_MS);
				const off = session.protocol.on("initialized", () => finish());
				const abort = () => finish(new Error("DAP launch aborted"));
				signal?.addEventListener("abort", abort, { once: true });
				session.protocol.onClose(() => finish(new Error("DAP adapter closed before initialized")));
				cancelInitialized = () => finish(new Error("DAP launch cancelled"));
			});
			void initialized.catch(() => undefined);
			const response = await session.protocol.request(
				"initialize",
				{
					clientID: "octocode",
					adapterID: "explicit",
					pathFormat: "path",
					linesStartAt1: true,
					columnsStartAt1: true,
					supportsRunInTerminalRequest: false,
					supportsVariableType: true,
				},
				signal,
			);
			Object.assign(session.capabilities, body(response));
			// Launch may remain outstanding until configurationDone; initiate it before awaiting initialized.
			const launched = session.protocol.request("launch", { ...input.launch, noDebug: false }, signal);
			void launched.catch(() => undefined);
			await initialized;
			const breakpoints: unknown[] = [];
			for (const item of input.breakpoints ?? []) {
				const result = await session.protocol.request(
					"setBreakpoints",
					{
						source: { path: item.source },
						breakpoints: item.lines.map((line) => ({ line })),
						sourceModified: false,
					},
					signal,
				);
				breakpoints.push({ source: item.source, breakpoints: objects(body(result).breakpoints) });
			}
			if (session.capabilities.supportsConfigurationDoneRequest === true)
				await session.protocol.request("configurationDone", {}, signal);
			await launched;
			if (session.#state === "starting") session.#state = "running";
			return { session, breakpoints };
		} catch (error) {
			cancelInitialized();
			session.close();
			throw error;
		}
	}

	get state(): string {
		return this.#state;
	}
	get generation(): number {
		return this.#generation;
	}
	get thread(): number | undefined {
		return this.#thread;
	}
	output(): string {
		const output = this.#output;
		this.#output = "";
		return output;
	}

	#append(text: string): void {
		this.#output = (this.#output + text).slice(-MAX_OUTPUT);
	}
	#invalidate(): void {
		this.#generation++;
		this.#frames.clear();
		this.#variables.clear();
	}
	#resume(): void {
		this.#state = "running";
		this.#thread = undefined;
		this.#invalidate();
	}
	#stopped(generation: number): void {
		if (this.#state !== "stopped" || generation !== this.#generation)
			throw new Error("Stale stop generation; inspect the current stop again");
	}
	#ordered<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.#queue.then(operation);
		this.#queue = result.catch(() => undefined);
		return result;
	}

	async action(
		action: string,
		args: {
			generation?: number;
			threadId?: number;
			frameId?: number;
			variablesReference?: number;
			source?: string;
			lines?: number[];
		},
		signal?: AbortSignal,
	): Promise<unknown> {
		return this.#ordered(async () => {
			if (this.#state === "ended") throw new Error("Debug session ended");
			if (action === "output") return { state: this.#state, generation: this.#generation, output: this.output() };
			if (action === "breakpoints") {
				if (!args.source || !args.lines) throw new Error("Source and lines required");
				const result = await this.protocol.request(
					"setBreakpoints",
					{ source: { path: args.source }, breakpoints: args.lines.map((line) => ({ line })) },
					signal,
				);
				return { breakpoints: objects(body(result).breakpoints) };
			}
			if (args.generation === undefined) throw new Error("Stop generation required");
			this.#stopped(args.generation);
			if (action === "stack") {
				const threadId = args.threadId ?? this.#thread;
				if (threadId === undefined) {
					const threads = objects(body(await this.protocol.request("threads", {}, signal)).threads);
					this.#stopped(args.generation);
					return { generation: this.#generation, threads, hint: "Choose a threadId for stack" };
				}
				const frames = objects(
					body(await this.protocol.request("stackTrace", { threadId, levels: MAX_ITEMS }, signal)).stackFrames,
				);
				this.#stopped(args.generation);
				for (const frame of frames) if (typeof frame.id === "number") this.#frames.add(frame.id);
				return { generation: this.#generation, threadId, frames };
			}
			if (action === "scopes") {
				if (args.frameId === undefined || !this.#frames.has(args.frameId))
					throw new Error("Frame ID is not from this stop; call stack first");
				const scopes = objects(body(await this.protocol.request("scopes", { frameId: args.frameId }, signal)).scopes);
				this.#stopped(args.generation);
				for (const scope of scopes)
					if (typeof scope.variablesReference === "number" && scope.variablesReference > 0)
						this.#variables.add(scope.variablesReference);
				return { generation: this.#generation, scopes };
			}
			if (action === "variables") {
				if (!args.variablesReference || !this.#variables.has(args.variablesReference))
					throw new Error("Variable reference is not from this stop; call scopes first");
				const variables = objects(
					body(
						await this.protocol.request(
							"variables",
							{ variablesReference: args.variablesReference, count: MAX_ITEMS },
							signal,
						),
					).variables,
				);
				this.#stopped(args.generation);
				for (const variable of variables)
					if (typeof variable.variablesReference === "number" && variable.variablesReference > 0)
						this.#variables.add(variable.variablesReference);
				return { generation: this.#generation, variables };
			}
			const command = { continue: "continue", next: "next", stepIn: "stepIn", stepOut: "stepOut" }[action];
			if (!command) throw new Error(`Unsupported debugger action: ${action}`);
			const threadId = args.threadId ?? this.#thread;
			if (threadId === undefined) throw new Error("Thread ID required; call stack to list threads");
			this.#resume();
			try {
				await this.protocol.request(command, { threadId }, signal);
			} catch (error) {
				this.close();
				throw error;
			}
			return { state: this.#state, generation: this.#generation, output: this.output() };
		}).catch((error: unknown) => {
			if (
				signal?.aborted ||
				(error instanceof Error && /timed out|DAP session closed|DAP adapter exited/.test(error.message))
			)
				this.close();
			throw error;
		});
	}

	async terminate(): Promise<void> {
		if (this.#state === "ended") {
			this.close();
			return;
		}
		try {
			if (this.capabilities.supportsTerminateRequest === true) await this.protocol.request("terminate", {}, undefined);
			else await this.protocol.request("disconnect", { terminateDebuggee: true }, undefined);
		} finally {
			this.close();
		}
	}
	close(): void {
		this.#state = "ended";
		this.#invalidate();
		this.protocol.close();
	}
}
