import fs from "node:fs";
import path from "node:path";
import type { AttachRecord, DaemonSession, DaemonUnavailableSession } from "@octocodeai/octocode-contracts/daemon";
import { runningPid, sessions, sharedAgentDb } from "../agentdb/api.ts";
import { sha256 } from "../../../../common/src/atomic-file.ts";
import { AttachClient } from "./attach-client.ts";
import { webDaemonPaths } from "./paths.ts";
import { readAttachRecord, recordProcessAlive, removeRecord } from "./records.ts";
import { byAttention, SessionWatch } from "./session-state.ts";

const POLL_MS = 1000;
const RETRY_MS = 3000;

/** A route-safe name for a repository key: a hash, so no route carries a path. */
export const repoId = (key: string): string => sha256(key).slice(0, 16);

interface Link {
	record: AttachRecord;
	client?: AttachClient;
	/** Follows the session's run state while the client is connected. */
	watch?: SessionWatch;
	connecting: boolean;
	retryAt: number;
	/** Why the last attach was refused, when the session itself said so (an older protocol, for one). */
	problem?: string;
}

/**
 * The live sessions the daemon can reach. A session is listed when its attach record names a process that still runs,
 * the agent database does not say that session ended, and the daemon holds an authenticated connection to it. A
 * dropped connection is a detach; the next poll attaches again while the record stays valid.
 */
export class SessionRegistry {
	private readonly links = new Map<string, Link>();
	private readonly env: NodeJS.ProcessEnv;
	private readonly changed: () => void;
	private timer: ReturnType<typeof setInterval> | undefined;
	private refreshing = false;
	private stopped = false;
	/** While true no new session is attached: a draining daemon only serves what it already has. */
	paused = false;

	constructor(env: NodeJS.ProcessEnv, changed: () => void) {
		this.env = env;
		this.changed = changed;
	}

	start(): void {
		void this.refresh();
		this.timer = setInterval(() => void this.refresh(), POLL_MS);
		this.timer.unref();
	}

	private endedInDatabase(sessionId: string): boolean {
		try {
			const row = sessions.pidOf(sharedAgentDb(this.env).db, sessionId);
			return row !== undefined && runningPid(row.pid, row.pid_started) === undefined;
		} catch {
			return false;
		}
	}

	async refresh(): Promise<void> {
		if (this.refreshing || this.stopped) return;
		this.refreshing = true;
		try {
			const dir = webDaemonPaths(this.env).attachDir;
			let names: string[] = [];
			try {
				names = fs.readdirSync(dir).filter((name) => name.endsWith(".json"));
			} catch {
				// No session has attached yet.
			}
			const seen = new Set<string>();
			for (const name of names) {
				const file = path.join(dir, name);
				const record = readAttachRecord(file);
				if (!record) continue;
				if (!recordProcessAlive(record)) {
					removeRecord(file);
					continue;
				}
				if (this.endedInDatabase(record.sessionId)) continue;
				seen.add(record.sessionId);
				this.attach(record);
			}
			for (const [id, link] of this.links) {
				if (seen.has(id)) continue;
				link.watch?.close();
				link.client?.close();
				this.links.delete(id);
				this.changed();
			}
		} finally {
			this.refreshing = false;
		}
	}

	private attach(record: AttachRecord): void {
		let link = this.links.get(record.sessionId);
		if (link && link.record.token !== record.token) {
			link.watch?.close();
			link.client?.close();
			this.links.delete(record.sessionId);
			link = undefined;
		}
		if (!link) {
			link = { record, connecting: false, retryAt: 0 };
			this.links.set(record.sessionId, link);
		}
		if (this.paused || link.connecting || link.client?.connected || Date.now() < link.retryAt) return;
		link.connecting = true;
		const current = link;
		AttachClient.connect(record).then(
			(client) => {
				current.connecting = false;
				if (this.stopped || this.links.get(record.sessionId) !== current) return client.close();
				current.client = client;
				current.problem = undefined;
				current.watch?.close();
				current.watch = new SessionWatch(client.application, record.sessionId, this.changed);
				client.onClose(() => {
					current.watch?.close();
					current.watch = undefined;
					current.retryAt = Date.now() + RETRY_MS;
					this.changed();
				});
				this.changed();
			},
			(error: unknown) => {
				current.connecting = false;
				current.retryAt = Date.now() + RETRY_MS;
				current.problem =
					(error as { code?: string }).code === "protocol"
						? "This session uses an older Octocode; restart it to connect it to the web workspace."
						: undefined;
			},
		);
	}

	/** An attached session's record and connection. */
	get(sessionId: string): { record: AttachRecord; client: AttachClient } | undefined {
		const link = this.links.get(sessionId);
		return link?.client?.connected ? { record: link.record, client: link.client } : undefined;
	}

	/** Sessions with a live attach connection: the ones that need the user first, then the busy ones, newest first. */
	list(): DaemonSession[] {
		return [...this.links.values()]
			.filter((link) => link.client?.connected)
			.map(({ record, watch }) => ({
				id: record.sessionId,
				repoId: repoId(record.repo.key),
				repoName: record.repo.name.slice(0, 256),
				cwd: record.cwd.slice(0, 4096),
				startedAt: record.startedAt,
				attached: true,
				...(watch?.state ? { busy: watch.state.busy } : {}),
				...(watch?.state?.needsYou ? { needsYou: watch.state.needsYou } : {}),
			}))
			.sort(byAttention);
	}

	/** Live sessions that refused the daemon with a reason worth showing ("restart this session"). */
	unavailable(): DaemonUnavailableSession[] {
		return [...this.links.values()]
			.filter((link) => !link.client?.connected && link.problem)
			.map(({ record, problem }) => ({
				id: record.sessionId,
				repoName: record.repo.name.slice(0, 256),
				cwd: record.cwd.slice(0, 4096),
				message: problem!,
			}))
			.slice(0, 50);
	}

	get attached(): number {
		return this.list().length;
	}

	close(): void {
		this.stopped = true;
		clearInterval(this.timer);
		for (const link of this.links.values()) {
			link.watch?.close();
			link.client?.close();
		}
		this.links.clear();
	}
}
