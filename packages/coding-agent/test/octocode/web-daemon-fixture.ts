import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
	ApplicationCommand,
	ApplicationConnection,
	ApplicationFrame,
	ApplicationPort,
} from "@octocodeai/octocode-contracts";
import type { WorkspaceSnapshot } from "@octocodeai/octocode-contracts/workspace";
import { afterAll } from "vitest";
import { webDaemonPaths } from "../../src/octocode/web-daemon/paths.ts";
import { readDaemonRecord, recordProcessAlive } from "../../src/octocode/web-daemon/records.ts";
import type { RevisedWorkspace } from "../../src/octocode/workspace/revision.ts";

const homes: NodeJS.ProcessEnv[] = [];

// A detached daemon outlives the test that started it unless the test stops it; a test that failed before it could
// stop one leaves it here, so each file stops the daemons its homes still record (the run fails one that outlives it).
afterAll(() => {
	for (const env of homes.splice(0)) {
		const record = readDaemonRecord(webDaemonPaths(env).record);
		// A test may run the daemon server in this worker (the record names this process): never stop the worker itself.
		if (!record || record.pid === process.pid || !recordProcessAlive(record)) continue;
		try {
			process.kill(record.pid, "SIGKILL");
		} catch {
			// Already gone.
		}
	}
});

/** An environment whose Octocode home and agent database are private to one test. */
export function isolatedEnv(extra: Record<string, string> = {}): { env: NodeJS.ProcessEnv; dir: string } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "web-daemon-"));
	const env: NodeJS.ProcessEnv = {
		...process.env,
		OCTOCODE_HOME: path.join(dir, "home"),
		OCTOCODE_AGENT_DB: path.join(dir, "agent.db"),
		OCTOCODE_CODING_AGENT_DIR: path.join(dir, "agent"),
		...extra,
	};
	homes.push(env);
	return { dir, env };
}

export const frame = (sessionId: string, sequence: number): ApplicationFrame => ({
	protocolVersion: 1,
	cursor: { sessionId, epoch: "e", sequence },
	at: 1,
	type: "resumed",
});

export interface FakeSession {
	workspace: RevisedWorkspace;
	connects: Array<{ cursor?: unknown }>;
	executed: ApplicationCommand[];
	push(frame: ApplicationFrame): void;
	changed(): void;
	setRevision(value: string): void;
}

/** A session's workspace with real queues and listeners, so the attach protocol runs end to end. */
export function fakeSession(sessionId: string): FakeSession {
	const listeners = new Set<() => void>();
	const streams = new Set<{ queue: ApplicationFrame[]; wake?: () => void; ended: boolean }>();
	const connects: Array<{ cursor?: unknown }> = [];
	const executed: ApplicationCommand[] = [];
	let revision = "1";
	const application: ApplicationPort = {
		connect: (options) => {
			connects.push({ cursor: options?.cursor });
			const stream = { queue: [] as ApplicationFrame[], ended: false, wake: undefined as (() => void) | undefined };
			streams.add(stream);
			const connection: ApplicationConnection = {
				async *[Symbol.asyncIterator]() {
					for (;;) {
						const next = stream.queue.shift();
						if (next) yield next;
						else if (stream.ended) return;
						else await new Promise<void>((resolve) => (stream.wake = resolve));
					}
				},
				execute: async (command) => ({ id: command.id, status: "accepted" }),
				close: () => {
					stream.ended = true;
					stream.wake?.();
					streams.delete(stream);
				},
			};
			return connection;
		},
		execute: async (command) => {
			executed.push(command);
			return { id: command.id, status: "accepted", message: "ok" };
		},
		history: async () => ({ messages: [], tools: [], hasMore: false }),
	};
	const snapshot = (): WorkspaceSnapshot => ({ sessionId, agents: [], traffic: [], events: [], receipts: [] });
	return {
		connects,
		executed,
		workspace: {
			application,
			snapshot,
			revision: () => revision,
			execute: async (command) => ({
				id: command.id,
				action: command.action,
				status: "accepted",
				at: 1,
				message: "queued",
			}),
			subscribe: (listener) => {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
			close: () => {},
		},
		push: (next) => {
			for (const stream of streams) {
				stream.queue.push(next);
				stream.wake?.();
			}
		},
		changed: () => {
			for (const listener of listeners) listener();
		},
		setRevision: (value) => {
			revision = value;
		},
	};
}
