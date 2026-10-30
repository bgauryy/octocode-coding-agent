import { WebSocket } from "ws";
import type { RemoteStatus } from "@octocodeai/octocode-contacts/daemon";
import { parseRelayFrame, parseTunnelRequest, relayRoutes, type TunnelResponsePayload } from "./protocol.ts";
import { open, roomOf, seal } from "./seal.ts";
import { PeerTunnel, type Loopback } from "./tunnel.ts";

const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30_000;
const MAX_PEERS = 16;

interface Peer {
	tunnel: PeerTunnel;
	/** The last `seq` seen from this peer; a frame that does not move past it is a replay and ends the peer. */
	seen: number;
	sent: number;
}

/**
 * The daemon's side of one relay room: an outbound WebSocket to the relay, one sealed tunnel per peer that joins, and
 * reconnection while the publication stands. The relay forwards bytes it cannot read; the key never leaves the link.
 */
export class RelayClient {
	readonly url: string;
	readonly room: string;
	readonly access: "view" | "control";
	private readonly key: Buffer;
	private readonly loopback: () => Loopback;
	private readonly build: string;
	private readonly activity: () => void;
	private readonly peers = new Map<string, Peer>();
	private socket: WebSocket | undefined;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private delay = RECONNECT_MIN_MS;
	private stopped = false;
	private state: NonNullable<RemoteStatus["relay"]>["state"] = "connecting";
	private error: string | undefined;

	constructor(options: {
		url: string;
		key: Buffer;
		access: "view" | "control";
		loopback: () => Loopback;
		build: string;
		activity: () => void;
	}) {
		this.url = options.url;
		this.key = options.key;
		this.room = roomOf(options.key);
		this.access = options.access;
		this.loopback = options.loopback;
		this.build = options.build;
		this.activity = options.activity;
	}

	start(): void {
		if (this.stopped) return;
		const target = new URL(relayRoutes.host(this.room), this.url).href;
		const socket = new WebSocket(target, { maxPayload: 16 * 1024 * 1024 + 1024 });
		this.socket = socket;
		this.state = "connecting";
		socket.on("open", () => {
			if (socket !== this.socket) return;
			this.state = "connected";
			this.error = undefined;
			this.delay = RECONNECT_MIN_MS;
		});
		socket.on("message", (data, binary) => {
			if (socket !== this.socket || binary) return;
			this.receive((data as Buffer).toString("utf8"));
		});
		socket.on("error", (error) => {
			if (socket === this.socket) this.error = error.message.slice(0, 300);
		});
		socket.on("close", () => {
			if (socket !== this.socket) return;
			this.socket = undefined;
			this.state = this.stopped ? "closed" : "connecting";
			this.dropPeers();
			if (this.stopped) return;
			this.timer = setTimeout(() => this.start(), this.delay);
			this.timer.unref();
			this.delay = Math.min(this.delay * 2, RECONNECT_MAX_MS);
		});
	}

	private receive(text: string): void {
		const frame = parseRelayFrame(text);
		if (!frame) return;
		if (frame.type === "peer.open") return this.join(frame.peer);
		const peer = this.peers.get(frame.peer);
		if (!peer) return;
		if (frame.type === "peer.close") return this.leave(frame.peer);
		const plain = open(this.key, this.room, frame.data);
		const message = plain === undefined ? undefined : parseTunnelRequest(plain);
		// A frame that is not sealed for this room, or one that does not move the sequence, ends the peer at once.
		if (!message || message.seq <= peer.seen) return this.leave(frame.peer, true);
		peer.seen = message.seq;
		this.activity();
		peer.tunnel.handle(message);
	}

	private join(id: string): void {
		if (this.peers.has(id) || this.peers.size >= MAX_PEERS) return this.leave(id, true);
		const peer: Peer = { seen: -1, sent: 0, tunnel: undefined as unknown as PeerTunnel };
		peer.tunnel = new PeerTunnel(this.loopback(), (message) => this.post(id, peer, message));
		this.peers.set(id, peer);
		this.activity();
		this.post(id, peer, { kind: "hello", access: this.access, build: this.build });
	}

	private post(id: string, peer: Peer, message: TunnelResponsePayload): void {
		if (this.peers.get(id) !== peer || this.socket?.readyState !== WebSocket.OPEN) return;
		const data = seal(this.key, this.room, JSON.stringify({ seq: peer.sent++, ...message }));
		this.socket.send(JSON.stringify({ type: "peer.message", peer: id, data }));
	}

	private leave(id: string, tell = false): void {
		const peer = this.peers.get(id);
		this.peers.delete(id);
		peer?.tunnel.close();
		if (tell && this.socket?.readyState === WebSocket.OPEN)
			this.socket.send(JSON.stringify({ type: "peer.close", peer: id }));
	}

	private dropPeers(): void {
		for (const peer of this.peers.values()) peer.tunnel.close();
		this.peers.clear();
	}

	status(): NonNullable<RemoteStatus["relay"]> {
		return {
			url: this.url,
			state: this.state,
			peers: this.peers.size,
			...(this.error ? { error: this.error } : {}),
		};
	}

	stop(): void {
		this.stopped = true;
		clearTimeout(this.timer);
		this.state = "closed";
		this.dropPeers();
		const socket = this.socket;
		this.socket = undefined;
		socket?.close(1000);
	}
}
