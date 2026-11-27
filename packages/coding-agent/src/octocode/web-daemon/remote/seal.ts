import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { sha256 } from "@octocodeai/octocode-common/atomic-file";

/**
 * End-to-end sealing for relay links, wire version 1 (the exact format is in `docs/remote.md`). The link key travels
 * only in the link's fragment, which browsers never send to a server; the relay forwards frames it cannot read or
 * forge. Nothing is sealed under the link key itself: each peer connection derives two keys (one per direction) with
 * HKDF-SHA256 from the link key, the room and a fresh nonce from each side, so frames recorded from one connection
 * mean nothing to another. Every primitive here exists in WebCrypto (HKDF, AES-GCM, SHA-256) for the page.
 */
export const WIRE_VERSION = 1;
const KEY_BYTES = 32;
const NONCE_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** `d2p` is daemon to page, `p2d` page to daemon. */
export type Direction = "d2p" | "p2d";

export function newKey(): Buffer {
	return randomBytes(KEY_BYTES);
}

/** A fresh per-connection nonce: 16 random bytes. */
export function newNonce(): Buffer {
	return randomBytes(NONCE_BYTES);
}

export const encodeKey = (key: Buffer): string => key.toString("base64url");

export function decodeNonce(text: string): Buffer | undefined {
	if (!/^[A-Za-z0-9_-]{22}$/.test(text)) return undefined;
	const nonce = Buffer.from(text, "base64url");
	return nonce.length === NONCE_BYTES ? nonce : undefined;
}

/** The public room name for a key: a hash, so the relay and anyone reading its logs learn nothing about the key. */
export function roomOf(key: Buffer): string {
	return sha256(Buffer.concat([Buffer.from("octocode-remote-room"), key])).slice(0, 32);
}

/** A short public label of a capability (a token or a key), so a listing can name a link without revealing it. */
export function fingerprintOf(secret: Buffer | string): string {
	const bytes = typeof secret === "string" ? Buffer.from(secret) : secret;
	return sha256(Buffer.concat([Buffer.from("octocode-remote-fingerprint"), bytes])).slice(0, 8);
}

/**
 * The AES-256-GCM key for one direction of one peer connection:
 * `HKDF-SHA256(ikm = link key, salt = daemonNonce || pageNonce, info = "octocode-remote v1|<room>|<direction>", 32)`.
 */
export function directionKey(
	link: Buffer,
	room: string,
	daemonNonce: Buffer,
	pageNonce: Buffer,
	direction: Direction,
): Buffer {
	const salt = Buffer.concat([daemonNonce, pageNonce]);
	const info = Buffer.from(`octocode-remote v${WIRE_VERSION}|${room}|${direction}`);
	return Buffer.from(hkdfSync("sha256", link, salt, info, KEY_BYTES));
}

const validSeq = (seq: number): boolean => Number.isSafeInteger(seq) && seq >= 0;

/** The 96-bit frame IV: four zero bytes, then the sequence number as 64-bit big-endian. Unique per key because `seq` is. */
function ivOf(seq: number): Buffer {
	const iv = Buffer.alloc(IV_BYTES);
	iv.writeBigUInt64BE(BigInt(seq), 4);
	return iv;
}

/** The associated data: `"octocode-remote v1|<room>|<direction>|<seq decimal>"`. */
function aadOf(room: string, direction: Direction, seq: number): Buffer {
	return Buffer.from(`octocode-remote v${WIRE_VERSION}|${room}|${direction}|${seq}`);
}

/** Seals one message; the result is base64 of `ciphertext || 16-byte tag`. `seq` must not repeat under `key`. */
export function seal(key: Buffer, room: string, direction: Direction, seq: number, plaintext: string): string {
	if (!validSeq(seq)) throw new Error("Sequence out of range");
	const cipher = createCipheriv("aes-256-gcm", key, ivOf(seq));
	cipher.setAAD(aadOf(room, direction, seq));
	const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
	return Buffer.concat([body, cipher.getAuthTag()]).toString("base64");
}

/** The plaintext of a sealed message, or undefined for anything not sealed under this key, room, direction and `seq`. */
export function open(key: Buffer, room: string, direction: Direction, seq: number, sealed: string): string | undefined {
	if (!validSeq(seq)) return undefined;
	const bytes = Buffer.from(sealed, "base64");
	if (bytes.length < TAG_BYTES) return undefined;
	try {
		const decipher = createDecipheriv("aes-256-gcm", key, ivOf(seq));
		decipher.setAAD(aadOf(room, direction, seq));
		decipher.setAuthTag(bytes.subarray(bytes.length - TAG_BYTES));
		return Buffer.concat([decipher.update(bytes.subarray(0, bytes.length - TAG_BYTES)), decipher.final()]).toString(
			"utf8",
		);
	} catch {
		return undefined;
	}
}
