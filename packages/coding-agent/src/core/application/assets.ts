import { runtimeTempDir } from "../../storage/runtime-paths.ts";
import { createHash, type Hash } from "node:crypto";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";

import { join } from "node:path";
import { DISPLAY_OUTPUT_MAX_BYTES, readOutputFile } from "../../utils/output-files.ts";
import {
	APPLICATION_UPLOAD_BYTES,
	APPLICATION_IMAGE_MIME_TYPES,
	type ApplicationAsset,
	type ApplicationAssetInput,
	type ApplicationAssetPayload,
} from "@octocodeai/octocode-contracts";

const ASSET_BYTES = 32 * 1024 * 1024;
const SESSION_BYTES = 256 * 1024 * 1024;
const IMAGE_TYPES = new Set<string>(APPLICATION_IMAGE_MIME_TYPES);
/** Appended bytes kept in memory before they are written. */
const PENDING_BYTES = 64 * 1024;
const slotId = (slot: string) => createHash("sha256").update("stream:").update(slot).digest("hex");
/** Text whose UTF-8 bytes depend on a neighbouring chunk: it starts or ends inside a surrogate pair. */
const splitsPair = (text: string) => /^[\uDC00-\uDFFF]/.test(text) || /[\uD800-\uDBFF]$/.test(text);

/** How many recently written text slots keep their text in memory for `get`. */
const RECENT_TEXTS = 8;

/** Session-owned spill storage. Only registered opaque IDs can be read; no user-controlled paths enter filesystem IO. */
export class ApplicationAssets {
	private directory?: string;
	private bytes = 0;
	private readonly assets = new Map<
		string,
		// `hash` holds a streamed text asset's digest state, so `append` hashes only the new bytes; `pending` holds
		// appended bytes not yet stored, so a token costs no file write.
		{
			asset: ApplicationAsset;
			encoding: ApplicationAssetPayload["encoding"];
			value?: Buffer;
			hash?: Hash;
			pending?: { chunks: Buffer[]; bytes: number };
			/** A completed output file of this process, read when the asset is read (`putOutputFile`). */
			file?: string;
		}
	>();
	private readonly options: { memory?: boolean; tempDir?: () => string };
	private readonly openSlots = new Set<string>();
	constructor(options: { memory?: boolean; tempDir?: () => string } = {}) {
		this.options = options;
	}

	put(
		data: string,
		mimeType: string,
		encoding: ApplicationAssetPayload["encoding"] = "utf8",
		name?: string,
		slot?: string,
	): ApplicationAsset {
		const value = Buffer.from(data, encoding === "base64" ? "base64" : "utf8");
		const asset = this.putValue(value, mimeType, encoding, name, slot);
		if (slot && encoding === "utf8" && asset.revision) this.remember(asset.id, asset.revision, data);
		return asset;
	}

	/**
	 * The text of the slots written last, by id: a streamed block is read back by the terminal after every delta, and
	 * reading the whole file each time made a long reply cost more with every token. A few slots are kept (the blocks
	 * of the message being streamed); `get` uses an entry only while its revision is the asset's.
	 */
	private readonly texts = new Map<string, { revision: string; data: string }>();

	private remember(id: string, revision: string, data: string): void {
		this.texts.delete(id);
		this.texts.set(id, { revision, data });
		if (this.texts.size > RECENT_TEXTS) this.texts.delete(this.texts.keys().next().value as string);
	}

	/** Store bytes already decoded and validated by upload without decoding the base64 a second time. */
	private putValue(
		value: Buffer,
		mimeType: string,
		encoding: ApplicationAssetPayload["encoding"],
		name?: string,
		slot?: string,
	): ApplicationAsset {
		if (value.length > ASSET_BYTES) throw new Error("Application asset exceeds the 32 MiB limit");
		const digest = createHash("sha256").update(mimeType).update("\0").update(encoding).update("\0").update(value);
		const hash = slot && encoding === "utf8" ? digest.copy() : undefined;
		const revision = digest.digest("hex");
		const id = slot ? slotId(slot) : revision;
		const existing = this.assets.get(id);
		if (existing?.asset.revision === revision || (existing && !slot)) return { ...existing.asset };
		const nextBytes = this.bytes - (existing?.asset.size ?? 0) + value.length;
		if (nextBytes > SESSION_BYTES) throw new Error("Application session assets exceed the 256 MiB limit");
		const asset: ApplicationAsset = {
			id,
			mimeType,
			size: value.length,
			...(slot ? { revision } : {}),
			...(name ? { name: name.slice(0, 255) } : {}),
		};
		if (!this.options.memory) {
			this.directory ??= mkdtempSync(join((this.options.tempDir ?? runtimeTempDir)(), "octocode-application-"));
			writeFileSync(join(this.directory, id), value, { mode: 0o600, flag: existing ? "w" : "wx" });
		}
		this.assets.set(id, { asset, encoding, ...(this.options.memory ? { value } : {}), ...(hash ? { hash } : {}) });
		if (hash) this.openSlots.add(id);
		this.bytes = nextBytes;
		return { ...asset };
	}

