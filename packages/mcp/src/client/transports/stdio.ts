import { type ChildProcess, spawn } from "node:child_process";
import process from "node:process";
import crossSpawn from "cross-spawn";
import { processLifetime } from "@octocodeai/octocode-common/process-lifetime";
import { serializeMessage, type JSONRPCMessage } from "@modelcontextprotocol/client";
import { DEFAULT_INHERITED_ENV_VARS } from "@modelcontextprotocol/client/stdio";
export { DEFAULT_INHERITED_ENV_VARS };
import {
	JSON_RPC_ERROR_CODES,
	McpConnectionClosedError,
	McpError,
	parseJsonRpcMessage,
	type JsonRpcId,
	type JsonRpcMessage,
} from "../protocol/jsonrpc.ts";
import { recordStdioGroup, reapStdioOrphans } from "./stdio-owner.ts";
import { DEFAULT_MAX_MESSAGE_BYTES, type McpTransport, TransportEvents } from "./transport.ts";

/** The JSON of one stdio frame; a frame that is not JSON is reported like a frame that is not a message. */
function parseFrame(text: string): unknown {
	try {
		return JSON.parse(text) as unknown;
	} catch {
		throw new McpError(JSON_RPC_ERROR_CODES.invalidRequest, "Invalid JSON-RPC message");
	}
}

const DEFAULT_MAX_STDERR_BYTES = 64 * 1024;
const DEFAULT_CLOSE_TIMEOUT_MS = 2_000;
/** How long a server gets to exit on its own after stdin closes, before it is sent SIGTERM. */
const STDIN_CLOSE_GRACE_MS = 500;
/** After the spawned process exits, how long what it left in its stdout pipe has to arrive when something else holds the pipes. */
const EXIT_STDOUT_DRAIN_MS = 250;
const USE_PROCESS_GROUPS = process.platform !== "win32";

/** The host's environment reduced to `DEFAULT_INHERITED_ENV_VARS` (exported functions are skipped, as the SDK does). */
export function getDefaultEnvironment(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
	const env: Record<string, string> = {};
	for (const key of DEFAULT_INHERITED_ENV_VARS) {
		const value = source[key];
		if (value === undefined || value.startsWith("()")) continue;
		env[key] = value;
	}
	return env;
}

/** Process groups of running servers; each gets SIGTERM if the host exits without closing it (`processLifetime`). */
const liveProcessGroups = new Set<number>();

/** Pids of the stdio servers this process has running (each leads its own process group); empty on Windows. */
export function liveStdioServerPids(): number[] {
	return [...liveProcessGroups];
}

function killProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
	const pid = child.pid;
	if (process.platform === "win32" && pid !== undefined) {
		if (child.exitCode !== null) return;
		// Windows has no graceful signals, and cross-spawn runs `.cmd` shims through cmd.exe; killing only
		// that would leave the server running.
		spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on("error", () => {});
		return;
	}
	if (USE_PROCESS_GROUPS && pid !== undefined) {
		try {
			// Negative pid: the whole group, so wrappers like `npx` or `uvx` do not leave the server behind.
			process.kill(-pid, signal);
			return;
		} catch {
			// The group is gone or was never created; fall back to the direct child.
		}
	}
	try {
		child.kill(signal);
	} catch {
		// The child already exited, so there is nothing left to signal.
	}
}

/** How much of an oversized message is searched for its top-level `id`. */
const OVERSIZE_PROBE_BYTES = 4096;
const ID_VALUE = '(-?\\d+|"(?:[^"\\\\]|\\\\.)*")';
const LEADING_ID = new RegExp(`^\\s*\\{\\s*(?:"jsonrpc"\\s*:\\s*"[^"]*"\\s*,\\s*)?"id"\\s*:\\s*${ID_VALUE}\\s*[,}]`);
/** A request or notification, not a response: `method` leads the message, after an optional `jsonrpc` and `id`. */
const REQUEST_START = new RegExp(
	`^\\s*\\{\\s*(?:"jsonrpc"\\s*:\\s*"[^"]*"\\s*,\\s*)?(?:"id"\\s*:\\s*${ID_VALUE}\\s*,\\s*)?"method"`,
);
const TRAILING_ID = new RegExp(`,\\s*"id"\\s*:\\s*${ID_VALUE}\\s*\\}\\s*$`);

