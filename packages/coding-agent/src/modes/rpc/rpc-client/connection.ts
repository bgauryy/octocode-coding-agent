import { type ChildProcess, spawn } from "node:child_process";
import type { JsonAgentSessionEvent } from "../../json-event.ts";
import { attachJsonlLineReader, serializeJsonLine } from "../jsonl.ts";
import type { RpcCommand, RpcExtensionUIRequest, RpcExtensionUIResponse, RpcResponse } from "../rpc-types.ts";
import type { RpcClientOptions, RpcCommandBody, RpcEventListener } from "./types.ts";

/**
 * The agent process behind an RpcClient: spawns it, reads its JSONL output, dispatches events and
 * UI requests, and correlates command responses by id.
 */
export class RpcConnection {
	private process: ChildProcess | null = null;
	private stopReadingStdout: (() => void) | null = null;
	private eventListeners: RpcEventListener[] = [];
	private extensionUIListeners: Array<(request: RpcExtensionUIRequest) => void> = [];
	private pendingRequests: Map<string, { resolve: (response: RpcResponse) => void; reject: (error: Error) => void }> =
		new Map();
	private requestId = 0;
	private stderr = "";
	private exitError: Error | null = null;
	private options: RpcClientOptions;

	constructor(options: RpcClientOptions) {
		this.options = options;
	}

	/**
	 * Start the RPC agent process.
	 */
	async start(): Promise<void> {
		if (this.process) {
			throw new Error("Client already started");
		}

		this.exitError = null;

		const cliPath = this.options.cliPath ?? "dist/cli.js";
		const args = ["--mode", "rpc"];

		if (this.options.provider) {
			args.push("--provider", this.options.provider);
		}
		if (this.options.model) {
			args.push("--model", this.options.model);
		}
		if (this.options.args) {
			args.push(...this.options.args);
		}

		const childProcess = spawn("node", [cliPath, ...args], {
			cwd: this.options.cwd,
			env: { ...process.env, ...this.options.env },
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.process = childProcess;

		// Collect stderr for debugging
		childProcess.stderr?.on("data", (data) => {
			this.stderr += data.toString();
			process.stderr.write(data);
		});

		childProcess.once("exit", (code, signal) => {
			if (this.process !== childProcess) return;
			const error = this.createProcessExitError(code, signal);
			this.exitError = error;
			this.rejectPendingRequests(error);
		});
		childProcess.once("error", (error) => {
			if (this.process !== childProcess) return;
			const processError = new Error(`Agent process error: ${error.message}. Stderr: ${this.stderr}`);
			this.exitError = processError;
			this.rejectPendingRequests(processError);
		});
		childProcess.stdin?.on("error", (error) => {
			if (this.process !== childProcess) return;
			const stdinError =
				this.exitError ?? new Error(`Agent process stdin error: ${error.message}. Stderr: ${this.stderr}`);
			this.exitError = stdinError;
			this.rejectPendingRequests(stdinError);
		});

		// Set up strict JSONL reader for stdout.
		this.stopReadingStdout = attachJsonlLineReader(childProcess.stdout, (line) => {
			this.handleLine(line);
		});

		// Wait a moment for process to initialize
		await new Promise((resolve) => setTimeout(resolve, 100));

		if (this.process.exitCode !== null) {
			const error = this.exitError ?? this.createProcessExitError(this.process.exitCode, this.process.signalCode);
			this.exitError = error;
			throw error;
		}
	}

	/**
	 * Stop the RPC agent process.
	 */
	async stop(): Promise<void> {
		if (!this.process) return;

		this.stopReadingStdout?.();
		this.stopReadingStdout = null;
		this.process.kill("SIGTERM");

		// Wait for process to exit
		await new Promise<void>((resolve) => {
			const timeout = setTimeout(() => {
				this.process?.kill("SIGKILL");
				resolve();
			}, 1000);

			this.process?.on("exit", () => {
				clearTimeout(timeout);
				resolve();
			});
		});

		this.process = null;
		this.pendingRequests.clear();
	}

	/**
	 * Subscribe to agent events.
	 */
	onEvent(listener: RpcEventListener): () => void {
		this.eventListeners.push(listener);
		return () => {
			const index = this.eventListeners.indexOf(listener);
			if (index !== -1) {
				this.eventListeners.splice(index, 1);
			}
		};
	}

	/** Subscribe to UI requests separately from session events. */
	onExtensionUIRequest(listener: (request: RpcExtensionUIRequest) => void): () => void {
		this.extensionUIListeners.push(listener);
		return () => {
			const index = this.extensionUIListeners.indexOf(listener);
			if (index !== -1) this.extensionUIListeners.splice(index, 1);
		};
	}

	/** Reply using the request's id. UI replies have no RPC acknowledgement. */
	async respondToExtensionUIRequest(response: RpcExtensionUIResponse): Promise<void> {
		const stdin = this.getWritableStdin();
		await new Promise<void>((resolve, reject) => {
			stdin.write(serializeJsonLine(response), (error) => {
				if (error) reject(error);
				else resolve();
			});
		});
	}

	/**
	 * Get collected stderr output (useful for debugging).
	 */
	getStderr(): string {
		return this.stderr;
	}

	/**
	 * Wait for agent to become idle (no streaming).
	 * Resolves when agent_settled event is received.
	 */
	waitForIdle(timeout = 60000): Promise<void> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				unsubscribe();
				reject(new Error(`Timeout waiting for agent to become idle. Stderr: ${this.stderr}`));
			}, timeout);

