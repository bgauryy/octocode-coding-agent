import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import type { ApplicationConnection, ApplicationCursor } from "@octocodeai/octocode-contracts";
import type { WorkspaceServerEvent } from "@octocodeai/octocode-contracts/protocol";
import { redactData } from "../../../../common/src/sanitize.ts";
import { dbStamp } from "../../../../db/src/api.ts";
import { agentDbPath } from "../shared/home.ts";
import { backlogSnapshot } from "../backlog/snapshot.ts";
import { pumpApplicationFrames } from "../workspace/application-stream.ts";
import { ownOrigin, readHello } from "../workspace/page-access.ts";
import { readerStalled } from "../workspace/socket-pressure.ts";
import { BacklogProjection } from "../workspace/backlog-projection.ts";
import type { AttachClient } from "./attach-client.ts";
import { tokenAccess, type DaemonTokens, type TokenAccess } from "./http-util.ts";
import type { RepoCatalog, RepoInfo } from "./repos.ts";

/** Authenticated tabs. Sockets still waiting for their hello do not count against it. */
const MAX_TABS = 64;
/** Sockets waiting for their hello; when full the oldest is dropped so a stranger cannot hold every slot. */
const MAX_PENDING = 32;
/** A page sends its hello as soon as the socket opens. */
const HELLO_MS = 2000;
const TICK_MS = 500;

export interface TabScope {
	repo: RepoInfo;
	/** The attached session a tab is bound to; absent for a repository's read-only view. */
	session?: { id: string; client: AttachClient };
}

interface Tab {
	socket: WebSocket;
	scope: TabScope;
	access: "control" | "view";
	/** The token that opened this tab, so rotating it can end the tab. */
	credential?: TokenAccess;
	connection?: ApplicationConnection;
	/** Stops this tab's profiler frames. */
	profilerOff?: () => void;
}

interface WorkspaceRefresh {
	pending: boolean;
	force: boolean;
	promise: Promise<void>;
}

/**
 * The browser tabs of the daemon. One authenticated hello per socket (token, protocol, optional cursor), then the
 * repository's board and, for a session scope, that session's workspace and application stream. One timer per daemon
 * watches the database stamp (a stat of two files); a snapshot is built only after the stamp moved.
 */
export class TabHub {
	private readonly sockets = new WebSocketServer({ noServer: true, maxPayload: 1024, perMessageDeflate: false });
	private readonly tabs = new Set<Tab>();
	private readonly pending = new Set<WebSocket>();
	private readonly tokens: DaemonTokens;
	private readonly origin: () => string;
	private readonly catalog: RepoCatalog;
	private readonly env: NodeJS.ProcessEnv;
	private readonly activity: () => void;
	private readonly accepting: () => boolean;
	private stamp: string;
	private timer: ReturnType<typeof setInterval> | undefined;
	private lastWorkspace = new Map<string, { revision: string | null; text: string }>();
	private readonly workspaceRefreshes = new Map<string, WorkspaceRefresh>();
	private readonly backlogs = new Map<string, BacklogProjection>();

	constructor(options: {
		tokens: DaemonTokens;
		origin: () => string;
		catalog: RepoCatalog;
		env: NodeJS.ProcessEnv;
		activity: () => void;
		accepting: () => boolean;
	}) {
		this.tokens = options.tokens;
		this.origin = options.origin;
		this.catalog = options.catalog;
		this.env = options.env;
		this.activity = options.activity;
		this.accepting = options.accepting;
		this.stamp = dbStamp(agentDbPath(this.env));
	}

	get count(): number {
		return this.tabs.size;
	}

	/** Ends every tab that was opened with one of these tokens, after the daemon replaced them. */
	revoke(credentials: TokenAccess[]): void {
		for (const tab of this.tabs)
			if (tab.credential && credentials.includes(tab.credential)) tab.socket.close(1008, "This link was stopped");
	}

	/** Sessions whose last workspace snapshot is remembered; an entry lives only while a tab of that session is open. */
	get trackedWorkspaces(): number {
		return this.lastWorkspace.size;
	}

	start(): void {
		this.timer = setInterval(() => this.check(), TICK_MS);
		this.timer.unref();
	}

	/** Called by the router after the Host header passed; the Origin must be exactly the daemon's. */
	upgrade(req: IncomingMessage, socket: Duplex, head: Buffer, scope: TabScope): void {
		socket.on("error", () => socket.destroy());
		if (!ownOrigin(req, this.origin(), true) || this.tabs.size >= MAX_TABS) {
			socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
			return;
		}
		if (!this.accepting()) {
			socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
			return;
		}
		this.sockets.handleUpgrade(req, socket, head, (client) => this.open(client, scope));
	}