/** The id of a response from the start or end of its text; only a top-level `id` member there counts. */
function responseId(start: string, end: string | undefined): JsonRpcId | undefined {
	const raw = LEADING_ID.exec(start)?.[1] ?? (end === undefined ? undefined : TRAILING_ID.exec(end)?.[1]);
	if (raw === undefined) return undefined;
	try {
		return JSON.parse(raw) as JsonRpcId;
	} catch {
		return undefined;
	}
}

export interface StdioTransportOptions {
	command: string;
	args?: readonly string[];
	cwd?: string;
	/** Variables for the server, over the inherited ones. */
	env?: Record<string, string>;
	/**
	 * `true`: the server inherits the whole host environment (tokens included). Default `false`: only
	 * `DEFAULT_INHERITED_ENV_VARS`; `env` adds to them. Use an absolute command or pass `PATH` yourself to change `PATH`.
	 */
	inheritEnv?: boolean;
	stderr?: "pipe" | "inherit";
	onStderr?: (chunk: string) => void;
	maxMessageBytes?: number;
	maxStderrBytes?: number;
	/** Time to wait for the server to exit after SIGTERM before sending SIGKILL. Default: 2000. */
	closeTimeoutMs?: number;
}

export class StdioTransport extends TransportEvents implements McpTransport {
	readonly options: Readonly<StdioTransportOptions>;
	private child: ChildProcess | undefined;
	/** Bytes of the message being read, as they arrived: none of them holds a newline. */
	private stdoutChunks: Buffer[] = [];
	private stdoutBytes = 0;
	/** Set after an oversized message was dropped before its newline: the bytes up to that newline still belong to it. */
	private discardingLine = false;
	private stderrBuffer = Buffer.alloc(0);
	private started = false;
	private closed = false;
	private closing: Promise<void> | undefined;
	/** Running from the spawned process's exit until the transport closes (`handleExit`). */
	private exitDrain: ReturnType<typeof setTimeout> | undefined;
	/** Ids of requests sent and not yet answered: an oversized response fails its request instead of stalling it. */
	private readonly outstanding = new Set<JsonRpcId>();

	constructor(options: StdioTransportOptions) {
		super();
		this.options = Object.freeze({ ...options, args: options.args ? [...options.args] : undefined });
	}

	get pid(): number | undefined {
		return this.child?.pid;
	}

	get stderr(): string {
		return this.stderrBuffer.toString("utf8");
	}

	async start(): Promise<void> {
		if (this.started) throw new Error("MCP stdio transport already started");
		if (this.closed) throw new McpConnectionClosedError();
		this.started = true;
		await reapStdioOrphans();
		const inherited = this.options.inheritEnv === true ? { ...process.env } : getDefaultEnvironment();
		const env = { ...inherited, ...this.options.env };
		const child = crossSpawn(this.options.command, this.options.args ?? [], {
			cwd: this.options.cwd,
			env,
			stdio: ["pipe", "pipe", this.options.stderr === "inherit" ? "inherit" : "pipe"],
			windowsHide: true,
			// Own process group, so closing the transport can terminate the server's children too.
			detached: USE_PROCESS_GROUPS,
		});
		this.child = child;
		const pid = child.pid;
		if (USE_PROCESS_GROUPS && pid !== undefined) {
			liveProcessGroups.add(pid);
			const atExit = processLifetime.acquireGroup(`MCP server ${this.options.command}`, pid, "SIGTERM");
			// Until "close", a launcher's children may still hold the pipes and belong to the group.
			const release = recordStdioGroup(
				pid,
				[this.options.command, ...(this.options.args ?? [])].join(" ").slice(0, 200),
			);
			child.once("close", () => {
				liveProcessGroups.delete(pid);
				atExit();
				void release();
			});
		}
		child.stdout?.on("data", (chunk: Buffer | string) => this.handleStdout(chunk));
		child.stdout?.on("error", (error) => this.emitError(error));
		child.stdin?.on("error", (error) => {
			if (!this.closed) this.emitError(error);
		});
		child.stderr?.on("data", (chunk: Buffer | string) => this.handleStderr(chunk));
		child.stderr?.on("error", (error) => this.emitError(error));
		child.once("exit", () => this.handleExit());
		child.on("close", () => {
			clearTimeout(this.exitDrain);
			this.child = undefined;
			this.endStream();
		});

		await new Promise<void>((resolve, reject) => {
			const onSpawn = () => {
				child.off("error", onError);
				resolve();
			};
			const onError = (error: Error) => {
				child.off("spawn", onSpawn);
				reject(error);
			};
			child.once("spawn", onSpawn);
			child.once("error", onError);
		});
		child.on("error", (error) => {
			if (!this.closed) this.emitError(error);
		});
	}