			const unsubscribe = this.onEvent((event) => {
				if (event.type === "agent_settled") {
					clearTimeout(timer);
					unsubscribe();
					resolve();
				}
			});
		});
	}

	/**
	 * Collect events until agent becomes idle.
	 */
	collectEvents(timeout = 60000): Promise<JsonAgentSessionEvent[]> {
		return new Promise((resolve, reject) => {
			const events: JsonAgentSessionEvent[] = [];
			const timer = setTimeout(() => {
				unsubscribe();
				reject(new Error(`Timeout collecting events. Stderr: ${this.stderr}`));
			}, timeout);

			const unsubscribe = this.onEvent((event) => {
				events.push(event);
				if (event.type === "agent_settled") {
					clearTimeout(timer);
					unsubscribe();
					resolve(events);
				}
			});
		});
	}

	private handleLine(line: string): void {
		try {
			const data = JSON.parse(line);
			if (typeof data !== "object" || data === null || typeof data.type !== "string") return;
			if (data.type === "extension_ui_request") {
				// oxlint-disable-next-line unicorn/no-useless-spread -- snapshot so listeners that unsubscribe during dispatch do not change iteration
				for (const listener of [...this.extensionUIListeners]) {
					listener(data as RpcExtensionUIRequest);
				}
				return;
			}

			// Check if it's a response to a pending request
			if (data.type === "response" && data.id && this.pendingRequests.has(data.id)) {
				const pending = this.pendingRequests.get(data.id)!;
				this.pendingRequests.delete(data.id);
				pending.resolve(data as RpcResponse);
				return;
			}
			if (data.type === "response") return;

			// Otherwise it's an event. Iterate a snapshot so listeners that unsubscribe during dispatch
			// do not cause later listeners to miss this event.
			// oxlint-disable-next-line unicorn/no-useless-spread -- the snapshot described above
			for (const listener of [...this.eventListeners]) {
				listener(data as JsonAgentSessionEvent);
			}
		} catch {
			// Ignore non-JSON lines
		}
	}

	private createProcessExitError(code: number | null, signal: NodeJS.Signals | null): Error {
		return new Error(`Agent process exited (code=${code} signal=${signal}). Stderr: ${this.stderr}`);
	}

	private rejectPendingRequests(error: Error): void {
		for (const pending of this.pendingRequests.values()) {
			pending.reject(error);
		}
		this.pendingRequests.clear();
	}

	private getWritableStdin() {
		const childProcess = this.process;
		const stdin = childProcess?.stdin;
		if (!childProcess || !stdin) {
			throw new Error("Client not started");
		}
		if (this.exitError) {
			throw this.exitError;
		}
		if (childProcess.exitCode !== null) {
			const error = this.createProcessExitError(childProcess.exitCode, childProcess.signalCode);
			this.exitError = error;
			throw error;
		}
		if (stdin.destroyed || !stdin.writable) {
			const error = new Error(`Agent process stdin is not writable. Stderr: ${this.stderr}`);
			this.exitError = error;
			throw error;
		}
		return stdin;
	}

	/**
	 * Send a command and wait for its response. `timeoutMs` bounds short requests; commands that answer only after their
	 * work finishes (compact, bash) pass `null` and wait, since the process exiting still rejects them.
	 */
	async send(command: RpcCommandBody, timeoutMs: number | null = 30_000): Promise<RpcResponse> {
		const stdin = this.getWritableStdin();
		const id = `req_${++this.requestId}`;
		const fullCommand = { ...command, id } as RpcCommand;

		return new Promise((resolve, reject) => {
			const timeout =
				timeoutMs === null
					? undefined
					: setTimeout(() => {
							this.pendingRequests.delete(id);
							reject(new Error(`Timeout waiting for response to ${command.type}. Stderr: ${this.stderr}`));
						}, timeoutMs);

			this.pendingRequests.set(id, {
				resolve: (response) => {
					clearTimeout(timeout);
					resolve(response);
				},
				reject: (error) => {
					clearTimeout(timeout);
					reject(error);
				},
			});

			try {
				stdin.write(serializeJsonLine(fullCommand));
			} catch (error: unknown) {
				const writeError = error instanceof Error ? error : new Error(String(error));
				const pending = this.pendingRequests.get(id);
				this.pendingRequests.delete(id);
				pending?.reject(writeError);
			}
		});
	}
}