	/**
	 * Extend the text `put` stored under `slot` by `data`, hashing and writing only the new bytes; the result equals
	 * putting the whole text. Undefined when the slot holds no text to extend, a limit would be passed, or `data` splits a
	 * surrogate pair: put the whole text then.
	 */
	append(slot: string, data: string): ApplicationAsset | undefined {
		const stored = this.assets.get(slotId(slot));
		if (!stored?.hash || splitsPair(data)) return undefined;
		const value = Buffer.from(data, "utf8");
		const size = stored.asset.size + value.length;
		if (size > ASSET_BYTES || this.bytes + value.length > SESSION_BYTES) return undefined;
		stored.pending ??= { chunks: [], bytes: 0 };
		stored.pending.chunks.push(value);
		stored.pending.bytes += value.length;
		if (stored.pending.bytes >= PENDING_BYTES) this.store(stored);
		else this.openSlots.add(stored.asset.id);
		stored.hash.update(value);
		const before = stored.asset.revision;
		stored.asset = { ...stored.asset, size, revision: stored.hash.copy().digest("hex") };
		this.bytes += value.length;
		const text = this.texts.get(stored.asset.id);
		if (text && text.revision === before && stored.asset.revision)
			this.remember(stored.asset.id, stored.asset.revision, text.data + data);
		else this.texts.delete(stored.asset.id);
		return { ...stored.asset };
	}

	/**
	 * A user shell command's spilled output as a text asset that is read from its file, with carriage returns removed as
	 * the shell view shows it, each time it is read: a view that shows the command by its ends never reads or copies the
	 * rest. `size` is the file's; the id and revision name the file and its size, never its path.
	 */
	putOutputFile(path: string, size: number, slot: string): ApplicationAsset {
		const id = slotId(slot);
		const revision = createHash("sha256").update(`${path}\0${size}`).digest("hex");
		const asset: ApplicationAsset = { id, mimeType: "text/plain", size, revision };
		this.assets.set(id, { asset, encoding: "utf8", file: path });
		return { ...asset };
	}

	get(id: string): ApplicationAssetPayload | undefined {
		const stored = this.assets.get(id);
		if (!stored) return undefined;
		if (stored.file !== undefined) {
			const text = readOutputFile(stored.file, DISPLAY_OUTPUT_MAX_BYTES)?.replace(/\r/g, "");
			return text === undefined ? undefined : { asset: { ...stored.asset }, encoding: "utf8", data: text };
		}
		const text = this.texts.get(id);
		if (text && text.revision === stored.asset.revision && stored.encoding === "utf8")
			return { asset: { ...stored.asset }, encoding: stored.encoding, data: text.data };
		this.store(stored);
		const value = stored.value ?? readFileSync(join(this.directory!, stored.asset.id));
		const data = value.toString(stored.encoding === "base64" ? "base64" : "utf8");
		return { asset: { ...stored.asset }, encoding: stored.encoding, data };
	}

	/** Write appended bytes to the asset's storage. */
	private store(stored: { asset: ApplicationAsset; value?: Buffer; pending?: { chunks: Buffer[] } }): void {
		if (!stored.pending) return;
		const bytes = Buffer.concat(stored.pending.chunks);
		stored.pending = undefined;
		if (stored.value) stored.value = Buffer.concat([stored.value, bytes]);
		else appendFileSync(join(this.directory!, stored.asset.id), bytes);
	}

	upload(input: ApplicationAssetInput): ApplicationAsset {
		if (!IMAGE_TYPES.has(input.mimeType)) throw new Error("Upload a PNG, JPEG, GIF, or WebP image");
		if (!input.data || input.data.length > Math.ceil(APPLICATION_UPLOAD_BYTES / 3) * 4)
			throw new Error("Image must contain data and be at most 20 MiB");
		if (input.data.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(input.data))
			throw new Error("Image data must be valid base64");
		const value = Buffer.from(input.data, "base64");
		if (value.length > APPLICATION_UPLOAD_BYTES || value.toString("base64") !== input.data)
			throw new Error("Image data is invalid or exceeds 20 MiB");
		return this.putValue(value, input.mimeType, "base64", input.name);
	}

	/** Flush pending streamed buffers and release native `Hash` contexts once streaming finishes. */
	finalizePending(): void {
		for (const id of this.openSlots) {
			const stored = this.assets.get(id);
			if (!stored) continue;
			this.store(stored);
			stored.hash = undefined;
		}
		this.openSlots.clear();
	}

	clear(): void {
		if (this.directory) rmSync(this.directory, { recursive: true, force: true });
		this.directory = undefined;
		this.assets.clear();
		this.openSlots.clear();
		this.texts.clear();
		this.bytes = 0;
	}
}