	async send(message: JsonRpcMessage): Promise<void> {
		const stdin = this.child?.stdin;
		if (!this.started || this.closed || !stdin?.writable) throw new McpConnectionClosedError();
		const payload = serializeMessage(message as JSONRPCMessage);
		if ("method" in message && "id" in message && message.id !== undefined) this.outstanding.add(message.id);
		await new Promise<void>((resolve, reject) => {
			stdin.write(payload, (error) => (error ? reject(error) : resolve()));
		});
	}

	close(): Promise<void> {
		return (this.closing ??= this.shutdown());
	}

	/**
	 * The spawned process exited. Its `close` waits for every holder of the pipes, which may never let go: a descendant that
	 * inherited stderr, say. Node destroyed `child.stdin` at this exit, so nothing can reach whatever still runs. That holds
	 * for a server that outlived its launcher (npx, uvx) too: its stdin is at end of file and no request can be sent to it, so
	 * waiting would only leave the client "connected" to something it cannot use. What the process wrote before it exited is
	 * already in the pipe and arrives within the drain; a reply only a survivor could still send is given up. Then the same
	 * shutdown as `close()` runs for a launcher that already exited: SIGTERM to the group at once, SIGKILL, release the pipes.
	 */
	private handleExit(): void {
		if (this.closed) return;
		this.exitDrain = setTimeout(() => {
			if (this.closed) return;
			void this.close();
			this.endStream();
		}, EXIT_STDOUT_DRAIN_MS);
		this.exitDrain.unref();
	}

	/** No more messages will count: report a message cut short, then tell the client. */
	private endStream(): void {
		if (Buffer.concat(this.stdoutChunks).toString("utf8").trim()) {
			this.emitError(new Error("MCP stdio server closed with an incomplete JSON-RPC message"));
		}
		this.stdoutChunks = [];
		this.stdoutBytes = 0;
		this.discardingLine = false;
		this.outstanding.clear();
		this.emitClose();
	}

	private async shutdown(): Promise<void> {
		this.closed = true;
		const child = this.child;
		if (!child) {
			this.emitClose();
			return;
		}
		// Shutdown per the spec: close stdin and let the server exit, then SIGTERM, then SIGKILL. When the launcher
		// (npx, uvx) already exited, the server it started can still hold the pipes: it gets SIGTERM at once and the
		// same SIGKILL escalation, since only the group signal still reaches it.
		const launcherExited = child.exitCode !== null || child.signalCode !== null;
		const closeTimeoutMs = this.options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;
		await new Promise<void>((resolve) => {
			const timers: ReturnType<typeof setTimeout>[] = [];
			child.once("close", () => {
				for (const timer of timers) clearTimeout(timer);
				// Children of the server that ignored stdin closing would otherwise outlive it.
				killProcessTree(child, "SIGTERM");
				resolve();
			});
			const grace = launcherExited ? 0 : Math.min(STDIN_CLOSE_GRACE_MS, closeTimeoutMs);
			timers.push(setTimeout(() => killProcessTree(child, "SIGTERM"), grace));
			timers.push(setTimeout(() => killProcessTree(child, "SIGKILL"), grace + closeTimeoutMs));
			// A holder outside the group (or a launcher Windows can no longer kill) keeps the pipes open after SIGKILL:
			// release them so close() still finishes.
			timers.push(
				setTimeout(
					() => {
						child.stdout?.destroy();
						child.stderr?.destroy();
						child.stdin?.destroy();
					},
					grace + 2 * closeTimeoutMs,
				),
			);
			child.stdin?.end();
		});
	}

