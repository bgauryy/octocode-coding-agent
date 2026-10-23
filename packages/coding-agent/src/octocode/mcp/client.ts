import {
	type CallToolResult,
	type McpClient,
	McpConnectionClosedError,
	type ProgressNotification,
	StdioTransport,
	type Tool,
} from "@octocodeai/octocode-mcp";
import { McpCatalogCache } from "../../extensions/mcp/catalog.ts";
import {
	createMcpClient,
	DEFAULT_TIMEOUT_MS,
	stderrReport,
	trackToolListChanges,
} from "../../extensions/mcp/runtime/client.ts";
import { OCTOCODE_SERVER } from "../shared/octocode-tools.ts";
import { tailNote } from "../shared/format.ts";
import { saveFullOutput } from "../shared/spill.ts";
import { errorMessage } from "../shared/util.ts";

/** How the server process starts. */
export interface Launch {
	command: string;
	args: string[];
	cwd: string;
	env: Record<string, string>;
}

type ServerState = "idle" | "connecting" | "connected" | "failed" | "disconnected" | "closed";

export interface ServerStatus {
	state: ServerState;
	/** Why the last connection failed or ended. */
	error?: string;
	/** The latest error on a live connection (malformed frame, dead stream): reported, not a connection failure. */
	clientError?: string;
	serverName?: string;
	serverVersion?: string;
	tools: number;
	pid?: number;
	cwd?: string;
}

interface ServerOptions {
	launch: (cwd: string) => Launch;
	/** Client name and version sent in `initialize`. */
	clientInfo: { name: string; version: string };
	/** Every (re)listing of the server's tools, with its instructions. */
	onTools: (tools: Tool[], instructions: string | undefined) => void;
	onStatus?: (status: ServerStatus) => void;
	/** The first failure to connect since the last success or restart. */
	onFailure: (message: string) => void;
	/** A connect succeeded after a failure was reported (`onFailure`): `at` is when, so a notice can say it is resolved. */
	onRecovered?: (at: number) => void;
	/** A re-list after `tools/list_changed` failed: the tools the model has may be out of date. Once per run of failures. */
	onRefreshFailure?: (message: string) => void;
	/** Bound on `initialize`, `tools/list` and each `tools/call`. */
	requestTimeoutMs?: number;
}

/** After its automatic reconnect failed, how long a server waits before a later call or `ready()` may try once more. */
export const RETRY_COOL_DOWN_MS = 60_000;

/**
 * One stdio MCP server process and its client: the connection lifecycle, nothing about Octocode. It connects once per
 * session folder, keeps the server's tools and instructions, follows `tools/list_changed`, and after the process dies
 * or a connect fails it reconnects once, on the next `ready()` or tool call, then reports a clear error; once
 * `RETRY_COOL_DOWN_MS` passed since the last failure, the next `ready()` or call tries once more (a sibling build fixed
 * meanwhile connects without a manual `restart()`), so attempts are bounded to one per cool-down. `close()` ends the
 * process tree.
 */
export class OctocodeServer {
	private readonly catalog = new McpCatalogCache();
	private state: ServerState = "idle";
	private cwd: string | undefined;
	private client: McpClient | undefined;
	private transport: StdioTransport | undefined;
	private connecting: Promise<boolean> | undefined;
	/** The client of a connect in progress, so a stop can end its process before it finishes starting. */
	private starting: McpClient | undefined;
	private error: string | undefined;
	private clientError: string | undefined;
	private tools: Tool[] = [];
	private instructionsText: string | undefined;
	/** Automatic reconnects left; one per failure episode, restored by a success, `restart()` or the cool-down. */
	private retries = 1;
	/** When the latest connect failed; the cool-down counts from it. */
	private failedAt: number | undefined;
	private reported = false;
	/** Bumped by every close, so a connect that finishes after one discards itself. */
	private generation = 0;
	private listRevision = 0;
	/** A failed re-list was reported and none succeeded since. */
	private refreshReported = false;

	/** Tool calls in flight; a restart would end them. */
	private activeCalls = 0;

	private readonly options: ServerOptions;
	constructor(options: ServerOptions) {
		this.options = options;
	}

	/** The bound on `initialize`, `tools/list` and each `tools/call`. */
	private get requestTimeoutMs(): number {
		return this.options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
	}

	/** Whether no tool call is running, so a restart would cancel none. */
	get idle(): boolean {
		return this.activeCalls === 0;
	}

	get instructions(): string | undefined {
		return this.instructionsText;
	}

