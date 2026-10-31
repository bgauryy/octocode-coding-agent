import type { WebSocket } from "ws";
import { afterEach, expect, vi } from "vitest";
import { sharedAgentDb } from "../../src/octocode/agentdb/db.ts";
import { BacklogStore } from "../../src/octocode/backlog/store.ts";
import { decodeKey, roomOf } from "../../src/octocode/web-daemon/remote/seal.ts";
import { startDaemonServer, type DaemonServer } from "../../src/octocode/web-daemon/server.ts";
import { startRelayFixture } from "./remote-relay-fixture.ts";
import { isolatedEnv } from "./web-daemon-fixture.ts";

export const REPO_KEY = "/work/demo/.git";

export const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	for (const fn of cleanup.splice(0).reverse()) await fn();
});

/** A daemon server with one backlog item, and a caller for `/api/admin/remote` with any token. */
export async function daemon() {
	const { env } = isolatedEnv();
	const server: DaemonServer = await startDaemonServer({
		env,
		onActivity: () => {},
		config: async () => ({ protocolVersion: 1, providers: [] }),
		onDrain: () => {},
	});
	cleanup.push(() => server.close());
	const origin = `http://127.0.0.1:${server.port}`;
	const call = (token: string, method: string, body?: unknown, path = "/api/admin/remote") =>
		fetch(origin + path, {
			method,
			headers: { Authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
			...(body ? { body: JSON.stringify(body) } : {}),
		});
	new BacklogStore(() => sharedAgentDb(env), REPO_KEY).add(
		{ title: "Daemon item", goal: "Seen remotely", createdBy: "tester" },
		{ id: "tester" },
	);
	return { env, server, origin, call };
}

/** A daemon publishing one relay room of `access` on a fresh relay fixture, connected and waiting for pages. */
export async function publishRelay(access: "view" | "control", options: { prefix?: string } = {}) {
	const running = await daemon();
	return { ...running, ...(await publishOn(running.server, access, options)) };
}

/** Publishes one relay room of `access` for `server` on a fresh relay fixture and waits until the daemon is connected. */
export async function publishOn(
	server: Pick<DaemonServer, "remote" | "port" | "token">,
	access: "view" | "control",
	options: { prefix?: string } = {},
) {
	const relay = await startRelayFixture(options);
	cleanup.push(() => relay.close());
	const published = server.remote.publish({ transport: "relay", access, relayUrl: relay.url });
	const link = new URL(published.url);
	const key = decodeKey(link.hash.slice(3))!;
	const room = roomOf(key);
	await vi.waitFor(() => expect(relay.rooms.get(room)?.host).toBeDefined());
	await vi.waitFor(() => expect((server.remote.status().relay as { state: string }).state).toBe("connected"));
	return { relay, link, key, room };
}

const text = new TextEncoder();
const b64 = (bytes: ArrayBuffer | Uint8Array): string => Buffer.from(bytes as ArrayBuffer).toString("base64");
const b64url = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");
const subtle = globalThis.crypto.subtle;
type CryptoKey = Awaited<ReturnType<typeof subtle.importKey>>;

/** `sha256("octocode-remote-room" || key)` as hex, first 32 characters. */
export async function pageRoom(key: Uint8Array): Promise<string> {
	const digest = await subtle.digest("SHA-256", Buffer.concat([text.encode("octocode-remote-room"), key]));
	return Buffer.from(digest).toString("hex").slice(0, 32);
}

/** One direction's AES-GCM key: HKDF-SHA256(link key, salt = daemon nonce || page nonce, info = "octocode-remote v1|room|dir"). */
async function direction(key: Uint8Array, room: string, salt: Uint8Array, dir: "d2p" | "p2d"): Promise<CryptoKey> {
	// Copies give ArrayBuffer-backed views, which WebCrypto's BufferSource type requires.
	const base = await subtle.importKey("raw", new Uint8Array(key), "HKDF", false, ["deriveBits"]);
	const bits = await subtle.deriveBits(
		{
			name: "HKDF",
			hash: "SHA-256",
			salt: new Uint8Array(salt),
			info: text.encode(`octocode-remote v1|${room}|${dir}`),
		},
		base,
		256,
	);
	return subtle.importKey("raw", bits, "AES-GCM", false, ["encrypt", "decrypt"]);
}

function params(room: string, dir: "d2p" | "p2d", seq: number) {
	const iv = new Uint8Array(12);
	new DataView(iv.buffer).setBigUint64(4, BigInt(seq));
	return { name: "AES-GCM", iv, additionalData: text.encode(`octocode-remote v1|${room}|${dir}|${seq}`) };
}

/**
 * A page's side of a relay room, as a browser would write it: only WebCrypto (HKDF, AES-GCM, SHA-256). It waits for the
 * daemon's `hello`, answers with `join`, then exchanges sealed `msg` frames. `sent` keeps every frame it sent, for replay tests.
 */
export function pageOver(socket: WebSocket, key: Buffer, options: { nonce?: Uint8Array; join?: boolean } = {}) {
	const received: Array<Record<string, unknown>> = [];
	const sent: string[] = [];
	let seq = 0;
	let expected = 0;
	let receiveKey: CryptoKey | undefined;
	let sendKey: CryptoKey | undefined;
	let room = "";
	let markReady!: () => void;
	const ready = new Promise<void>((resolve) => (markReady = resolve));
	/** Runs async work one after another, so frames keep their order. */
	const inOrder = () => {
		let chain: Promise<unknown> = Promise.resolve();
		return <T>(work: () => Promise<T>): Promise<T> => {
			const next = chain.then(work);
			chain = next.catch(() => undefined);
			return next;
		};
	};
	const incoming = inOrder();
	const outgoing = inOrder();
	socket.on(
		"message",
		(data) =>
			void incoming(async () => {
				const frame = JSON.parse(String(data)) as { v: number; t: string; nonce?: string; s?: number; d?: string };
				if (frame.t === "hello") {
					if (options.join === false) return;
					const pageNonce = options.nonce ?? globalThis.crypto.getRandomValues(new Uint8Array(16));
					const daemonNonce = Buffer.from(frame.nonce!, "base64url");
					room = await pageRoom(key);
					const salt = Buffer.concat([daemonNonce, pageNonce]);
					receiveKey = await direction(key, room, salt, "d2p");
					sendKey = await direction(key, room, salt, "p2d");
					socket.send(JSON.stringify({ v: 1, t: "join", nonce: b64url(pageNonce) }));
					markReady();
					return;
				}
				if (frame.t !== "msg" || !receiveKey || frame.s !== expected) throw new Error("unexpected frame");
				const plain = await subtle.decrypt(params(room, "d2p", expected), receiveKey, Buffer.from(frame.d!, "base64"));
				expected++;
				received.push(JSON.parse(Buffer.from(plain).toString("utf8")));
			}).catch(() => socket.close()),
	);
	return {
		received,
		sent,
		ready,
		/** Seals and sends one tunnel message as the next `msg` frame. */
		send: (message: Record<string, unknown>) =>
			outgoing(async () => {
				await ready;
				const s = seq++;
				const sealed = await subtle.encrypt(params(room, "p2d", s), sendKey!, text.encode(JSON.stringify(message)));
				const frame = JSON.stringify({ v: 1, t: "msg", s, d: b64(sealed) });
				sent.push(frame);
				socket.send(frame);
			}),
		sendRaw: (frame: string) => socket.send(frame),
		closed: new Promise<number>((resolve) => socket.on("close", (code) => resolve(code))),
	};
}
