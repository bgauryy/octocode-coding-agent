import {
	APPLICATION_PROTOCOL_VERSION,
	type ApplicationCommand,
	type ApplicationFrame,
	type ApplicationReceipt,
	type ProfileUpdate,
	type Snapshot,
	WORKSPACE_ROUTES,
	type WorkspaceSnapshot,
} from "@octocodeai/octocode-contracts";
import { isRecord } from "@octocodeai/octocode-contracts/guards";
import { bearer } from "./access.ts";
import { isProfileUpdate } from "./profiler-guards.ts";
import { ApplicationStream } from "@octocodeai/octocode-projections";
import { requestJson } from "./request.ts";
import { scopedRoute } from "./scope.ts";

interface Observer {
	application(stream: ApplicationStream, frame: ApplicationFrame): void;
	workspace(snapshot: WorkspaceSnapshot): void;
	profiler(update: ProfileUpdate): void;
	backlogs(snapshot: Snapshot): void;
	status(message: string): void;
}

/**
 * Connections in a row that may close before their first frame while the status still reads as connecting; after
 * that the page says the session keeps dropping it (an error) rather than showing a skeleton that never finishes.
 */
const SILENT_CLOSE_LIMIT = 3;

/** Transport lifecycle belongs to the view: closing a connection never sends abort. */
export class BrowserConnection {
	readonly stream = new ApplicationStream();
	private socket: WebSocket | undefined;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private closed = false;
	private authenticated = false;
	/** Connections in a row that closed before delivering a frame. */
	private silentCloses = 0;
	private delay = 500;
	private readonly token: string;
	private readonly observer: Observer;
	constructor(token: string, observer: Observer) {
		this.token = token;
		this.observer = observer;
	}
	get connected(): boolean {
		return !this.closed && this.authenticated && this.socket?.readyState === WebSocket.OPEN;
	}

	open(): void {
		if (
			this.closed ||
			(this.socket && (this.socket.readyState === WebSocket.CONNECTING || this.socket.readyState === WebSocket.OPEN))
		)
			return;
		clearTimeout(this.timer);
		this.authenticated = false;
		const socket = new WebSocket(location.origin.replace(/^http/, "ws") + scopedRoute(WORKSPACE_ROUTES.live));
		this.socket = socket;
		let retiring = false;
		const retire = (code?: number) => {
			if (socket !== this.socket || this.closed) return;
			retiring = true;
			this.authenticated = false;
			socket.close(code);
		};
		socket.onopen = () => {
			if (socket !== this.socket || this.closed || retiring) return;
			socket.send(
				JSON.stringify({
					token: this.token,
					protocolVersion: APPLICATION_PROTOCOL_VERSION,
					cursor: this.stream.cursor,
				}),
			);
		};
		socket.onmessage = (event) => {
			if (socket !== this.socket || this.closed || retiring) return;
			let message: unknown;
			try {
				message = JSON.parse(String(event.data));
			} catch {
				this.observer.status("Invalid server response. Reopen /web.");
				retire(1008);
				return;
			}
			if (!isRecord(message)) return;
			if (message.type === "daemon") {
				if (isRecord(message.data) && message.data.draining === true)
					this.observer.status("A newer Octocode is taking over. Reopen /web when this page stops updating.");
			} else if (message.type === "application") {
				const result = this.stream.accept(message.data);
				if (result === "resync") {
					this.observer.status("Refreshing session state…");
					retire();
				} else if (result === "invalid") {
					this.observer.status("Incompatible session stream. Reopen /web.");
					retire(1008);
				} else if (result === "applied") {
					this.authenticated = true;
					this.delay = 500;
					this.observer.application(this.stream, message.data as ApplicationFrame);
				} else if (result === "ignored") {
					this.authenticated = true;
				}
			} else if (
				message.type === "workspace" &&
				isRecord(message.data) &&
				typeof message.data.sessionId === "string" &&
				Array.isArray(message.data.events) &&
				Array.isArray(message.data.agents) &&
				Array.isArray(message.data.receipts) &&
				Array.isArray(message.data.traffic)
			) {
				this.authenticated = true;
				this.observer.workspace(message.data as unknown as WorkspaceSnapshot);
			} else if (message.type === "profiler" && isProfileUpdate(message.data)) {
				this.authenticated = true;
				this.observer.profiler(message.data);
			} else if (
				message.type === "snapshot" &&
				isRecord(message.data) &&
				Array.isArray(message.data.items) &&
				typeof message.data.generatedAt === "number"
			) {
				this.authenticated = true;
				this.delay = 500;
				this.observer.backlogs(message.data as unknown as Snapshot);
			}
		};
		socket.onclose = (event) => {
			if (this.closed || socket !== this.socket) return;
			// A connection that delivered a frame resets the count; one closed before any frame adds to it.
			this.silentCloses = this.authenticated ? 0 : this.silentCloses + 1;
			this.socket = undefined;
			this.authenticated = false;
			this.observer.status(
				event.code === 1008
					? "Access or protocol expired — reopen /web. Showing last received state."
					: this.silentCloses >= SILENT_CLOSE_LIMIT
						? "The session keeps closing the connection before sending anything. Still retrying; run /web again in the terminal if this stays."
						: "Disconnected · reconnecting… If the session ended, open /web in a running terminal.",
			);
			if (event.code !== 1008) {
				this.timer = setTimeout(() => this.open(), this.delay);
				this.delay = Math.min(this.delay * 2, 10000);
			}
		};
		socket.onerror = () => retire();
	}

	async execute(command: ApplicationCommand): Promise<ApplicationReceipt> {
		if (this.closed) throw new Error("Connection closed. Reopen the workspace before sending.");
		if (!this.stream.snapshot || command.sessionId !== this.stream.snapshot.sessionId)
			throw new Error("Session changed. Reopen the command before sending.");
		const epoch = this.stream.cursor?.epoch;
		if (!epoch) throw new Error("Session state is refreshing. Wait for the connection before sending.");
		const result = await requestJson(scopedRoute(WORKSPACE_ROUTES.application), {
			method: "POST",
			headers: { ...bearer(this.token), "Content-Type": "application/json" },
			body: JSON.stringify(command),
		});
		if (this.closed || this.stream.snapshot?.sessionId !== command.sessionId || this.stream.cursor?.epoch !== epoch)
			throw new Error("Session changed while the request was pending. Check its original session for the outcome.");
		if (
			!isRecord(result) ||
			!isRecord(result.receipt) ||
			result.receipt.id !== command.id ||
			!["accepted", "completed", "failed"].includes(String(result.receipt.status)) ||
			(result.receipt.message !== undefined && typeof result.receipt.message !== "string")
		)
			throw new Error("Invalid command receipt");
		const receipt = result.receipt as unknown as ApplicationReceipt;
		this.stream.acceptReceipt(receipt);
		return this.stream.snapshot?.receipts.find((item) => item.id === receipt.id) ?? receipt;
	}

	close(): void {
		this.closed = true;
		clearTimeout(this.timer);
		if (this.socket) {
			this.socket.onclose = null;
			this.socket.close();
			this.socket = undefined;
		}
	}
}