	status(): ServerStatus {
		const info = this.client?.serverInfo;
		return {
			state: this.state,
			...(this.error ? { error: this.error } : {}),
			...(this.clientError ? { clientError: this.clientError } : {}),
			...(info ? { serverName: info.name, serverVersion: info.version } : {}),
			tools: this.tools.length,
			...(this.transport?.pid !== undefined && this.state === "connected" ? { pid: this.transport.pid } : {}),
			...(this.cwd ? { cwd: this.cwd } : {}),
		};
	}

	/** Connect for the session folder `cwd`; a new folder replaces the running server. */
	start(cwd: string): void {
		if (this.cwd !== cwd) {
			this.catalog.clear();
			this.cwd = cwd;
			void this.stop();
			this.reset();
		}
		if (this.state === "idle" || this.state === "closed") void this.connect(cwd);
	}

	/** Stop the server and connect again for `cwd`, with the retry restored. */
	async restart(cwd: string): Promise<boolean> {
		if (this.cwd !== cwd) this.catalog.clear();
		await this.stop();
		this.cwd = cwd;
		this.reset();
		return this.connect(cwd);
	}

	async close(): Promise<void> {
		await this.stop();
		this.catalog.clear();
		this.cwd = undefined;
	}

	/**
	 * Whether the server is connected, waiting at most `waitMs` for a connect in progress. A failed or dead server is
	 * retried once; a failure ends the wait at once.
	 */
	async ready(waitMs = Number.POSITIVE_INFINITY, signal?: AbortSignal): Promise<boolean> {
		if (this.state === "connected") return true;
		const attempt = this.connecting ?? this.reconnect();
		if (!attempt) return false;
		let timer: NodeJS.Timeout | undefined;
		let onAbort: (() => void) | undefined;
		const stop = new Promise<false>((resolve) => {
			if (Number.isFinite(waitMs)) timer = setTimeout(() => resolve(false), waitMs);
			if (signal) {
				onAbort = () => resolve(false);
				if (signal.aborted) resolve(false);
				else signal.addEventListener("abort", onAbort, { once: true });
			}
		});
		try {
			return await Promise.race([attempt, stop]);
		} finally {
			clearTimeout(timer);
			if (onAbort) signal?.removeEventListener("abort", onAbort);
		}
	}

	/** `tools/call`, whole: no truncation. Reconnects once when the server has died. */
	async call(
		name: string,
		args: Record<string, unknown>,
		signal?: AbortSignal,
		onProgress?: (progress: ProgressNotification) => void,
	): Promise<CallToolResult> {
		if (!(await this.ready(Number.POSITIVE_INFINITY, signal)) || !this.client) {
			signal?.throwIfAborted();
			throw new Error(
				`Octocode MCP server is not available${this.error ? `: ${this.error}` : ""}. Restart it with /mcp reconnect octocode; a call ${RETRY_COOL_DOWN_MS / 1000} s after the failure tries once more by itself.`,
			);
		}
		this.activeCalls++;
		try {
			return await this.client.callTool(name, args, {
				...(signal ? { signal } : {}),
				// A progress token lets the server's progress renew the idle timeout of a slow call.
				...(onProgress ? { onProgress } : {}),
				timeoutMs: this.requestTimeoutMs,
			});
		} catch (error) {
			if (error instanceof McpConnectionClosedError)
				throw new Error(
					`Octocode MCP server stopped during the call${this.error ? `: ${this.error}` : ""}. The next call starts it again.`,
				);
			throw error;
		} finally {
			this.activeCalls--;
		}
	}

	private reset(): void {
		this.retries = 1;
		this.failedAt = undefined;
		this.reported = false;
		this.error = undefined;
		this.tools = [];
		this.instructionsText = undefined;
	}

	/** Starts the one automatic reconnect a failed or dead server gets; undefined when there is none left. */
	private reconnect(): Promise<boolean> | undefined {
		if (this.retries <= 0 && this.failedAt !== undefined && Date.now() - this.failedAt >= RETRY_COOL_DOWN_MS)
			this.retries = 1;
		if (!this.cwd || this.state === "idle" || this.state === "closed" || this.retries <= 0) return undefined;
		this.retries--;
		return this.connect(this.cwd);
	}

	private connect(cwd: string): Promise<boolean> {
		const attempt: Promise<boolean> = this.open(cwd).finally(() => {
			if (this.connecting === attempt) this.connecting = undefined;
		});
		this.connecting = attempt;
		return attempt;
	}

