import { WebSocket } from "ws";
import type { RemoteStatus } from "@octocodeai/octocode-contracts/daemon";
import {
	parseRelayFrame,
	parseTunnelRequest,
	parseWire,
	relayHostUrl,
	type TunnelResponsePayload,
	type WireFrame,
} from "./protocol.ts";
import { decodeNonce, directionKey, encodeKey, newNonce, open, roomOf, seal, WIRE_VERSION } from "./seal.ts";
import { PeerTunnel, type Loopback } from "./tunnel.ts";

const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30_000;
const MAX_PEERS = 16;
/** A peer that has not answered the daemon's hello with its own nonce by then is dropped. */
const JOIN_MS = 10_000;

/** The keys and counters of a peer that completed the handshake. */
interface Channel {
	receiveKey: Buffer;
	sendKey: Buffer;
	/** The `s` the next page message must carry. */
	expected: number;
	sent: number;
}

interface Peer {
	tunnel: PeerTunnel;
	/** The daemon's nonce for this peer until the peer joins. */
	nonce?: Buffer;
	channel?: Channel;
	joinTimer?: ReturnType<typeof setTimeout>;
}

/**
 * The daemon's side of one relay room: an outbound WebSocket to the relay, one sealed tunnel per peer that joins, and
 * reconnection while the publication stands. The relay forwards bytes it cannot read or reuse: every peer gets its own
 * nonce and its own keys, and the link key never leaves the link.
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
		const socket = new WebSocket(relayHostUrl(this.url, this.room), { maxPayload: 16 * 1024 * 1024 + 2048 });
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

	/** One relay frame. An error while handling a peer's frame ends that peer only; the room keeps serving the others. */
	private receive(text: string): void {
		const frame = parseRelayFrame(text);
		if (!frame) return;
		try {
			if (frame.type === "peer.open") return this.join(frame.peer);
			const peer = this.peers.get(frame.peer);
			if (!peer) return;
			if (frame.type === "peer.close") return this.leave(frame.peer);
			this.deliver(frame.peer, peer, frame.data);
		} catch {
			this.leave(frame.peer, true);
		}
	}

	/** A page's message: its `join` completes the handshake, a `msg` must be the next sealed message under this peer's key. */
	private deliver(id: string, peer: Peer, data: string): void {
		const wire = parseWire(data);
		if (!wire) return this.leave(id, true);
		if (wire.t === "join") return this.complete(id, peer, wire);
		const channel = peer.channel;
		// Anything else, a message before the handshake, a gap, a repeat, or a frame sealed for another connection, ends the peer.
		if (wire.t !== "msg" || !channel || wire.s !== channel.expected) return this.leave(id, true);
		const plain = open(channel.receiveKey, this.room, "p2d", wire.s, wire.d);
		const message = plain === undefined ? undefined : parseTunnelRequest(plain);
		if (!message) return this.leave(id, true);
		channel.expected++;
		this.activity();
		peer.tunnel.handle(message);
	}

	private complete(id: string, peer: Peer, join: Extract<WireFrame, { t: "join" }>): void {
		const daemonNonce = peer.nonce;
		const pageNonce = decodeNonce(join.nonce);
		if (peer.channel || !daemonNonce || !pageNonce) return this.leave(id, true);
		clearTimeout(peer.joinTimer);
		peer.channel = {
			receiveKey: directionKey(this.key, this.room, daemonNonce, pageNonce, "p2d"),
			sendKey: directionKey(this.key, this.room, daemonNonce, pageNonce, "d2p"),
			expected: 0,
			sent: 0,
		};
		peer.nonce = undefined;
		this.post(id, peer, { kind: "hello", access: this.access, build: this.build });
	}

	private join(id: string): void {
		if (this.peers.has(id) || this.peers.size >= MAX_PEERS) return this.leave(id, true);
		const nonce = newNonce();
		const peer: Peer = { tunnel: undefined as unknown as PeerTunnel, nonce };
		peer.tunnel = new PeerTunnel(this.loopback(), (message) => this.post(id, peer, message));
		peer.joinTimer = setTimeout(() => {
			if (this.peers.get(id) === peer && !peer.channel) this.leave(id, true);
		}, JOIN_MS);
		peer.joinTimer.unref();
		this.peers.set(id, peer);
		this.activity();
		this.send({
			type: "peer.message",
			peer: id,
			data: JSON.stringify({ v: WIRE_VERSION, t: "hello", nonce: encodeKey(nonce) }),
		});
	}

	/** A sealed message to a peer that completed the handshake; dropped for any other. */
	private post(id: string, peer: Peer, message: TunnelResponsePayload): void {
		const channel = peer.channel;
		if (this.peers.get(id) !== peer || !channel) return;
		const s = channel.sent++;
		const d = seal(channel.sendKey, this.room, "d2p", s, JSON.stringify(message));
		this.send({ type: "peer.message", peer: id, data: JSON.stringify({ v: WIRE_VERSION, t: "msg", s, d }) });
	}

	private send(frame: { type: "peer.message" | "peer.close"; peer: string; data?: string }): void {
		if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(frame));
	}

	private leave(id: string, tell = false): void {
		const peer = this.peers.get(id);
		this.peers.delete(id);
		if (peer) {
			clearTimeout(peer.joinTimer);
			peer.tunnel.close();
		}
		if (tell) this.send({ type: "peer.close", peer: id });
	}

	private dropPeers(): void {
		for (const peer of this.peers.values()) {
			clearTimeout(peer.joinTimer);
			peer.tunnel.close();
		}
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
