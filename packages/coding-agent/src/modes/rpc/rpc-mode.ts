/**
 * RPC mode: Headless operation with JSON stdin/stdout protocol.
 *
 * Used for embedding the agent in other applications.
 * Receives commands as JSON on stdin, outputs events and responses as JSON on stdout.
 *
 * Protocol:
 * - Commands: JSON objects with `type` field, optional `id` for correlation
 * - Responses: JSON objects with `type: "response"`, `command`, `success`, and optional `data`/`error`
 * - Events: AgentSessionEvent objects streamed as they occur
 * - Extension UI: Extension UI requests are emitted, client responds with extension_ui_response
 */

import { createToolDisplayAttacher } from "./tool-display.ts";
import { VERSION } from "../../config.ts";
import type { AgentSessionEvent } from "../../core/agent-session.ts";
import type { AgentSessionRuntime } from "../../core/agent-session-runtime.ts";
import {
	flushRawStdout,
	onRawStdoutFailure,
	takeOverStdout,
	waitForRawStdoutBackpressure,
	writeRawStdout,
} from "../../core/output-guard.ts";
import { createEventOutput, waitForEventBackpressure } from "../event-output.ts";
import { headlessCommandActions } from "../headless-actions.ts";
import { handleTerminationSignals } from "../termination-signals.ts";
import { createEventLines } from "../event-lines.ts";
import { toJsonEvent } from "../json-event.ts";
import { toLeanJsonEvent } from "../json-event-lean.ts";
import { attachJsonlLineReader, serializeJsonLine } from "./jsonl.ts";
import { validateRpcCommand } from "./rpc-command-schema.ts";
import { handleCommand as handleRpcCommand, type RpcCommandHost } from "./rpc-mode/commands.ts";
import { error } from "./rpc-mode/responses.ts";
import { RPC_PROTOCOL_VERSION, type RpcReady, type RpcSessionIdentity } from "./session-identity.ts";
import { ACP_WORKER_ENV } from "../../../../common/src/env.ts";
import { createSessionControls } from "./rpc-mode/session-controls.ts";
import { armShutdownDeadline } from "./shutdown-deadline.ts";
import { createExtensionUIContext, type PendingExtensionRequests } from "./rpc-mode/ui-context.ts";
import type { RpcCommand, RpcExtensionUIRequest, RpcExtensionUIResponse, RpcResponse } from "./rpc-types.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";

interface RpcModeOptions {
	/** `--no-dialogs`: no one answers dialogs here, so the session runs with no UI and asks get the headless refusal. */
	noDialogs?: boolean;
	/** `--rpc-ask`: the client declared it answers `ask` requests; only then does the session's UI offer `ask`. */
	rpcAsk?: boolean;
	/** `--rpc-lean-events`: each message and tool result is sent whole once (`json-event-lean.ts`). */
	leanEvents?: boolean;
}

/**
 * Run in RPC mode.
 * Listens for JSON commands on stdin, outputs events and responses on stdout.
 */