	private open(socket: WebSocket, scope: TabScope): void {
		const tab: Tab = { socket, scope, access: "view" };
		if (this.pending.size >= MAX_PENDING) {
			const oldest = this.pending.values().next().value;
			if (oldest) {
				this.pending.delete(oldest);
				oldest.terminate();
			}
		}
		this.pending.add(socket);
		const timeout = setTimeout(() => socket.terminate(), HELLO_MS);
		timeout.unref();
		let authenticated = false;
		socket.on("error", () => socket.terminate());
		socket.on("close", () => {
			clearTimeout(timeout);
			this.pending.delete(socket);
			this.tabs.delete(tab);
			tab.connection?.close();
			this.releaseProfiler(tab);
			// Only a tab that proved the token counts as use; a stranger's socket never restarts the idle timer.
			if (authenticated) {
				this.activity();
				const id = scope.session?.id;
				if (id && ![...this.tabs].some((other) => other.scope.session?.id === id)) this.lastWorkspace.delete(id);
				const key = this.backlogKey(scope);
				if (![...this.tabs].some((other) => this.backlogKey(other.scope) === key)) this.backlogs.delete(key);
			}
		});
		socket.on("message", (data, binary) => {
			if (authenticated) return socket.close(1008, "Updates only");
			const hello = readHello(data as Buffer, binary);
			if ("refusal" in hello) return socket.close(1008, hello.refusal);
			const { token: supplied, cursor } = hello;
			const access = tokenAccess(supplied, this.tokens);
			if (!access) return socket.close(1008, "Reopen the workspace");
			tab.access = access === "view" ? "view" : "control";
			tab.credential = access;
			if (this.tabs.size >= MAX_TABS) return socket.close(1013, "Too many open tabs");
			clearTimeout(timeout);
			authenticated = true;
			this.pending.delete(socket);
			this.tabs.add(tab);
			this.activity();
			void this.begin(tab, cursor).catch(() => socket.terminate());
		});
	}

	private async begin(tab: Tab, cursor: ApplicationCursor | undefined): Promise<void> {
		// Nothing watched the database while no tab was open: the first tab's snapshot is the new baseline.
		if (this.tabs.size <= 1) this.stamp = dbStamp(agentDbPath(this.env));
		const cache = new Map<string, string>();
		for (const other of this.tabs)
			if (this.backlogKey(other.scope) === this.backlogKey(tab.scope)) this.sendBacklog(other, cache);
		const session = tab.scope.session;
		if (!session) return;
		await this.workspaceChanged(session.id, true);
		// Live request frames of this session's agents: the session sends them to the daemon once it is subscribed.
		tab.profilerOff = session.client.profiler.onUpdate((update) =>
			this.post(tab, { type: "profiler", data: redactData(update) }),
		);
		void session.client.profiler.subscribe().catch(() => undefined);
		if (tab.socket.readyState !== WebSocket.OPEN) this.releaseProfiler(tab);
		const connection = session.client.application.connect({ sessionId: session.id, cursor });
		tab.connection = connection;
		if (tab.socket.readyState !== WebSocket.OPEN) return connection.close();
		await pumpApplicationFrames(tab.socket, connection, { access: tab.access });
	}

	/** Stops a tab's profiler frames; the session stops sending them (and polling) once no tab of it is left. */
	private releaseProfiler(tab: Tab): void {
		if (!tab.profilerOff) return;
		tab.profilerOff();
		tab.profilerOff = undefined;
		const session = tab.scope.session;
		if (!session?.client.connected || [...this.tabs].some((other) => other.scope.session?.id === session.id)) return;
		void session.client.profiler.unsubscribe().catch(() => undefined);
	}

	private post(tab: Tab, event: WorkspaceServerEvent | { type: "daemon"; data: { draining: boolean } }): void {
		if (tab.socket.readyState !== WebSocket.OPEN) return;
		if (readerStalled(tab.socket)) return tab.socket.terminate();
		tab.socket.send(JSON.stringify(event));
	}

	private backlogKey(scope: TabScope): string {
		return `${scope.repo.id}|${scope.session?.id ?? ""}`;
	}

