import { Readable } from "node:stream";
import { resolve } from "node:path";
import { ndJsonStream } from "@agentclientprotocol/sdk";
import type { Args } from "../../../coding-agent/src/cli/args.ts";
import { ENV_SESSION_DIR, getCliInvocation } from "../../../coding-agent/src/config.ts";
import { flushRawStdout, takeOverStdout, writeRawStdoutAsync } from "../../../coding-agent/src/core/output-guard.ts";
import { normalizePath } from "../../../coding-agent/src/utils/paths.ts";
import { RpcClient } from "../../../coding-agent/src/modes/rpc/rpc-client.ts";
import { ACP_WORKER_ENV } from "../../../coding-agent/src/modes/rpc/rpc-mode/session-controls.ts";
import { AcpBroker, type AcpWorker } from "./broker.ts";
import { prepareAcpMcpServers } from "./mcp.ts";

/** ACP owns stdin and session selection; normal runtime options belong to its workers. */
export function acpWorkerArguments(args: string[], parsed: Args): string[] {
	if (
		parsed.messages.length ||
		parsed.fileArgs.length ||
		parsed.print ||
		parsed.continue ||
		parsed.resume ||
		parsed.session ||
		parsed.sessionId ||
		parsed.noSession ||
		parsed.fork ||
		parsed.export ||
		parsed.listModels !== undefined
	) {
		throw new Error(
			"ACP mode receives prompts and new-session requests over stdin; positional prompts, file arguments and session-selection commands are not supported.",
		);
	}
	const result: string[] = [];
	for (let index = 0; index < args.length; index++) {
		if (args[index] === "--mode") {
			index++;
			continue;
		}
		result.push(args[index]);
	}
	return result;
}

/** Expose ACP without starting a native session in the broker process. */
export async function runAcpMode(workerArgs: string[]): Promise<void> {
	takeOverStdout();
	const invocation = getCliInvocation();
	const sessionDirIndex = workerArgs.lastIndexOf("--session-dir");
	const launchDirectory = process.cwd();
	const cliSessionDir = sessionDirIndex >= 0 ? workerArgs[sessionDirIndex + 1] : undefined;
	const envSessionDir = process.env[ENV_SESSION_DIR];
	const sharedSessionDir = cliSessionDir ?? envSessionDir;
	const absoluteSessionDir = sharedSessionDir ? resolve(launchDirectory, normalizePath(sharedSessionDir)) : undefined;
	const sessionArgs = [...workerArgs];
	if (cliSessionDir && absoluteSessionDir) sessionArgs[sessionDirIndex + 1] = absoluteSessionDir;
	const broker = new AcpBroker({
		sessionDir: absoluteSessionDir,
		createWorker: async (cwd, servers, sessionPath): Promise<AcpWorker> => {
			if (servers.length && workerArgs.includes("--no-mcp"))
				throw new Error("Client MCP servers cannot be used with --no-mcp.");
			const mcp = await prepareAcpMcpServers(servers, cwd);
			const identityListeners = new Set<(id: string) => void>();
			const client = new RpcClient({
				onSessionIdentity: (id) => {
					for (const listener of identityListeners) listener(id);
				},
				cwd,
				ownProcessTree: true,
				invocation: { command: invocation.command, args: invocation.prefix },
				args: [...sessionArgs, ...mcp.args, ...(sessionPath ? ["--session", sessionPath] : [])],
				env: {
					[ACP_WORKER_ENV]: "1",
					...(envSessionDir && !cliSessionDir && absoluteSessionDir ? { [ENV_SESSION_DIR]: absoluteSessionDir } : {}),
				},
			});
			return {
				onSessionIdentity: (listener) => {
					identityListeners.add(listener);
					return () => identityListeners.delete(listener);
				},
				start: () => client.start(),
				stop: async () => {
					try {
						await client.stop();
					} finally {
						await mcp.cleanup();
					}
				},
				getState: async () => {
					const state = await client.getState();
					await mcp.verify();
					return state;
				},
				persistSession: () => client.persistSession(),
				prompt: (...args) => client.prompt(...args),
				abort: () => client.abort(),
				onEvent: (listener) => client.onEvent(listener),
				onClose: (listener) => client.onClose(listener),
				onExtensionUIRequest: (listener) => client.onExtensionUIRequest(listener),
				respondToExtensionUIRequest: (response) => client.respondToExtensionUIRequest(response),
			};
		},
	});
	let outputFailed = false;
	const output = new WritableStream<Uint8Array>({
		write: async (chunk) => {
			try {
				await writeRawStdoutAsync(Buffer.from(chunk).toString("utf8"));
			} catch (error) {
				stopAfterOutputFailure();
				throw error;
			}
		},
	});
	const connection = broker.connect(ndJsonStream(output, Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>));
	const stopAfterOutputFailure = () => {
		outputFailed = true;
		process.exitCode ??= 1;
		connection.close();
	};
	// Node emits stream errors separately from write callbacks; both must reach the owned cleanup path.
	process.stdout.on("error", stopAfterOutputFailure);
	const handlers: Array<[NodeJS.Signals, () => void]> = [];
	for (const signal of ["SIGINT", "SIGTERM", ...(process.platform === "win32" ? [] : ["SIGHUP"])] as NodeJS.Signals[]) {
		const handler = () => {
			process.exitCode = signal === "SIGINT" ? 130 : signal === "SIGHUP" ? 129 : 143;
			connection.close();
			void broker.close();
		};
		process.on(signal, handler);
		handlers.push([signal, handler]);
	}
	try {
		await connection.closed;
	} finally {
		try {
			await broker.close();
			if (!outputFailed) await flushRawStdout();
		} finally {
			for (const [signal, handler] of handlers) process.off(signal, handler);
			process.stdout.off("error", stopAfterOutputFailure);
			process.stdin.pause();
		}
	}
}