	/**
	 * Splits stdout into newline-terminated messages. Only the new chunk is scanned, and a message is joined once when its
	 * newline arrives, so a large message costs time in proportion to its size, not to its size times its chunk count.
	 */
	private handleStdout(chunk: Buffer | string): void {
		const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		const maxMessageBytes = this.options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
		let start = 0;
		for (let newline = data.indexOf(0x0a); newline >= 0; newline = data.indexOf(0x0a, start)) {
			const part = data.subarray(start, newline);
			start = newline + 1;
			const pending = this.stdoutChunks;
			this.stdoutChunks = [];
			this.stdoutBytes = 0;
			if (this.discardingLine) {
				this.discardingLine = false;
				continue;
			}
			this.handleLine(pending.length > 0 ? Buffer.concat([...pending, part]) : part, maxMessageBytes);
		}
		const rest = data.subarray(start);
		if (this.discardingLine || rest.length === 0) return;
		this.stdoutChunks.push(rest);
		this.stdoutBytes += rest.length;
		if (this.stdoutBytes <= maxMessageBytes) return;
		const head = Buffer.concat(this.stdoutChunks, Math.min(OVERSIZE_PROBE_BYTES, this.stdoutBytes));
		this.stdoutChunks = [];
		this.stdoutBytes = 0;
		this.discardingLine = true;
		this.rejectOversized(head, undefined, maxMessageBytes);
	}

	private handleLine(line: Buffer, maxMessageBytes: number): void {
		if (line.length > maxMessageBytes) {
			this.rejectOversized(
				line.subarray(0, OVERSIZE_PROBE_BYTES),
				line.subarray(-OVERSIZE_PROBE_BYTES),
				maxMessageBytes,
			);
			return;
		}
		const text = line.toString("utf8").replace(/\r$/, "");
		if (!text.trim()) return;
		try {
			// One error for every malformed frame (unparsable JSON or a non-message), not the validator's issue list.
			const message = parseJsonRpcMessage(parseFrame(text));
			if (!("method" in message)) this.outstanding.delete(message.id);
			this.emitMessage(message);
		} catch (error) {
			this.emitError(error);
		}
	}

	/**
	 * Reports a dropped oversized message and, when it was the response to a request, answers that request with an
	 * error at once (otherwise it would wait out its timeout). The id comes from the head or tail of the message;
	 * without one, a lone outstanding request is the only candidate.
	 */
	private rejectOversized(head: Buffer, tail: Buffer | undefined, maxMessageBytes: number): void {
		const message = `MCP stdio message exceeds ${maxMessageBytes} bytes`;
		this.emitError(new Error(message));
		const start = head.toString("utf8");
		if (REQUEST_START.test(start)) return;
		const id = responseId(start, tail?.toString("utf8"));
		const target =
			id !== undefined && this.outstanding.has(id)
				? id
				: id === undefined && this.outstanding.size === 1
					? [...this.outstanding][0]
					: undefined;
		if (target === undefined) return;
		this.outstanding.delete(target);
		this.emitMessage({ jsonrpc: "2.0", id: target, error: { code: JSON_RPC_ERROR_CODES.internalError, message } });
	}

	private handleStderr(chunk: Buffer | string): void {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		const maxStderrBytes = this.options.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES;
		this.stderrBuffer = Buffer.concat([this.stderrBuffer, buffer]);
		if (this.stderrBuffer.length > maxStderrBytes) this.stderrBuffer = this.stderrBuffer.subarray(-maxStderrBytes);
		this.options.onStderr?.(buffer.toString("utf8"));
	}
}
