import { asRecord, errorMessage } from "@octocodeai/octocode-contracts/guards";
import { openAdapter, type AdapterInput, type AdapterLink } from "./adapter.ts";
import { exceptionInfo } from "./exception-info.ts";
import { handshake, type HandshakeResult } from "./handshake.ts";
import { body, MAX_ITEMS, objects, stopProcess, type DapProtocol, type ReverseRequestHandler } from "./protocol.ts";

const MAX_OUTPUT = 24_000;
const MAX_CHILDREN = 16;
/** How long launch, resume, pause and output wait for the next stop or exit before reporting a running debuggee. */
export const STOP_WAIT_MS = 30_000;

interface LaunchInput extends AdapterInput {
	launch: Record<string, unknown>;
	breakpoints?: Array<{ source: string; lines: number[] }>;
	exceptions?: string[];
}

interface ActionArgs {
	generation?: number;
	threadId?: number;
	frameId?: number;
	variablesReference?: number;
	source?: string;
	lines?: number[];
}

/**
 * Owns the adapter, its connections and all stop-scoped handles for a native session. A TCP adapter such as js-debug
 * starts each debuggee process as a child connection through `startDebugging`; requests go to the connection that
 * reported the latest stop.
 */
export class DebugSession {
	readonly protocol: DapProtocol;
	readonly capabilities: Record<string, unknown> = {};
	#server?: AdapterLink["server"];
	#connect?: AdapterLink["connect"];
	#children = new Set<DapProtocol>();
	#caps = new Map<DapProtocol, Record<string, unknown>>();
	#active: DapProtocol;
	#breakpoints = new Map<string, number[]>();
	#exceptions: string[];
	#output = "";
	#state: "starting" | "running" | "stopped" | "ended" = "starting";
	#generation = 0;
	#thread?: number;
	#stop: Record<string, unknown> = {};
	#exitCode?: number;
	#frames = new Set<number>();
	#variables = new Set<number>();
	#waiters = new Set<() => void>();
	#queue: Promise<unknown> = Promise.resolve();
	private constructor(link: AdapterLink, input: LaunchInput) {
		this.protocol = link.root;
		this.#active = link.root;
		this.#server = link.server;
		this.#connect = link.connect;
		this.#caps.set(link.root, this.capabilities);
		this.#exceptions = input.exceptions ?? [];
		for (const item of input.breakpoints ?? []) this.#breakpoints.set(item.source, item.lines);
		this.#wire(link.root, true);
	}

