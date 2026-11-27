import http from "node:http";
import { WebSocket } from "ws";
import { APPLICATION_PROTOCOL_VERSION } from "@octocodeai/octocode-contracts";
import { validPath, type TunnelRequest, type TunnelResponsePayload } from "./protocol.ts";

/** The daemon's own loopback server as one peer may use it: always with this peer's token, never the page's. */
export interface Loopback {
	port: number;
	origin: string;
	token: string;
}

const MAX_REQUESTS = 16;
const MAX_STREAMS = 8;
const MAX_BODY_BYTES = 262144;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;
const STREAM_BUFFER_LIMIT = 1048576;

/**
 * Performs one remote peer's tunnel messages against the daemon's loopback server. The peer never holds a daemon
 * token: the tunnel adds the token of the room the peer joined, and the loopback server applies every rule it applies
 * to a browser tab (host, origin, view-only writes, scopes). Streams are loopback sockets to the live route, one per
 * open stream; they end when the peer leaves.
 */
export class PeerTunnel {
	private readonly loopback: Loopback;
	private readonly send: (message: TunnelResponsePayload) => void;
	private readonly streams = new Map<string, WebSocket>();
	private inFlight = 0;
	private closed = false;

	constructor(loopback: Loopback, send: (message: TunnelResponsePayload) => void) {
		this.loopback = loopback;
		this.send = send;
	}

	handle(message: TunnelRequest): void {
		if (this.closed) return;
		switch (message.kind) {
			case "request":
				return this.request(message);
			case "stream.open":
				return this.open(message);
			case "stream.close":
				return this.end(message.stream, 1000);
		}
	}

	private request(message: Extract<TunnelRequest, { kind: "request" }>): void {
		const answer = (status: number, body: string) => this.send({ kind: "response", id: message.id, status, body });
		if (!validPath(message.path)) return answer(400, JSON.stringify({ error: "Invalid request path" }));
		if (this.inFlight >= MAX_REQUESTS) return answer(429, JSON.stringify({ error: "Too many requests in flight" }));
		const body = message.body === undefined ? undefined : Buffer.from(message.body, "utf8");
		if (body && body.length > MAX_BODY_BYTES) return answer(413, JSON.stringify({ error: "Request too large" }));
		this.inFlight++;
		let settled = false;
		const settle = (status: number, text: string) => {
			if (settled) return;
			settled = true;
			this.inFlight--;
			if (!this.closed) answer(status, text);
		};
		try {
			const request = http.request(
				{
					host: "127.0.0.1",
					port: this.loopback.port,
					path: message.path,
					method: message.method,
					headers: {
						Host: `127.0.0.1:${this.loopback.port}`,
						Origin: this.loopback.origin,
						Authorization: `Bearer ${this.loopback.token}`,
						...(body ? { "content-type": "application/json", "content-length": String(body.length) } : {}),
					},
					agent: new http.Agent({ keepAlive: false }),
					timeout: REQUEST_TIMEOUT_MS,
				},
				(response) => {
					const chunks: Buffer[] = [];
					let bytes = 0;
					response.on("data", (chunk: Buffer) => {
						bytes += chunk.length;
						if (bytes > MAX_RESPONSE_BYTES) {
							response.destroy();
							settle(502, JSON.stringify({ error: "Response too large for the relay" }));
							return;
						}
						chunks.push(chunk);
					});
					response.on("error", () => settle(502, JSON.stringify({ error: "The daemon did not answer" })));
					response.on("end", () => settle(response.statusCode ?? 0, Buffer.concat(chunks).toString("utf8")));
				},
			);
			request.on("timeout", () => request.destroy());
			request.on("error", () => settle(502, JSON.stringify({ error: "The daemon did not answer" })));
			if (body) request.write(body);
			request.end();
		} catch {
			// Node refused the request before sending it (an invalid target): the slot is released and the peer told.
			settle(400, JSON.stringify({ error: "The request could not be sent" }));
		}
	}

	private open(message: Extract<TunnelRequest, { kind: "stream.open" }>): void {
		const id = message.stream;
		if (!validPath(message.path)) return this.send({ kind: "stream.end", stream: id, code: 1008 });
		if (this.streams.has(id) || this.streams.size >= MAX_STREAMS)
			return this.send({ kind: "stream.end", stream: id, code: 1013 });
		let socket: WebSocket;
		try {
			socket = new WebSocket(`ws://127.0.0.1:${this.loopback.port}${message.path}`, {
				headers: { Origin: this.loopback.origin },
				maxPayload: STREAM_BUFFER_LIMIT * 4,
			});
		} catch {
			return this.send({ kind: "stream.end", stream: id, code: 1008 });
		}
		this.streams.set(id, socket);
		socket.on("open", () =>
			socket.send(
				JSON.stringify({
					token: this.loopback.token,
					protocolVersion: APPLICATION_PROTOCOL_VERSION,
					...(message.cursor !== undefined ? { cursor: message.cursor } : {}),
				}),
			),
		);
		socket.on("message", (data, binary) => {
			if (binary || this.closed) return;
			this.send({ kind: "stream.message", stream: id, data: (data as Buffer).toString("utf8") });
		});
		socket.on("error", () => socket.terminate());
		socket.on("close", (code) => {
			if (this.streams.get(id) !== socket) return;
			this.streams.delete(id);
			if (!this.closed) this.send({ kind: "stream.end", stream: id, code });
		});
	}

	/** Closes the loopback socket; its close event then tells the peer the stream ended. */
	private end(id: string, code: number): void {
		this.streams.get(id)?.close(code);
	}

	close(): void {
		this.closed = true;
		for (const socket of this.streams.values()) socket.terminate();
		this.streams.clear();
	}
}
