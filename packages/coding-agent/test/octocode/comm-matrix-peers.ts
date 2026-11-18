import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { once } from "node:events";
import { writeFileSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import { vi } from "vitest";
import type { FeatureContext } from "../../src/core/features/index.ts";
import { ownInstance, publishOwnInstance } from "../../src/octocode/api/identity.ts";
import { apiDir, type InstanceRecord, instancesDir, removeSocket } from "../../src/octocode/api/registry.ts";
import { Peers } from "../../src/octocode/external/peers.ts";

const SOURCE_RESOLVER = join(import.meta.dirname, "..", "..", "scripts", "source-resolver.ts");
const WORKER = join(import.meta.dirname, "fixtures", "peer-api-worker.ts");

/** What a test started: every process, socket and sender, released by `release` on every exit path. */
export class Owned {
	private readonly children = new Set<ChildProcessWithoutNullStreams>();
	private readonly sockets = new Set<net.Socket>();
	private readonly senders = new Set<Peers>();
	/** The sockets the peers listened on: a killed peer leaves its file (and its private folder) behind. */
	private readonly listening = new Set<string>();

	/**
	 * Another Octocode process with a session API (`fixtures/peer-api-worker.ts`), listed under the current
	 * `OCTOCODE_HOME`; `received` lists the texts it took.
	 */
	async peer(id: string, cwd: string, mode: "turn" | "queue" | "queue-read" = "turn") {
		const name = `octocode-main-${id}`;
		const child = spawn(process.execPath, ["--import", SOURCE_RESOLVER, WORKER, id, name, cwd, mode], {
			env: process.env,
		});
		this.children.add(child);
		const received: string[] = [];
		let out = "";
		let err = "";
		child.stderr.on("data", (chunk: Buffer) => (err += String(chunk)));
		const ready = new Promise<string>((resolve, reject) => {
			child.stdout.on("data", (chunk: Buffer) => {
				out += String(chunk);
				let newline = out.indexOf("\n");
				while (newline >= 0) {
					const line = out.slice(0, newline);
					out = out.slice(newline + 1);
					if (line.startsWith("ready ")) resolve(line.slice(6));
					else if (line.startsWith("received ")) received.push(JSON.parse(line.slice(9)).text);
					newline = out.indexOf("\n");
				}
			});
			child.once("exit", (code) => reject(new Error(`The peer exited with ${code} before it listened: ${err}`)));
		});
		const socket = await ready;
		this.listening.add(socket);
		const kill = async (): Promise<void> => {
			if (child.exitCode !== null || child.signalCode !== null) return;
			const gone = once(child, "exit");
			child.kill("SIGKILL");
			await gone;
		};
		return { name, received, socket, kill, stderr: () => err };
	}

	/** Holds `count` connections open to `socket`, each answered by the server before the next one opens. */
	async hold(socket: string, count: number): Promise<net.Socket[]> {
		const held: net.Socket[] = [];
		for (let i = 0; i < count; i++) {
			const connection = net.connect(socket);
			this.sockets.add(connection);
			held.push(connection);
			connection.on("error", () => undefined);
			await once(connection, "connect");
		}
		return held;
	}

	/** Closes connections `hold` opened and waits until each one is closed. */
	async free(held: net.Socket[]): Promise<void> {
		await Promise.all(
			held.map(async (connection) => {
				this.sockets.delete(connection);
				if (connection.closed) return;
				const closed = once(connection, "close");
				connection.destroy();
				await closed;
			}),
		);
	}

	/**
	 * This process as a sending session: its own API record (so its claim carries a ticket) and a `Peers` whose
	 * waking `notice` and quiet `quiet` notices are recorded.
	 */
	sender(cwd: string) {
		const self: InstanceRecord = {
			id: "oc-self",
			pid: process.pid,
			cwd,
			startedAt: 1,
			protocol: 1,
			name: "octocode-main-self",
		};
		writeFileSync(join(instancesDir(apiDir()), "oc-self.json"), JSON.stringify(self));
		publishOwnInstance(self);
		const notice = vi.fn<(text: string) => void>();
		const quiet = vi.fn<(text: string) => void>();
		const peers = new Peers({ authorize: async () => undefined, notice, quiet }, process.env);
		this.senders.add(peers);
		const ctx = { cwd } as unknown as FeatureContext;
		return { peers, notice, quiet, send: (to: string, text: string) => peers.send(to, text, {}, ctx) };
	}

	async release(): Promise<void> {
		for (const peers of this.senders) peers.reset();
		this.senders.clear();
		publishOwnInstance(undefined, ownInstance());
		for (const connection of this.sockets) connection.destroy();
		this.sockets.clear();
		await Promise.all(
			[...this.children].map(async (child) => {
				if (child.exitCode !== null || child.signalCode !== null) return;
				const gone = once(child, "exit");
				child.kill("SIGKILL");
				await gone;
			}),
		);
		this.children.clear();
		for (const socket of this.listening) removeSocket(socket);
		this.listening.clear();
	}
}

/** The rejection of `sending`, so a test asserts what kind of failure it was. */
export async function failure(sending: Promise<unknown>): Promise<Record<string, unknown>> {
	const error: unknown = await sending.then(
		() => {
			throw new Error("The send was expected to fail");
		},
		(error: unknown) => error,
	);
	return error as Record<string, unknown>;
}
