import {
	APPLICATION_PROTOCOL_VERSION,
	type ApplicationCommand,
	type ApplicationFrame,
	type ApplicationReceipt,
	type Snapshot,
	WORKSPACE_ROUTES,
	type WorkspaceSnapshot,
} from "@octocodeai/octocode-contacts";
import { ApplicationStream } from "./application-stream.ts";

interface Observer {
	application(stream: ApplicationStream, frame: ApplicationFrame): void;
	workspace(snapshot: WorkspaceSnapshot): void;
	backlogs(snapshot: Snapshot): void;
	status(message: string): void;
}
function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** Transport lifecycle belongs to the view: closing a connection never sends abort. */
export class BrowserConnection {
	readonly stream = new ApplicationStream();
	private socket: WebSocket | undefined;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private closed = false;
	private delay = 500;
	private readonly token: string;
	private readonly observer: Observer;
	constructor(token: string, observer: Observer) {
		this.token = token;
		this.observer = observer;
	}
	get connected(): boolean {
		return this.socket?.readyState === WebSocket.OPEN;
	}

	open(): void {
		if (this.closed) return;
		const socket = new WebSocket(location.origin.replace(/^http/, "ws") + WORKSPACE_ROUTES.live);
		this.socket = socket;
		socket.onopen = () =>
			socket.send(
				JSON.stringify({
					token: this.token,
					protocolVersion: APPLICATION_PROTOCOL_VERSION,
					cursor: this.stream.cursor,
				}),
			);
		socket.onmessage = (event) => {
			if (socket !== this.socket || this.closed) return;
			let message: unknown;
			try {
				message = JSON.parse(String(event.data));
			} catch {
				this.observer.status("Invalid server response. Reopen /backlog.");
				socket.close(1008);
				return;
			}
			if (!record(message)) return;
			if (message.type === "application") {
				const result = this.stream.accept(message.data);
				if (result === "resync") {
					this.observer.status("Refreshing session state…");
					socket.close();
				} else if (result === "invalid") {
					this.observer.status("Incompatible session stream. Reopen /backlog.");
					socket.close(1008);
				} else if (result === "applied") {
					this.delay = 500;
					this.observer.application(this.stream, message.data as ApplicationFrame);
				}
			} else if (
				message.type === "workspace" &&
				record(message.data) &&
				typeof message.data.sessionId === "string" &&
				Array.isArray(message.data.events) &&
				Array.isArray(message.data.agents) &&
				Array.isArray(message.data.receipts) &&
				Array.isArray(message.data.traffic)
			) {
				this.observer.workspace(message.data as unknown as WorkspaceSnapshot);
			} else if (
				message.type === "snapshot" &&
				record(message.data) &&
				Array.isArray(message.data.items) &&
				typeof message.data.generatedAt === "number"
			) {
				this.delay = 500;
				this.observer.backlogs(message.data as unknown as Snapshot);
			}
		};
		socket.onclose = (event) => {
			if (this.closed || socket !== this.socket) return;
			this.observer.status(
				event.code === 1008 ? "Access or protocol expired — reopen /backlog." : "Disconnected · reconnecting…",
			);
			if (event.code !== 1008) {
				this.timer = setTimeout(() => this.open(), this.delay);
				this.delay = Math.min(this.delay * 2, 10000);
			}
		};
		socket.onerror = () => socket.close();
	}

	async execute(command: ApplicationCommand): Promise<ApplicationReceipt> {
		if (!this.stream.snapshot || command.sessionId !== this.stream.snapshot.sessionId)
			throw new Error("Session changed. Reopen the command before sending.");
		const response = await fetch(WORKSPACE_ROUTES.application, {
			method: "POST",
			headers: { Authorization: "Bearer " + this.token, "Content-Type": "application/json" },
			body: JSON.stringify(command),
		});
		const result: unknown = await response.json();
		if (!response.ok)
			throw new Error(record(result) && typeof result.error === "string" ? result.error : "Request failed");
		if (
			!record(result) ||
			!record(result.receipt) ||
			typeof result.receipt.id !== "string" ||
			!["accepted", "completed", "failed"].includes(String(result.receipt.status))
		)
			throw new Error("Invalid command receipt");
		const receipt = result.receipt as unknown as ApplicationReceipt;
		this.stream.acceptReceipt(receipt);
		return receipt;
	}

	close(): void {
		this.closed = true;
		clearTimeout(this.timer);
		if (this.socket) {
			this.socket.onclose = null;
			this.socket.close();
		}
	}
}