	static async launch(
		input: LaunchInput,
		signal?: AbortSignal,
	): Promise<{ session: DebugSession; breakpoints: unknown[]; exceptions: HandshakeResult["exceptions"] }> {
		let log = (_text: string) => {};
		const link = await openAdapter(input, (text) => log(text), signal);
		const session = new DebugSession(link, input);
		log = (text) => session.#append(text);
		try {
			const result = await handshake(
				session.protocol,
				{
					...session.#handshakeInput("launch", input.launch),
					onCapabilities: (capabilities) => Object.assign(session.capabilities, capabilities),
				},
				signal,
			);
			if (session.#state === "starting") session.#state = "running";
			return { session, breakpoints: result.breakpoints, exceptions: result.exceptions };
		} catch (error) {
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

	#handshakeInput(request: "launch" | "attach", args: Record<string, unknown>) {
		const breakpoints = [...this.#breakpoints].map(([source, lines]) => ({ source, lines }));
		return { request, args, breakpoints, exceptions: this.#exceptions, startDebugging: this.#connect !== undefined };
	}
	#wire(protocol: DapProtocol, root: boolean): void {
		protocol.onClose(() => {
			if (root) {
				if (this.#state !== "ended") {
					this.#state = "ended";
					this.#invalidate();
				}
				this.#wake();
				return;
			}
			this.#children.delete(protocol);
			this.#caps.delete(protocol);
			if (this.#active !== protocol) return;
			this.#active = this.protocol;
			if (this.#state === "stopped") this.#resume();
		});
		protocol.on("output", (event) => {
			const { output, category } = body(event);
			if (typeof output === "string" && category !== "telemetry") this.#append(output);
		});
		protocol.on("stopped", (event) => {
			this.#invalidate();
			this.#state = "stopped";
			this.#active = protocol;
			const stop = body(event);
			this.#thread = typeof stop.threadId === "number" ? stop.threadId : undefined;
			this.#stop = Object.fromEntries(
				(["reason", "description", "text"] as const)
					.filter((key) => typeof stop[key] === "string")
					.map((key) => [key, (stop[key] as string).slice(0, 2_000)]),
			);
			this.#wake();
		});
		protocol.on("continued", () => {
			if (protocol === this.#active) this.#resume();
		});
		protocol.on("exited", (event) => {
			const code = body(event).exitCode;
			if (typeof code === "number") this.#exitCode = code;
		});
		protocol.on("terminated", () => (root ? this.close() : protocol.close()));
		if (this.#connect) protocol.handleReverseRequests(this.#reverse);
	}
	/** Honors only `startDebugging`, and only by connecting back to the adapter this session started. */
	#reverse: ReverseRequestHandler = (command, args) => {
		if (command !== "startDebugging" || this.#state === "ended") return undefined;
		if (this.#children.size >= MAX_CHILDREN) return Promise.reject(new Error("Too many child debug sessions"));
		const configuration = asRecord(args.configuration);
		void this.#adopt(args.request === "attach" ? "attach" : "launch", configuration);
		return Promise.resolve({});
	};
	async #adopt(request: "launch" | "attach", configuration: Record<string, unknown>): Promise<void> {
		let child: DapProtocol | undefined;
		try {
			child = await this.#connect!();
			if (this.#state === "ended") return child.close();
			this.#children.add(child);
			this.#wire(child, false);
			const opened = child;
			await handshake(child, {
				...this.#handshakeInput(request, configuration),
				onCapabilities: (capabilities) => this.#caps.set(opened, capabilities),
			});
		} catch (error) {
			this.#append(`[debug] child session failed: ${errorMessage(error)}\n`);
			child?.close();
		}
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
		this.#stop = {};
		this.#invalidate();
	}
	#wake(): void {
		// Each waiter deletes only itself; Set iteration tolerates deleting the current entry.
		for (const waiter of this.#waiters) waiter();
	}
	/** Resolves at the next stop or end, after `waitMs`, or on abort; never rejects. */
	async #settle(signal: AbortSignal | undefined, waitMs = STOP_WAIT_MS): Promise<void> {
		if (this.#state === "stopped" || this.#state === "ended" || signal?.aborted) return;
		await new Promise<void>((resolve) => {
			const done = () => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", done);
				this.#waiters.delete(done);
				resolve();
			};
			const timer = setTimeout(done, waitMs);
			signal?.addEventListener("abort", done, { once: true });
			this.#waiters.add(done);
		});
	}
	/** Current state with what the agent needs next: stop reason and top frame, exit code, and new output. */
	async #status(signal: AbortSignal | undefined): Promise<Record<string, unknown>> {
		const status: Record<string, unknown> = { state: this.#state, generation: this.#generation };
		if (this.#state === "stopped") {
			const generation = this.#generation;
			Object.assign(status, this.#stop, { threadId: this.#thread });
			if (this.#thread !== undefined && !signal?.aborted) {
				try {
					const trace = await this.#active.request("stackTrace", { threadId: this.#thread, levels: 1 }, signal);
					const top = objects(body(trace).stackFrames)[0];
					if (top && generation === this.#generation && typeof top.id === "number") {
						this.#frames.add(top.id);
						const source = asRecord(top.source);
						status.frame = { id: top.id, name: top.name, source: source.path ?? source.name, line: top.line };
					}
				} catch (error) {
					status.frameError = errorMessage(error);
				}
				if (this.#stop.reason === "exception" && this.#caps.get(this.#active)?.supportsExceptionInfoRequest === true)
					status.exception = await exceptionInfo(this.#active, this.#thread, signal);
			}
			status.state = this.#state;
			status.generation = this.#generation;
			status.next =
				this.#state === "stopped"
					? "Inspect with stack, scopes (frame.id) or variables using this generation; resume with next, stepIn, stepOut or continue"
					: "The stop was superseded; call output";
		} else if (this.#state === "ended") {
			if (this.#exitCode !== undefined) status.exitCode = this.#exitCode;
			status.next = "The debuggee has ended; launch again to start a new session";
		} else {
			status.next = `Still running after ${STOP_WAIT_MS / 1000}s; call output to wait again, pause to see where it is, or terminate`;
		}
		status.output = this.output();
		return status;
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
	/** Replaces one file's breakpoints on every connection; reports the newest debuggee's answer. */
	async #setBreakpoints(source: string, lines: number[], signal?: AbortSignal): Promise<unknown> {
		this.#breakpoints.set(source, lines);
		const args = { source: { path: source }, breakpoints: lines.map((line) => ({ line })) };
		const results = await Promise.allSettled(
			[this.protocol, ...this.#children].map((protocol) => protocol.request("setBreakpoints", args, signal)),
		);
		const answered = results.filter((result) => result.status === "fulfilled");
		const last = answered.at(-1);
		if (!last) throw (results[0] as PromiseRejectedResult).reason;
		return { breakpoints: objects(body(last.value).breakpoints) };
	}
	/** Pauses the newest debuggee connection's given or first thread. */
	async #pause(threadId: number | undefined, signal?: AbortSignal): Promise<unknown> {
		if (this.#state !== "running") throw new Error(`pause needs a running program; it is ${this.#state}`);
		const target = [...this.#children].at(-1) ?? this.protocol;
		const thread =
			threadId ??
			objects(body(await target.request("threads", {}, signal)).threads)
				.map((item) => item.id)
				.find((id): id is number => typeof id === "number");
		if (thread === undefined) throw new Error("No thread to pause yet; call output and try again");
		await target.request("pause", { threadId: thread }, signal);
		await this.#settle(signal);
		return this.#status(signal);
	}

	async action(action: string, args: ActionArgs, signal?: AbortSignal): Promise<unknown> {
		return this.#ordered(async () => {
			if (action === "output") {
				await this.#settle(signal);
				return this.#status(signal);
			}
			if (this.#state === "ended")
				throw new Error("Debug session ended; call output for its final output, or launch a new session");
			if (action === "breakpoints") {
				if (!args.source || !args.lines) throw new Error("Source and lines required");
				return this.#setBreakpoints(args.source, args.lines, signal);
			}
			if (action === "pause") return this.#pause(args.threadId, signal);
			if (args.generation === undefined) throw new Error("Stop generation required");
			this.#stopped(args.generation);
			const active = this.#active;
			if (action === "stack") {
				const threadId = args.threadId ?? this.#thread;
				if (threadId === undefined) {
					const threads = objects(body(await active.request("threads", {}, signal)).threads);
					this.#stopped(args.generation);
					return { generation: this.#generation, threads, hint: "Choose a threadId for stack" };
				}
				const trace = await active.request("stackTrace", { threadId, levels: MAX_ITEMS }, signal);
				const frames = objects(body(trace).stackFrames);
				this.#stopped(args.generation);
				for (const frame of frames) if (typeof frame.id === "number") this.#frames.add(frame.id);
				return { generation: this.#generation, threadId, frames };
			}
			if (action === "scopes") {
				if (args.frameId === undefined || !this.#frames.has(args.frameId))
					throw new Error("Frame ID is not from this stop; call stack first");
				const scopes = objects(body(await active.request("scopes", { frameId: args.frameId }, signal)).scopes);
				this.#stopped(args.generation);
				for (const scope of scopes)
					if (typeof scope.variablesReference === "number" && scope.variablesReference > 0)
						this.#variables.add(scope.variablesReference);
				return { generation: this.#generation, scopes };
			}
			if (action === "variables") {
				if (!args.variablesReference || !this.#variables.has(args.variablesReference))
					throw new Error("Variable reference is not from this stop; call scopes first");
				const request = { variablesReference: args.variablesReference, count: MAX_ITEMS };
				const variables = objects(body(await active.request("variables", request, signal)).variables);
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
				await active.request(command, { threadId }, signal);
			} catch (error) {
				this.close();
				throw error;
			}
			await this.#settle(signal);
			return this.#status(signal);
		}).catch((error: unknown) => {
			if (
				signal?.aborted ||
				(error instanceof Error &&
					/timed out|DAP session closed|DAP adapter exited|DAP connection closed/.test(error.message))
			)
				this.close();
			throw error;
		});
	}

	/**
	 * Stops child sessions, then the root, then the adapter process. Returns a warning when the adapter did not confirm;
	 * closing still stops the adapter process the tool started.
	 */
	async terminate(): Promise<string | undefined> {
		if (this.#state === "ended") {
			this.close();
			return undefined;
		}
		const stop = (protocol: DapProtocol) =>
			this.#caps.get(protocol)?.supportsTerminateRequest === true
				? protocol.request("terminate", {}, undefined)
				: protocol.request("disconnect", { terminateDebuggee: true }, undefined);
		try {
			// js-debug's root connection answers disconnect only after its child sessions are gone.
			await Promise.allSettled([...this.#children].map(stop));
			await stop(this.protocol);
			return undefined;
		} catch (error) {
			// lldb-dap can announce `terminated` or exit before answering; the session ending is the requested outcome.
			// Read through the getter: a `terminated` event may have ended the session during the await.
			return this.state === "ended"
				? undefined
				: `the adapter did not confirm (${errorMessage(error)}); its process was stopped`;
		} finally {
			this.close();
		}
	}
	close(): void {
		this.#state = "ended";
		this.#invalidate();
		for (const child of this.#children) child.close();
		this.#children.clear();
		this.protocol.close();
		if (this.#server) stopProcess(this.#server);
		this.#wake();
	}
}