export async function runRpcMode(runtimeHost: AgentSessionRuntime, options: RpcModeOptions = {}): Promise<never> {
	takeOverStdout();
	const acpOwnsSession = process.env[ACP_WORKER_ENV] === "1";
	delete process.env[ACP_WORKER_ENV];
	let session = runtimeHost.session;
	let unsubscribe: (() => void) | undefined;
	let unsubscribeBackpressure: (() => void) | undefined;

	const output = (obj: RpcResponse | RpcExtensionUIRequest | object) => {
		writeRawStdout(serializeJsonLine(obj));
	};
	// Lean events repeat no message; the default ones write a large message's serialized text again (`event-lines.ts`).
	const eventLines = createEventLines();
	const outputEvent = createEventOutput<AgentSessionEvent>((event) => {
		if (options.leanEvents) output(toLeanJsonEvent(event));
		else for (const piece of eventLines(toJsonEvent(event))) writeRawStdout(piece);
	});

	// Pending extension UI requests waiting for response
	const pendingExtensionRequests: PendingExtensionRequests = new Map();

	// Shutdown request flag
	let shutdownRequested = false;
	let holdShutdown = false;
	let shuttingDown = false;
	let removeSignalHandlers = (): void => {};
	const initialized = Promise.withResolvers<void>();
	void initialized.promise.catch(() => {});

	runtimeHost.setRebindSession(async () => {
		await rebindSession();
	});

	const rebindSession = async (): Promise<void> => {
		session = runtimeHost.session;
		unsubscribe?.();
		unsubscribeBackpressure?.();
		// Lean events feed a native parent, which renders a child's tools itself: building display blocks there is waste.
		const withDisplay = options.leanEvents
			? (event: AgentSessionEvent) => event
			: createToolDisplayAttacher((name) => session.getToolRenderers(name));
		unsubscribe = session.subscribe((event) => {
			outputEvent(withDisplay(event));
			if (event.type === "agent_settled") {
				void checkShutdownRequested();
			}
		});
		unsubscribeBackpressure = session.agent.subscribe(waitForEventBackpressure);
		await session.bindExtensions({
			uiContext: options.noDialogs
				? undefined
				: createExtensionUIContext(output, pendingExtensionRequests, { ask: options.rpcAsk === true }),
			mode: "rpc",
			commandContextActions: {
				...headlessCommandActions(() => session),
				...createSessionControls(runtimeHost, acpOwnsSession),
			},
			shutdownHandler: () => {
				shutdownRequested = true;
			},
			onError: (err) => {
				output({ type: "extension_error", extensionPath: err.extensionPath, event: err.event, error: err.error });
			},
		});
	};

	const commandHost: RpcCommandHost = {
		get session() {
			return session;
		},
		runtimeHost,
		output,
	};
	const handleCommand = (command: RpcCommand): Promise<RpcResponse | undefined> =>
		handleRpcCommand(commandHost, command);

	/**
	 * Check if shutdown was requested and perform shutdown if so.
	 * Called after handling each command when waiting for the next command.
	 */
	let detachInput = () => {};

	async function shutdown(exitCode = 0, signal?: NodeJS.Signals): Promise<never> {
		if (shuttingDown) {
			process.exit(exitCode);
		}
		shuttingDown = true;
		// A hung dispose (git, an MCP close, a bash job drain) must not outlive a coordinator that is gone.
		armShutdownDeadline(exitCode);
		initialized.reject(new Error("RPC session closed during startup."));
		for (const [id, request] of pendingExtensionRequests)
			request.resolve({ type: "extension_ui_response", id, cancelled: true });
		pendingExtensionRequests.clear();
		// Keep signal cleanup active while disposal waits: a parent-gone signal or second signal must still reap children.
		unsubscribe?.();
		unsubscribeBackpressure?.();
		// Every caller voids this promise: a failed dispose or flush must still detach and exit with a status, not end the
		// process as an unhandled rejection.
		let status = exitCode;
		try {
			await runtimeHost.dispose();
		} catch (disposeError) {
			process.stderr.write(`octocode: session cleanup failed: ${errorMessage(disposeError)}\n`);
			status ||= 1;
		}
		detachInput();
		process.stdin.pause();
		if (signal !== "SIGTERM") {
			await flushRawStdout().catch(() => undefined);
		}
		removeSignalHandlers();
		process.exit(status);
	}

	async function checkShutdownRequested(): Promise<void> {
		if (!shutdownRequested || holdShutdown) return;
		await shutdown();
	}

	const handleInputLine = async (line: string) => {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch (parseError: unknown) {
			output(error(undefined, "parse", `Failed to parse command: ${errorMessage(parseError)}`));
			await waitForRawStdoutBackpressure();
			return;
		}

		if (typeof parsed === "object" && parsed !== null && "type" in parsed && parsed.type === "extension_ui_response") {
			const response = parsed as RpcExtensionUIResponse;
			const pending = pendingExtensionRequests.get(response.id);
			if (pending) {
				pendingExtensionRequests.delete(response.id);
				pending.resolve(response);
			}
			return;
		}

		const validation = validateRpcCommand(parsed);
		if (!validation.ok) {
			output(error(validation.id, validation.commandType, validation.message));
			await waitForRawStdoutBackpressure();
			return;
		}
		const command = parsed as RpcCommand;
		// Latch before yielding: abort may settle a run whose extension already requested exit.
		if (command.type === "abort" && command.holdShutdown) holdShutdown = true;
		try {
			if (!acpOwnsSession || command.type !== "abort") await initialized.promise;
			if (shuttingDown) return;
			if (holdShutdown && command.type !== "abort")
				throw new Error("RPC shutdown preparation is terminal; close stdin to finish shutdown.");
			const response = await handleCommand(command);
			if (response) {
				output(response);
				await waitForRawStdoutBackpressure();
			}
			await checkShutdownRequested();
		} catch (commandError: unknown) {
			output(error(command.id, command.type, errorMessage(commandError)));
			await waitForRawStdoutBackpressure();
		}
	};

	const onInputEnd = () => {
		void shutdown();
	};
	process.stdin.on("end", onInputEnd);

	detachInput = (() => {
		const detachJsonl = attachJsonlLineReader(process.stdin, (line) => {
			void handleInputLine(line);
		});
		return () => {
			detachJsonl();
			process.stdin.off("end", onInputEnd);
		};
	})();

	removeSignalHandlers = handleTerminationSignals((signal, signalExitCode) => {
		void shutdown(signalExitCode, signal);
	});
	// The driver went away: release the session and exit. `shutdown` itself forces an exit when called twice, and a
	// failed write reports on every record still queued, so only the first failure may start it.
	onRawStdoutFailure((failure) => {
		if (shuttingDown) return;
		process.stderr.write(`octocode: stopping, stdout failed: ${failure.message}\n`);
		void shutdown(1);
	});
	output({
		type: "rpc_ready",
		protocolVersion: RPC_PROTOCOL_VERSION,
		version: VERSION,
		sessionId: session.sessionId,
	} satisfies RpcReady);
	if (acpOwnsSession)
		output({ type: "rpc_session_identity", sessionId: session.sessionId } satisfies RpcSessionIdentity);
	try {
		await rebindSession();
		initialized.resolve();
	} catch (error) {
		initialized.reject(error);
		throw error;
	}

	return new Promise(() => {});
}
