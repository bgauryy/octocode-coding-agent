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

import type { AgentSessionRuntime } from "../../core/agent-session-runtime.ts";
import {
	flushRawStdout,
	takeOverStdout,
	waitForRawStdoutBackpressure,
	writeRawStdout,
} from "../../core/output-guard.ts";
import { handleTerminationSignals } from "../termination-signals.ts";
import { toJsonEvent } from "../json-event.ts";
import { attachJsonlLineReader, serializeJsonLine } from "./jsonl.ts";
import { validateRpcCommand } from "./rpc-command-schema.ts";
import { handleCommand as handleRpcCommand, type RpcCommandHost } from "./rpc-mode/commands.ts";
import { error } from "./rpc-mode/responses.ts";
import type { RpcSessionIdentity } from "./session-identity.ts";
import { ACP_WORKER_ENV } from "../../../../common/src/env.ts";
import { createSessionControls } from "./rpc-mode/session-controls.ts";
import { createExtensionUIContext, type PendingExtensionRequests } from "./rpc-mode/ui-context.ts";
import type { RpcCommand, RpcExtensionUIRequest, RpcExtensionUIResponse, RpcResponse } from "./rpc-types.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";

/**
 * Run in RPC mode.
 * Listens for JSON commands on stdin, outputs events and responses on stdout.
 */
export async function runRpcMode(runtimeHost: AgentSessionRuntime): Promise<never> {
	takeOverStdout();
	const acpOwnsSession = process.env[ACP_WORKER_ENV] === "1";
	delete process.env[ACP_WORKER_ENV];
	let session = runtimeHost.session;
	let unsubscribe: (() => void) | undefined;
	let unsubscribeBackpressure: (() => void) | undefined;

	const output = (obj: RpcResponse | RpcExtensionUIRequest | object) => {
		writeRawStdout(serializeJsonLine(obj));
	};

	// Pending extension UI requests waiting for response
	const pendingExtensionRequests: PendingExtensionRequests = new Map();

	// Shutdown request flag
	let shutdownRequested = false;
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
		unsubscribe = session.subscribe((event) => {
			output(toJsonEvent(event));
			if (event.type === "agent_settled") {
				void checkShutdownRequested();
			}
		});
		unsubscribeBackpressure = session.agent.subscribe(async () => {
			await waitForRawStdoutBackpressure();
		});
		await session.bindExtensions({
			uiContext: createExtensionUIContext(output, pendingExtensionRequests),
			mode: "rpc",
			commandContextActions: {
				waitForIdle: () => session.waitForIdle(),
				...createSessionControls(runtimeHost, acpOwnsSession),
				navigateTree: async (targetId, options) => {
					const result = await session.navigateTree(targetId, {
						summarize: options?.summarize,
						customInstructions: options?.customInstructions,
						replaceInstructions: options?.replaceInstructions,
						label: options?.label,
					});
					return { cancelled: result.cancelled };
				},
				reload: async () => {
					await session.reload();
				},
			},
			shutdownHandler: () => {
				shutdownRequested = true;
			},
			onError: (err) => {
				output({ type: "extension_error", extensionPath: err.extensionPath, event: err.event, error: err.error });
			},
		});
	};

	// Handle a single command
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
		initialized.reject(new Error("RPC session closed during startup."));
		for (const [id, request] of pendingExtensionRequests)
			request.resolve({ type: "extension_ui_response", id, cancelled: true });
		pendingExtensionRequests.clear();
		removeSignalHandlers();
		unsubscribe?.();
		unsubscribeBackpressure?.();
		await runtimeHost.dispose();
		detachInput();
		process.stdin.pause();
		if (signal !== "SIGTERM") {
			await flushRawStdout();
		}
		process.exit(exitCode);
	}

	async function checkShutdownRequested(): Promise<void> {
		if (!shutdownRequested) return;
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

		// Handle extension UI responses
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
		try {
			if (!acpOwnsSession || command.type !== "abort") await initialized.promise;
			if (shuttingDown) return;
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
	if (acpOwnsSession)
		output({ type: "rpc_session_identity", sessionId: session.sessionId } satisfies RpcSessionIdentity);
	try {
		await rebindSession();
		initialized.resolve();
	} catch (error) {
		initialized.reject(error);
		throw error;
	}

	// Keep process alive forever
	return new Promise(() => {});
}
