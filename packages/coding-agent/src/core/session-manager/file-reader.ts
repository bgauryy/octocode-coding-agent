import { closeSync, existsSync, fstatSync, openSync, readSync } from "node:fs";
import { open } from "node:fs/promises";
import { setImmediate as yieldToInput } from "node:timers/promises";
import { normalizePath } from "../../../../common/src/paths.ts";
import { SessionCodec } from "./codec.ts";
import { EntryIndex } from "./entry-index.ts";
import { parseSessionEntryLine } from "./entries.ts";
import { indexSessionEntry } from "./tree.ts";
import type { FileEntry } from "./types.ts";

const READ_BYTES = 1024 * 1024;
const SLICE_MS = 4;

/** A single pass builds the codec and indexes as well as the entries; opening never scans them again. */
export class LoadedSessionFile {
	readonly entries: FileEntry[] = [];
	readonly codec = new SessionCodec();
	readonly byId = new EntryIndex();
	readonly labelsById = new Map<string, string>();
	readonly labelTimestampsById = new Map<string, string>();
	leafId: string | null = null;
	/** Size before reading: later appends are merged on the next write, even if this read already saw them. */
	fileSize = 0;
	private invalidHeader = false;
	private readonly decoder = new TextDecoder("utf-8", { ignoreBOM: true });
	private readonly pending: string[] = [];

	*lines(bytes?: Uint8Array): Generator<string> {
		const chunk = this.decoder.decode(bytes, { stream: bytes !== undefined });
		let start = 0;
		for (let end = chunk.indexOf("\n"); end !== -1; end = chunk.indexOf("\n", start)) {
			this.pending.push(chunk.slice(start, end));
			const line = this.pending.join("");
			this.pending.length = 0;
			yield line;
			start = end + 1;
		}
		if (start < chunk.length) this.pending.push(chunk.slice(start));
		if (bytes === undefined) {
			yield this.pending.join("");
			this.pending.length = 0;
		}
	}

	append(line: string): void {
		if (this.invalidHeader) return;
		const record = parseSessionEntryLine(line);
		if (!record) return;
		if (this.entries.length === 0 && (record.type !== "session" || typeof record.id !== "string")) {
			this.invalidHeader = true;
			return;
		}
		const entry = this.codec.decode(record);
		this.entries.push(entry);
		if (entry.type === "session") return;
		indexSessionEntry(entry, this.byId, this.labelsById, this.labelTimestampsById);
		this.leafId = entry.id;
	}
}

export function loadSessionFile(filePath: string): LoadedSessionFile {
	const file = normalizePath(filePath);
	const loaded = new LoadedSessionFile();
	if (!existsSync(file)) return loaded;
	const fd = openSync(file, "r");
	try {
		loaded.fileSize = fstatSync(fd).size;
		const buffer = Buffer.allocUnsafe(READ_BYTES);
		for (;;) {
			const bytes = readSync(fd, buffer, 0, buffer.length, null);
			if (bytes === 0) break;
			for (const line of loaded.lines(buffer.subarray(0, bytes))) loaded.append(line);
		}
		for (const line of loaded.lines()) loaded.append(line);
		return loaded;
	} finally {
		closeSync(fd);
	}
}

/** Async disk reads and bounded parse/decode/index slices keep input responsive during a resume. */
export async function loadSessionFileAsync(filePath: string, signal?: AbortSignal): Promise<LoadedSessionFile> {
	signal?.throwIfAborted();
	const loaded = new LoadedSessionFile();
	const handle = await open(normalizePath(filePath), "r").catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return undefined;
		throw error;
	});
	if (!handle) return loaded;
	try {
		loaded.fileSize = (await handle.stat()).size;
		const buffer = Buffer.allocUnsafe(READ_BYTES);
		let deadline = performance.now() + SLICE_MS;
		for (;;) {
			signal?.throwIfAborted();
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
			for (const line of loaded.lines(bytesRead === 0 ? undefined : buffer.subarray(0, bytesRead))) {
				loaded.append(line);
				if (performance.now() >= deadline) {
					await yieldToInput(undefined, { signal });
					deadline = performance.now() + SLICE_MS;
				}
			}
			if (bytesRead === 0) break;
		}
		signal?.throwIfAborted();
		return loaded;
	} finally {
		await handle.close();
	}
}
