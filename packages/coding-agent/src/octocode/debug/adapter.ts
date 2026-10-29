import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { connect, type Socket } from "node:net";
import { DapProtocol, stopProcess } from "./protocol.ts";

const LISTEN_MS = 10_000;
const MAX_BANNER = 8_000;
/** The address a TCP adapter prints when it is ready, e.g. js-debug's "Debug server listening at 127.0.0.1:53817". Loopback only. */
const LISTENING = /listening[^\r\n]*?(127\.0\.0\.1|localhost|\[::1\]):(\d{1,5})\b/i;

export interface AdapterInput {
	adapter: string;
	adapterArgs?: string[];
	cwd: string;
	/** The adapter is a server: connect to the loopback address it prints instead of speaking over its stdio. */
	tcp?: boolean;
}

export interface AdapterLink {
	root: DapProtocol;
	/** Opens another connection to the same server, for `startDebugging` child sessions (TCP adapters only). */
	connect?: () => Promise<DapProtocol>;
	/** The server process of a TCP adapter; a stdio adapter's process belongs to its connection. */
	server?: ChildProcessWithoutNullStreams;
}

/** Starts the adapter the caller named; `onLog` receives its stderr (and a server's stdout after its banner). */
export async function openAdapter(
	input: AdapterInput,
	onLog: (text: string) => void,
	signal?: AbortSignal,
): Promise<AdapterLink> {
	if (!input.adapter || !input.adapter.trim() || input.adapter.includes("\0"))
		throw new Error("Explicit adapter executable required");
	const child = spawn(input.adapter, input.adapterArgs ?? [], {
		cwd: input.cwd,
		stdio: "pipe",
		shell: false,
		windowsHide: true,
	});
	const log = (chunk: Buffer) => onLog(chunk.toString("utf8"));
	if (!input.tcp) {
		child.stderr.on("data", log);
		return { root: new DapProtocol(child) };
	}
	try {
		const { host, port } = await listening(child, signal);
		child.stdout.on("data", log);
		child.stderr.on("data", log);
		const open = (abort?: AbortSignal) => socketTo(host, port, abort).then((socket) => new DapProtocol(socket));
		return { root: await open(signal), connect: () => open(), server: child };
	} catch (error) {
		stopProcess(child);
		throw error;
	}
}

function listening(
	child: ChildProcessWithoutNullStreams,
	signal?: AbortSignal,
): Promise<{ host: string; port: number }> {
	return new Promise((resolve, reject) => {
		let banner = "";
		const finish = (result: { host: string; port: number } | Error) => {
			clearTimeout(timer);
			child.stdout.off("data", read);
			child.stderr.off("data", read);
			child.off("exit", exited);
			child.off("error", finish);
			signal?.removeEventListener("abort", aborted);
			if (result instanceof Error) reject(result);
			else resolve(result);
		};
		const read = (chunk: Buffer) => {
			banner = (banner + chunk.toString("utf8")).slice(-MAX_BANNER);
			const match = LISTENING.exec(banner);
			if (!match) return;
			const port = Number(match[2]);
			if (port < 1 || port > 65_535) return finish(new Error(`TCP adapter printed an invalid port: ${match[2]}`));
			finish({ host: match[1] === "[::1]" ? "::1" : match[1], port });
		};
		const exited = (code: number | null) =>
			finish(
				new Error(`TCP adapter exited (${code}) before printing a loopback listening address: ${banner.slice(-500)}`),
			);
		const aborted = () => finish(new Error("DAP launch aborted"));
		const timer = setTimeout(
			() =>
				finish(
					new Error(
						`TCP adapter printed no loopback "listening at host:port" line within ${LISTEN_MS / 1000}s; pass its port 0 and host 127.0.0.1 arguments`,
					),
				),
			LISTEN_MS,
		);
		child.stdout.on("data", read);
		child.stderr.on("data", read);
		child.once("exit", exited);
		child.once("error", finish);
		signal?.addEventListener("abort", aborted, { once: true });
	});
}

function socketTo(host: string, port: number, signal?: AbortSignal): Promise<Socket> {
	return new Promise((resolve, reject) => {
		const socket = connect({ host, port });
		const fail = (error: Error) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", aborted);
			socket.destroy();
			reject(error);
		};
		const aborted = () => fail(new Error("DAP launch aborted"));
		const timer = setTimeout(() => fail(new Error(`DAP connection to ${host}:${port} timed out`)), LISTEN_MS);
		socket.once("error", fail);
		socket.once("connect", () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", aborted);
			socket.off("error", fail);
			resolve(socket);
		});
		signal?.addEventListener("abort", aborted, { once: true });
	});
}
