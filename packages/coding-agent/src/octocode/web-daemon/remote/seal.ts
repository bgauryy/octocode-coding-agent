import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { sha256 } from "../../../utils/atomic-file.ts";

/**
 * End-to-end sealing for relay links. The key travels only in the link's fragment, which browsers never send to a
 * server; the relay forwards sealed frames it cannot read. AES-256-GCM, a fresh 96-bit nonce per frame, the room id as
 * associated data so a frame cannot be replayed into another room. The room id is derived from the key, so a link
 * needs nothing but the key and whoever holds the key can find the room while the relay never learns the key.
 */
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export function newKey(): Buffer {
	return randomBytes(KEY_BYTES);
}

export const encodeKey = (key: Buffer): string => key.toString("base64url");

export function decodeKey(text: string): Buffer | undefined {
	if (!/^[A-Za-z0-9_-]{43}$/.test(text)) return undefined;
	const key = Buffer.from(text, "base64url");
	return key.length === KEY_BYTES ? key : undefined;
}

/** The public room name for a key: a hash, so the relay and anyone reading its logs learn nothing about the key. */
export function roomOf(key: Buffer): string {
	return sha256(Buffer.concat([Buffer.from("octocode-remote-room"), key])).slice(0, 32);
}

export function seal(key: Buffer, room: string, plaintext: string): string {
	const nonce = randomBytes(NONCE_BYTES);
	const cipher = createCipheriv("aes-256-gcm", key, nonce);
	cipher.setAAD(Buffer.from(room));
	const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
	return Buffer.concat([nonce, body, cipher.getAuthTag()]).toString("base64");
}

/** The plaintext of a sealed frame, or undefined for anything not sealed with this key for this room. */
export function open(key: Buffer, room: string, sealed: string): string | undefined {
	let bytes: Buffer;
	try {
		bytes = Buffer.from(sealed, "base64");
	} catch {
		return undefined;
	}
	if (bytes.length < NONCE_BYTES + TAG_BYTES) return undefined;
	const nonce = bytes.subarray(0, NONCE_BYTES);
	const tag = bytes.subarray(bytes.length - TAG_BYTES);
	const body = bytes.subarray(NONCE_BYTES, bytes.length - TAG_BYTES);
	try {
		const decipher = createDecipheriv("aes-256-gcm", key, nonce);
		decipher.setAAD(Buffer.from(room));
		decipher.setAuthTag(tag);
		return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
	} catch {
		return undefined;
	}
}