	private async open(cwd: string): Promise<boolean> {
		const generation = ++this.generation;
		this.state = "connecting";
		this.options.onStatus?.(this.status());
		const timeoutMs = this.requestTimeoutMs;
		// The server is Octocode's own: it needs the host's tokens (GITHUB_TOKEN, proxies), so it inherits the environment.
		const transport = new StdioTransport({ ...this.options.launch(cwd), inheritEnv: true, stderr: "pipe" });
		// Octocode's own server: its client name, and no `roots` (its readers take their folders from `ALLOWED_PATHS`).
		const { client } = createMcpClient(OCTOCODE_SERVER, cwd, timeoutMs, undefined, {
			clientInfo: this.options.clientInfo,
			roots: false,
		});
		this.starting = client;
		this.clientError = undefined;
		client.onError((error) => {
			this.clientError = error.message;
			this.options.onStatus?.(this.status());
		});
		client.onClose(() => this.lost(client, transport));
		const listChanges = trackToolListChanges(client, {
			isCurrent: () => this.client === client,
			refresh: () => void this.relist(client),
		});
		try {
			await client.connect(transport);
			const tools = client.serverCapabilities?.tools ? await client.listTools({ timeoutMs }) : [];
			if (generation !== this.generation) {
				await client.close();
				return false;
			}
			this.starting = undefined;
			this.client = client;
			this.transport = transport;

			this.state = "connected";
			this.error = undefined;
			this.retries = 1;
			this.failedAt = undefined;
			const recovered = this.reported;
			this.reported = false;
			if (recovered) this.options.onRecovered?.(Date.now());
			this.publishCatalog(client, tools);
			if (listChanges.changedDuringConnect()) await this.relist(client);
			this.options.onStatus?.(this.status());
			return true;
		} catch (error) {
			await Promise.allSettled([client.close()]);
			if (generation !== this.generation) return false;
			this.starting = undefined;
			this.client = undefined;
			this.state = "failed";
			this.failedAt = Date.now();
			this.withdrawCatalog();
			this.error = this.describe(errorMessage(error), transport);
			this.options.onStatus?.(this.status());
			if (!this.reported) {
				this.reported = true;
				this.options.onFailure(this.error);
			}
			return false;
		}
	}

	private publishCatalog(client: McpClient, tools: Tool[]): void {
		const catalog = this.catalog.update(client.serverInfo, tools, client.instructions);
		if (this.tools === catalog.tools && this.instructionsText === catalog.instructions) return;
		this.tools = catalog.tools;
		this.instructionsText = catalog.instructions;
		this.options.onTools(this.tools, this.instructionsText);
		this.options.onStatus?.(this.status());
	}

	private withdrawCatalog(): void {
		this.listRevision++;
		if (this.tools.length === 0 && this.instructionsText === undefined) return;
		this.tools = [];
		this.instructionsText = undefined;
		this.options.onTools([], undefined);
		this.options.onStatus?.(this.status());
	}

	/** Refresh only from the newest list response; a failed refresh withdraws unverified metadata. */
	private async relist(client: McpClient): Promise<void> {
		const revision = ++this.listRevision;
		try {
			const tools = client.serverCapabilities?.tools
				? await client.listTools({ timeoutMs: this.requestTimeoutMs })
				: [];
			if (client !== this.client || revision !== this.listRevision) return;
			this.refreshReported = false;
			this.publishCatalog(client, tools);
		} catch (error) {
			if (client !== this.client || revision !== this.listRevision) return;
			this.withdrawCatalog();
			if (this.refreshReported) return;
			this.refreshReported = true;
			this.options.onRefreshFailure?.(errorMessage(error));
		}
	}

	/** The connection ended. Unplanned only when this client is still the current one. */
	private lost(client: McpClient, transport: StdioTransport): void {
		if (this.client !== client) return;
		this.client = undefined;
		this.state = "disconnected";
		this.withdrawCatalog();
		this.error = this.describe("the server process exited", transport);
		this.options.onStatus?.(this.status());
	}

	private async stop(): Promise<void> {
		this.generation++;
		const clients = [this.client, this.starting];
		this.client = undefined;
		this.starting = undefined;
		this.transport = undefined;
		this.connecting = undefined;
		this.state = "closed";
		this.withdrawCatalog();
		this.options.onStatus?.(this.status());
		await Promise.allSettled(clients.flatMap((client) => client?.close() ?? []));
	}

	private describe(message: string, transport: StdioTransport): string {
		// The server's stderr is untrusted text that reaches the terminal and the model: no escape sequences.
		const report = stderrReport(transport);
		if (!report || message.includes(report.tail)) return message;
		const { text: stderr, tail } = report;
		// A stderr that does not fit is saved whole; the error says how much it shows and where the rest is.
		const note =
			tail.length < stderr.length
				? `\n${tailNote("server stderr", tail.length, stderr.length, saveFullOutput(stderr, "mcp-stderr"))}`
				: "";
		return `${message}${note}\n${tail}`;
	}
}
