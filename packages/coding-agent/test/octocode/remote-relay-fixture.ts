import type { AddressInfo } from "node:net";
import { WebSocket, WebSocketServer } from "ws";

interface Room {
	host?: WebSocket;
	peers: Map<string, WebSocket>;
	next: number;
}

/**
 * A content-blind relay for tests: `/v1/rooms/<room>/host` is the daemon's side, `/v1/rooms/<room>/peer` a page's.
 * It forwards sealed strings and tells the host who joined and left; it reads nothing else.
 */
export async function startRelayFixture(): Promise<{
	url: string;
	rooms: Map<string, Room>;
	peer(room: string): Promise<WebSocket>;
	close(): Promise<void>;
}> {
	const rooms = new Map<string, Room>();
	const room = (name: string): Room => {
		let found = rooms.get(name);
		if (!found) {
			found = { peers: new Map(), next: 1 };
			rooms.set(name, found);
		}
		return found;
	};
	const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
	server.on("connection", (socket, request) => {
		const match = /^\/v1\/rooms\/([0-9a-f]{32})\/(host|peer)$/.exec(request.url ?? "");
		if (!match) return socket.close(1008);
		const current = room(match[1]);
		if (match[2] === "host") {
			current.host?.close(1012);
			current.host = socket;
			socket.on("message", (data) => {
				const frame = JSON.parse(String(data)) as { type: string; peer: string; data?: string };
				const peer = current.peers.get(frame.peer);
				if (!peer) return;
				if (frame.type === "peer.message") peer.send(frame.data ?? "");
				else if (frame.type === "peer.close") peer.close(1000);
			});
			socket.on("close", () => {
				if (current.host === socket) current.host = undefined;
				for (const peer of current.peers.values()) peer.close(1012);
			});
			return;
		}
		const id = `p${current.next++}`;
		current.peers.set(id, socket);
		current.host?.send(JSON.stringify({ type: "peer.open", peer: id }));
		socket.on("message", (data) =>
			current.host?.send(JSON.stringify({ type: "peer.message", peer: id, data: String(data) })),
		);
		socket.on("close", () => {
			current.peers.delete(id);
			current.host?.send(JSON.stringify({ type: "peer.close", peer: id }));
		});
	});
	await new Promise<void>((resolve) => server.on("listening", resolve));
	const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
	return {
		url,
		rooms,
		peer: (name) =>
			new Promise((resolve, reject) => {
				const socket = new WebSocket(`${url}/v1/rooms/${name}/peer`);
				socket.once("open", () => resolve(socket));
				socket.once("error", reject);
			}),
		close: () =>
			new Promise((resolve) => {
				for (const client of server.clients) client.terminate();
				server.close(() => resolve());
			}),
	};
}
