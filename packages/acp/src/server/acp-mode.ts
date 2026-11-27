import { Readable } from "node:stream";
import { resolve } from "node:path";
import { ndJsonStream } from "@agentclientprotocol/sdk";
import { ACP_WORKER_ENV } from "@octocodeai/octocode-common/env";
import { normalizePath } from "@octocodeai/octocode-common/paths";
import type { AcpLaunchOptions, AcpServerHost } from "../host.ts";
import { AcpBroker, type AcpWorker } from "./broker.ts";
import { prepareAcpMcpServers } from "./mcp.ts";

/** The command line asks ACP for something it does not do: a refusal for the person, not a fault. */
export class AcpUsageError extends Error {
	override readonly name = "AcpUsageError";
}

/** ACP owns stdin and session selection; normal runtime options belong to its workers. */
export function acpWorkerArguments(args: string[], parsed: AcpLaunchOptions): string[] {
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
		throw new AcpUsageError(
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
export async function runAcpMode(host: AcpServerHost, workerArgs: string[]): Promise<void> {
	host.stdout.takeOver();
	const sessionDirIndex = workerArgs.lastIndexOf("--session-dir");
	const launchDirectory = process.cwd();
	const cliSessionDir = sessionDirIndex >= 0 ? workerArgs[sessionDirIndex + 1] : undefined;
	const envSessionDir = process.env[host.sessionDirEnv];
	const sharedSessionDir = cliSessionDir ?? envSessionDir;
	const absoluteSessionDir = sharedSessionDir ? resolve(launchDirectory, normalizePath(sharedSessionDir)) : undefined;
	const sessionArgs = [...workerArgs];
	if (cliSessionDir && absoluteSessionDir) sessionArgs[sessionDirIndex + 1] = absoluteSessionDir;
	const broker = new AcpBroker({
		host,
		sessionDir: absoluteSessionDir,
		createWorker: async (cwd, servers, sessionPath): Promise<AcpWorker> => {
			if (servers.length && workerArgs.includes("--no-mcp"))
				throw new Error("Client MCP servers cannot be used with --no-mcp.");
			const mcp = await prepareAcpMcpServers(servers, cwd, host);
			const identityListeners = new Set<(id: string) => void>();
			let client: ReturnType<AcpServerHost["createWorker"]>;
			try {
				client = host.createWorker({
					onSessionIdentity: (id) => {
						for (const listener of identityListeners) listener(id);
					},
					cwd,
					args: [...sessionArgs, ...(sessionPath ? ["--session", sessionPath] : [])],
					env: {
						[ACP_WORKER_ENV]: "1",
						...mcp.env,
						...(envSessionDir && !cliSessionDir && absoluteSessionDir
							? { [host.sessionDirEnv]: absoluteSessionDir }
							: {}),
					},
				});
			} catch (error) {
				// The creation error is the one to report.
				await mcp.cleanup().catch(() => undefined);
				throw error;
			}
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
				getCommands: () => client.getCommands(),
				getModels: () => client.getModels(),
				setModel: (model) => client.setModel(model),
			};
		},
	});
	let outputFailed = false;
	const output = new WritableStream<Uint8Array>({
		write: async (chunk) => {
			try {
				await host.stdout.write(Buffer.from(chunk).toString("utf8"));
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
	let stdoutStalled = false;
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
			// The client that disconnected may have closed its end too: a record still queued for it (a closing
			// session's update) then fails with EPIPE. Nobody is left to read it, so it ends nothing but the wait.
			// A reader that stays open but stops reading never completes the write, so the wait has a deadline.
			if (!outputFailed && !(await flushWithin(host.stdout.flush(), STDOUT_FLUSH_MS))) stdoutStalled = true;
		} finally {
			for (const [signal, handler] of handlers) process.off(signal, handler);
			process.stdout.off("error", stopAfterOutputFailure);
			process.stdin.pause();
			// The unwritten output keeps the stdout handle, and so the process, alive: nobody is reading it.
			if (stdoutStalled) process.exit(process.exitCode ?? 0);
		}
	}
}

const STDOUT_FLUSH_MS = 3_000;

/** Whether the flush ended (successfully or not) before the deadline. */
async function flushWithin(flush: Promise<void>, ms: number): Promise<boolean> {
	let timer: NodeJS.Timeout | undefined;
	const deadline = new Promise<boolean>((resolve) => {
		timer = setTimeout(() => resolve(false), ms);
	});
	try {
		return await Promise.race([
			flush.then(
				() => true,
				() => true,
			),
			deadline,
		]);
	} finally {
		clearTimeout(timer);
	}
}