	private projectionFor(scope: TabScope): BacklogProjection {
		const key = this.backlogKey(scope);
		let projection = this.backlogs.get(key);
		if (!projection) {
			const store = this.catalog.store(scope.repo.id);
			projection = new BacklogProjection(
				(now) => backlogSnapshot(store, scope.repo.name, now, scope.session?.id),
				(id) => store.liveHolder(id, true) !== undefined,
				scope.session?.id,
			);
			this.backlogs.set(key, projection);
		}
		return projection;
	}

	private snapshotFor(scope: TabScope): string {
		return JSON.stringify({
			type: "snapshot",
			data: this.projectionFor(scope).read(),
		} satisfies WorkspaceServerEvent);
	}

	private sendBacklog(tab: Tab, cache?: Map<string, string>): void {
		const key = this.backlogKey(tab.scope);
		let text = cache?.get(key);
		if (text === undefined) {
			text = this.snapshotFor(tab.scope);
			cache?.set(key, text);
		}
		if (tab.socket.readyState !== WebSocket.OPEN) return;
		if (readerStalled(tab.socket)) return tab.socket.terminate();
		tab.socket.send(text);
	}

	/** Coalesces overlapping requests for one session; snapshots reach its tabs in read order. */
	workspaceChanged(sessionId: string, force = false): Promise<void> {
		const running = this.workspaceRefreshes.get(sessionId);
		if (running) {
			running.pending = true;
			running.force ||= force;
			return running.promise;
		}
		const refresh: WorkspaceRefresh = { pending: false, force: false, promise: Promise.resolve() };
		refresh.promise = Promise.resolve()
			.then(() => this.refreshWorkspace(sessionId, force))
			.finally(() => {
				this.workspaceRefreshes.delete(sessionId);
				// A new tab can begin streaming after this read even while updates continue arriving.
				if (refresh.pending) void this.workspaceChanged(sessionId, refresh.force).catch(() => undefined);
			});
		this.workspaceRefreshes.set(sessionId, refresh);
		return refresh.promise;
	}

	/** Tells every tab of `sessionId` to refresh its workspace if the session's stamp or snapshot changed. */
	private async refreshWorkspace(sessionId: string, force: boolean): Promise<void> {
		const tabs = [...this.tabs].filter((tab) => tab.scope.session?.id === sessionId);
		const client = tabs[0]?.scope.session?.client;
		if (!client?.connected) return;
		const revision = await client.workspace.revision();
		const previous = this.lastWorkspace.get(sessionId);
		if (!force && revision !== null && previous?.revision === revision) return;
		const data = await client.workspace.snapshot();
		// Every tab may have left while the snapshot was on its way: remember nothing for a session nobody watches.
		if (![...this.tabs].some((tab) => tab.scope.session?.id === sessionId)) return;
		const text = JSON.stringify(data);
		this.lastWorkspace.set(sessionId, { revision, text });
		if (!force && previous?.text === text) return;
		for (const tab of tabs) this.post(tab, { type: "workspace", data });
	}

	private check(): void {
		if (this.tabs.size === 0) return;
		const stamp = dbStamp(agentDbPath(this.env));
		if (stamp !== this.stamp) {
			this.stamp = stamp;
			const cache = new Map<string, string>();
			for (const tab of this.tabs) {
				try {
					this.sendBacklog(tab, cache);
				} catch {
					tab.socket.terminate();
				}
			}
		} else {
			const updates = new Map<string, string | undefined>();
			for (const tab of this.tabs) {
				try {
					const key = this.backlogKey(tab.scope);
					if (!updates.has(key)) {
						const data = this.backlogs.get(key)?.refresh();
						updates.set(
							key,
							data ? JSON.stringify({ type: "snapshot", data } satisfies WorkspaceServerEvent) : undefined,
						);
					}
					const text = updates.get(key);
					if (text && tab.socket.readyState === WebSocket.OPEN) {
						if (readerStalled(tab.socket)) tab.socket.terminate();
						else tab.socket.send(text);
					}
				} catch {
					tab.socket.terminate();
				}
			}
		}
		const sessions = new Set([...this.tabs].flatMap((tab) => (tab.scope.session ? [tab.scope.session.id] : [])));
		// A slow session cannot delay another session or the next database tick. Per-session refreshes stay bounded.
		for (const id of sessions) void this.workspaceChanged(id).catch(() => undefined);
	}

	/** Tells open pages that a newer daemon is taking over. */
	announceDrain(): void {
		for (const tab of this.tabs) this.post(tab, { type: "daemon", data: { draining: true } });
	}

	closeAll(): void {
		clearInterval(this.timer);
		for (const socket of this.sockets.clients) socket.terminate();
		this.pending.clear();
		this.backlogs.clear();
		this.sockets.close();
	}
}
