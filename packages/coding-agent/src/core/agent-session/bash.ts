/** User bash commands run by the session (`!` and `!!`), recorded in session history. */

import { randomUUID } from "node:crypto";
import { sessionOutputDir, withSessionStorage } from "../../storage/runtime-paths.ts";
import { DISPLAY_OUTPUT_MAX_BYTES, outputFileReadable } from "../../utils/output-files.ts";
import { type BashResult, executeBashWithOperations } from "../bash-executor.ts";
import type { BashExecutionMessage } from "../messages.ts";
import { BASH_UPDATE_THROTTLE_MS, type BashOperations, createLocalBashOperations } from "../tools/bash.ts";
import type { SessionInternals } from "./host.ts";

export interface BashHost extends Pick<SessionInternals, "session" | "emit" | "refreshContext"> {
	/** The session's `recordBashResult()`, which callers may observe. */
	recordBashResult(command: string, result: BashResult, options?: { excludeFromContext?: boolean }): void;
}

export class SessionBash {
	private readonly _abortControllers = new Set<AbortController>();
	private readonly idleWaiters = new Set<() => void>();
	private _pendingMessages: BashExecutionMessage[] = [];

	private readonly host: BashHost;

	constructor(host: BashHost) {
		this.host = host;
	}

	async execute(
		command: string,
		onChunk?: (chunk: string) => void,
		options?: {
			excludeFromContext?: boolean;
			id?: string;
			operations?: BashOperations;
		},
	): Promise<BashResult> {
		const { session } = this.host;
		const executionId = options?.id ?? randomUUID();
		const abortController = new AbortController();
		this._abortControllers.add(abortController);

		// Apply command prefix if configured (e.g., "shopt -s expand_aliases" for alias support)
		const prefix = session.settingsManager.getShellCommandPrefix();
		const shellPath = session.settingsManager.getShellPath();
		const resolvedCommand = prefix ? `${prefix}\n${command}` : command;

		// At most one `bash_execution_update` per `BASH_UPDATE_THROTTLE_MS`, as the bash tool paces its own updates: every
		// event makes its listeners copy their state, and a chatty command prints thousands of chunks a second. Deltas
		// wait in `pending` and leave as one; what is left leaves when the command ends, before its result is recorded.
		let pending = "";
		let lastUpdateAt = 0;
		let updateTimer: NodeJS.Timeout | undefined;
		const flushUpdate = (): void => {
			if (updateTimer) clearTimeout(updateTimer);
			updateTimer = undefined;
			if (!pending) return;
			const delta = pending;
			pending = "";
			lastUpdateAt = Date.now();
			this.host.emit({ type: "bash_execution_update", id: executionId, delta });
		};

		try {
			const result = await withSessionStorage(session.sessionManager, () =>
				executeBashWithOperations(
					resolvedCommand,
					session.sessionManager.getCwd(),
					options?.operations ?? createLocalBashOperations({ shellPath, unsandboxed: true }),
					{
						onChunk: (delta) => {
							onChunk?.(delta);
							pending += delta;
							const wait = BASH_UPDATE_THROTTLE_MS - (Date.now() - lastUpdateAt);
							if (wait <= 0) flushUpdate();
							else updateTimer ??= setTimeout(flushUpdate, wait);
						},
						signal: abortController.signal,
						maxOutputBytes: session.settingsManager.getBashOutputMaxBytes(),
						spillMaxBytes: session.settingsManager.getBashSpillMaxBytes(),
						outputDir: sessionOutputDir("bash"),
					},
				),
			);

			flushUpdate();
			this.host.recordBashResult(command, result, options);
			return result;
		} finally {
			// A command that failed or was aborted still delivers what it printed last.
			flushUpdate();
			this._abortControllers.delete(abortController);
			if (!this.isRunning) {
				for (const done of this.idleWaiters) done();
				this.idleWaiters.clear();
			}
		}
	}

	record(command: string, result: BashResult, options?: { excludeFromContext?: boolean }): void {
		const bashMessage: BashExecutionMessage = {
			role: "bashExecution",
			command,
			output: result.output,
			exitCode: result.exitCode,
			cancelled: result.cancelled,
			truncated: result.truncated,
			fullOutputPath: result.fullOutputPath,
			header: result.header,
			timestamp: Date.now(),
			excludeFromContext: options?.excludeFromContext,
		};
		if (result.truncated) {
			// The record keeps the spill's path, not a copy: up to 32 MiB per command would go to the JSONL, the database mirror
			// and memory for the life of the session, and only a view ever reads it (`application/normalize.ts`).
			try {
				if (!result.fullOutputPath || !outputFileReadable(result.fullOutputPath, DISPLAY_OUTPUT_MAX_BYTES))
					bashMessage.fullOutputUnavailable = "Full shell output is unavailable; the displayed output is truncated";
			} catch (error) {
				bashMessage.fullOutputUnavailable =
					error instanceof Error ? error.message : "Full shell output could not be retained";
			}
		}

		// If agent is streaming, defer adding to avoid breaking tool_use/tool_result ordering
		if (this.host.session.isStreaming) {
			// Queue for later - will be flushed on agent_end
			this._pendingMessages.push(bashMessage);
		} else {
			this.host.session.sessionManager.appendMessage(bashMessage);
			this.host.refreshContext();
		}
	}

	async abortAndWait(): Promise<void> {
		this.abort();
		if (!this.isRunning) return;
		await new Promise<void>((resolve) => this.idleWaiters.add(resolve));
	}

	abort(): void {
		for (const abortController of this._abortControllers) {
			abortController.abort();
		}
	}

	get isRunning(): boolean {
		return this._abortControllers.size > 0;
	}

	get hasPendingMessages(): boolean {
		return this._pendingMessages.length > 0;
	}

	/**
	 * Flush pending bash messages to agent state and session.
	 * Called after agent turn completes to maintain proper message ordering.
	 */
	flushPending(): void {
		if (this._pendingMessages.length === 0) return;

		try {
			// Written ones leave the queue one by one, so a failure part way cannot append them twice on the next flush.
			while (this._pendingMessages.length > 0) {
				this.host.session.sessionManager.appendMessage(this._pendingMessages[0]);
				this._pendingMessages.shift();
			}
		} finally {
			this.host.refreshContext();
		}
	}
}
