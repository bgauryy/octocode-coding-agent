/**
 * Print mode (single-shot): Send prompts, output result, exit.
 *
 * Used for:
 * - `octocode -p "prompt"` - text output
 * - `octocode --mode json "prompt"` - JSON event stream
 */

import type { AssistantMessage, ImageContent } from "@octocodeai/octocode-ai";
import type { AgentSessionEvent, RunOutcome } from "../core/agent-session.ts";
import type { AgentSessionRuntime } from "../core/agent-session-runtime.ts";
import { flushRawStdout, onRawStdoutFailure, writeRawStdout } from "../core/output-guard.ts";
import { createEventOutput, waitForEventBackpressure } from "./event-output.ts";
import { headlessCommandActions } from "./headless-actions.ts";
import { createEventLines } from "./event-lines.ts";
import { toJsonEvent } from "./json-event.ts";
import { handleTerminationSignals } from "./termination-signals.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";

/**
 * Options for print mode.
 */
export interface PrintModeOptions {
	/** Output mode: "text" for final response only, "json" for all events */
	mode: "text" | "json";
	/** Array of additional prompts to send after initialMessage */
	messages?: string[];
	/** First message to send (may contain @file content) */
	initialMessage?: string;
	/** Images to attach to the initial message */
	initialImages?: ImageContent[];
}

/**
 * Run in print (single-shot) mode.
 * Sends prompts to the agent and outputs the result.
 */
export async function runPrintMode(runtimeHost: AgentSessionRuntime, options: PrintModeOptions): Promise<number> {
	const { mode, messages = [], initialMessage, initialImages } = options;
	let exitCode = 0;
	let session = runtimeHost.session;
	let unsubscribe: (() => void) | undefined;
	let unsubscribeBackpressure: (() => void) | undefined;
	let disposing: Promise<void> | undefined;
	const eventLines = createEventLines();
	const writeEvent = createEventOutput<AgentSessionEvent>((event) => {
		for (const piece of eventLines(toJsonEvent(event))) writeRawStdout(piece);
	});

	const disposeRuntime = (): Promise<void> => {
		disposing ??= (async () => {
			unsubscribe?.();
			unsubscribeBackpressure?.();
			await runtimeHost.dispose();
		})();
		return disposing;
	};

	const removeSignalHandlers = handleTerminationSignals((_signal, signalExitCode) => {
		// A shutdown is already running and the user asks again: that is the way out of one that does not finish.
		if (disposing) process.exit(signalExitCode);
		void disposeRuntime().finally(() => {
			process.exit(signalExitCode);
		});
	});

	// The reader of a run's output went away: release the session as a signal does, and report the failure.
	let stdoutFailed = false;
	const removeStdoutFailureHandler = onRawStdoutFailure((error) => {
		if (stdoutFailed) return;
		stdoutFailed = true;
		console.error(`octocode: stopping, stdout failed: ${error.message}`);
		void disposeRuntime().finally(() => {
			process.exit(1);
		});
	});

	runtimeHost.setRebindSession(async () => {
		await rebindSession();
	});

	const rebindSession = async (): Promise<void> => {
		session = runtimeHost.session;
		await session.bindExtensions({
			mode: mode === "json" ? "json" : "print",
			commandContextActions: {
				...headlessCommandActions(() => session),
				newSession: async (newSessionOptions) => runtimeHost.newSession(newSessionOptions),
				fork: async (entryId, forkOptions) => {
					const result = await runtimeHost.fork(entryId, forkOptions);
					return { cancelled: result.cancelled };
				},
				switchSession: async (sessionPath, switchOptions) => {
					return runtimeHost.switchSession(sessionPath, switchOptions);
				},
			},
			onError: (err) => {
				// A command that failed is what this run was asked to do; a feature's handler failing on an event fails open.
				if (err.event === "command") {
					exitCode = 1;
					console.error(`Command ${err.extensionPath.replace(/^command:/, "/")} failed: ${err.error}`);
				} else console.error(`Feature error (${err.extensionPath}): ${err.error}`);
			},
		});

		unsubscribe?.();
		unsubscribeBackpressure?.();
		unsubscribe = session.subscribe((event) => {
			if (mode === "json") writeEvent(event);
			else if (event.type === "auto_retry_start") {
				// Text mode prints nothing until the end, so a long provider wait would look like a hang.
				const { attempt, maxAttempts, delayMs, errorMessage: reason } = event;
				const why = reason.replace(/\s+/g, " ");
				console.error(`Retrying in ${Math.ceil(delayMs / 1000)}s (attempt ${attempt} of ${maxAttempts}): ${why}`);
			}
		});
		unsubscribeBackpressure = mode === "json" ? session.agent.subscribe(waitForEventBackpressure) : undefined;
	};

	try {
		if (mode === "json") {
			const header = session.sessionManager.getHeader();
			if (header) {
				writeRawStdout(`${JSON.stringify(header)}\n`);
			}
		}

		await rebindSession();

		// Any prompt that did not complete fails the run, in either mode; text mode also reports it on stderr. The verdict
		// comes from the run's recorded outcome: the context cannot give it, since recovery removes failed attempts.
		const lastAssistant = (): AssistantMessage | undefined => {
			// What the session recorded after the answer (a job stopped at run end) is not the answer.
			const last = session.state.messages.findLast((message) => message.role !== "custom");
			return last?.role === "assistant" ? last : undefined;
		};
		const reason = (outcome: RunOutcome): string =>
			outcome.status === "truncated"
				? outcome.errorMessage || "Response was truncated: the model reached its output token limit."
				: outcome.errorMessage || `Request ${outcome.stopReason ?? outcome.status}`;
		const reported = new WeakSet<RunOutcome>();
		const report = (outcome: RunOutcome | undefined, show: boolean): void => {
			if (!outcome || outcome.status === "completed") return;
			exitCode = 1;
			if (show && !reported.has(outcome)) {
				reported.add(outcome);
				console.error(reason(outcome));
			}
		};
		const prompts: Array<() => Promise<void>> = [
			...(initialMessage ? [() => session.prompt(initialMessage, { images: initialImages })] : []),
			...messages.map((message) => () => session.prompt(message)),
		];
		for (const [index, run] of prompts.entries()) {
			await run();
			await session.settled();
			if (session.lastRunOutcome?.warning) console.error(`Warning: ${session.lastRunOutcome.warning}`);
			report(session.lastRunOutcome, mode === "text" && index < prompts.length - 1);
		}

		if (mode === "text") {
			const outcome = session.lastRunOutcome;
			if (outcome?.status === "failed" || outcome?.status === "aborted") {
				report(outcome, true);
			} else {
				for (const content of lastAssistant()?.content ?? []) {
					if (content.type === "text") writeRawStdout(`${content.text}\n`);
				}
				report(outcome, true);
			}
		}

		return exitCode;
	} catch (error: unknown) {
		console.error(errorMessage(error));
		return 1;
	} finally {
		removeSignalHandlers();
		await disposeRuntime();
		await flushRawStdout();
		removeStdoutFailureHandler();
	}
}
