import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import {
	APPLICATION_PROTOCOL_VERSION,
	type ApplicationConnection,
	type ApplicationCursor,
} from "@octocodeai/octocode-contracts";
import type { WorkspaceServerEvent } from "@octocodeai/octocode-contracts/protocol";
import { dbStamp } from "../agentdb/api.ts";
import { agentDbPath } from "../shared/home.ts";
import { backlogSnapshot } from "../backlog/snapshot.ts";
import { pumpApplicationFrames } from "../workspace/application-stream.ts";
import { readerStalled } from "../workspace/socket-pressure.ts";
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
}

function validCursor(value: unknown): value is ApplicationCursor {
	const cursor = value as ApplicationCursor | undefined;
	return (
		!!cursor &&
		typeof cursor.sessionId === "string" &&
		typeof cursor.epoch === "string" &&
		Number.isSafeInteger(cursor.sequence) &&
		cursor.sequence >= 0
	);
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
	private checking = false;

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
		this.timer = setInterval(() => void this.check(), TICK_MS);
		this.timer.unref();
	}

	/** Called by the router after the Host header passed; the Origin must be exactly the daemon's. */
	upgrade(req: IncomingMessage, socket: Duplex, head: Buffer, scope: TabScope): void {
		socket.on("error", () => socket.destroy());
		if (req.headers.origin !== this.origin() || this.tabs.size >= MAX_TABS) {
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
			// Only a tab that proved the token counts as use; a stranger's socket never restarts the idle timer.
			if (authenticated) {
				this.activity();
				const id = scope.session?.id;
				if (id && ![...this.tabs].some((other) => other.scope.session?.id === id)) this.lastWorkspace.delete(id);
			}
		});
		socket.on("message", (data, binary) => {
			if (authenticated) return socket.close(1008, "Updates only");
			if (binary) return socket.close(1008, "Reopen the workspace");
			let supplied = (data as Buffer).toString();
			let cursor: ApplicationCursor | undefined;
			if (supplied.startsWith("{")) {
				let hello: { token?: unknown; protocolVersion?: unknown; cursor?: unknown };
				try {
					hello = JSON.parse(supplied);
				} catch {
					return socket.close(1008, "Invalid handshake");
				}
				if (!hello || hello.protocolVersion !== APPLICATION_PROTOCOL_VERSION || typeof hello.token !== "string")
					return socket.close(1008, "Unsupported protocol; reopen the workspace");
				supplied = hello.token;
				if (hello.cursor !== undefined) {
					if (!validCursor(hello.cursor)) return socket.close(1008, "Invalid cursor");
					cursor = hello.cursor;
				}
			}
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
		this.sendBacklog(tab);
		const session = tab.scope.session;
		if (!session) return;
		await this.sendWorkspace(tab, session.client);
		const connection = session.client.application.connect({ sessionId: session.id, cursor });
		tab.connection = connection;
		if (tab.socket.readyState !== WebSocket.OPEN) return connection.close();
		await pumpApplicationFrames(tab.socket, connection, { access: tab.access });
	}

	private post(tab: Tab, event: WorkspaceServerEvent | { type: "daemon"; data: { draining: boolean } }): void {
		if (tab.socket.readyState !== WebSocket.OPEN) return;
		if (readerStalled(tab.socket)) return tab.socket.terminate();
		tab.socket.send(JSON.stringify(event));
	}

	private snapshotFor(scope: TabScope): string {
		const store = this.catalog.store(scope.repo.key);
		return JSON.stringify({
			type: "snapshot",
			data: backlogSnapshot(store, scope.repo.name, Date.now(), scope.session?.id),
		} satisfies WorkspaceServerEvent);
	}

	private sendBacklog(tab: Tab, cache?: Map<string, string>): void {
		const key = `${tab.scope.repo.id}|${tab.scope.session?.id ?? ""}`;
		let text = cache?.get(key);
		if (text === undefined) {
			text = this.snapshotFor(tab.scope);
			cache?.set(key, text);
		}
		if (tab.socket.readyState !== WebSocket.OPEN) return;
		if (readerStalled(tab.socket)) return tab.socket.terminate();
		tab.socket.send(text);
	}

	private async sendWorkspace(tab: Tab, client: AttachClient): Promise<void> {
		const data = await client.workspace.snapshot();
		this.post(tab, { type: "workspace", data });
	}

	/** Tells every tab of `sessionId` to refresh its workspace if the session's stamp or snapshot changed. */
	async workspaceChanged(sessionId: string, force = false): Promise<void> {
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

	private async check(): Promise<void> {
		if (this.checking || this.tabs.size === 0) return;
		this.checking = true;
		try {
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
			}
			const sessions = new Set([...this.tabs].flatMap((tab) => (tab.scope.session ? [tab.scope.session.id] : [])));
			for (const id of sessions) await this.workspaceChanged(id).catch(() => undefined);
		} finally {
			this.checking = false;
		}
	}

	/** Tells open pages that a newer daemon is taking over. */
	announceDrain(): void {
		for (const tab of this.tabs) this.post(tab, { type: "daemon", data: { draining: true } });
	}

	closeAll(): void {
		clearInterval(this.timer);
		for (const socket of this.sockets.clients) socket.terminate();
		this.pending.clear();
		this.sockets.close();
	}
}
