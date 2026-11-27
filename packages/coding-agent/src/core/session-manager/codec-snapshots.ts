import { createHash } from "node:crypto";
import { strictJsonText } from "./json-line.ts";

/**
 * A system prompt and its tool declarations are stored by the system message that sets them, and again by every
 * compaction (`systemMessage`, `systemBase`) and by a later update that repeats them. On disk each distinct part (the
 * prompt text, one section, one tool declaration) is written once per file: a later copy is `{ "$ref": <hash> }`, the
 * hash of the part's JSON, resolved against the copy written earlier in the same file. The file stays self-contained.
 * The JSON is the strict form a line stores (`json-line.ts`), so a part hashes the same in memory and read back.
 */
interface SnapshotRef {
	$ref: string;
}

/** Parts shorter than this stay inline: a reference would save little. */
const MIN_PART_CHARS = 512;

function isSnapshotRef(value: unknown): value is SnapshotRef {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const keys = Object.keys(value);
	return keys.length === 1 && keys[0] === "$ref" && typeof (value as SnapshotRef).$ref === "string";
}

function hashOf(json: string): string {
	return createHash("sha256").update(json).digest("hex").slice(0, 32);
}

type Part = (value: unknown) => unknown;

/** Calls `part` on each storable part of a system message (prompt text, each section, each added tool) and returns the copy it builds. */
function mapSystemMessage(message: unknown, part: Part): unknown {
	if (typeof message !== "object" || message === null || Array.isArray(message)) return message;
	const record = message as Record<string, unknown>;
	const copy: Record<string, unknown> = { ...record };
	if ("content" in record) copy.content = part(record.content);
	const sections = record.sections;
	if (typeof sections === "object" && sections !== null && !Array.isArray(sections)) {
		copy.sections = Object.fromEntries(Object.entries(sections).map(([name, value]) => [name, part(value)]));
	}
	if (Array.isArray(record.toolsAdded)) copy.toolsAdded = record.toolsAdded.map(part);
	return copy;
}

/** The system messages an entry stores: a system message entry, or a compaction's folded and base states. */
function mapEntrySnapshots(entry: Record<string, unknown>, part: Part): Record<string, unknown> {
	if (entry.type === "message") {
		const message = entry.message as { role?: unknown } | undefined;
		return message?.role === "system" ? { ...entry, message: mapSystemMessage(message, part) } : entry;
	}
	if (entry.type === "compaction") {
		const copy = { ...entry };
		if (entry.systemMessage !== undefined) copy.systemMessage = mapSystemMessage(entry.systemMessage, part);
		if (entry.systemBase !== undefined) copy.systemBase = mapSystemMessage(entry.systemBase, part);
		return copy;
	}
	return entry;
}

function holdsSnapshots(entry: Record<string, unknown>): boolean {
	if (entry.type === "compaction") return entry.systemMessage !== undefined || entry.systemBase !== undefined;
	return entry.type === "message" && (entry.message as { role?: unknown } | undefined)?.role === "system";
}

/** The distinct snapshot parts one file holds so far, by hash, as the JSON written for them. */
export class SnapshotIndex {
	private readonly parts = new Map<string, string>();

	/** Holds a part written in full. A file written before the strict form refers to it by the hash of `JSON.stringify`. */
	private remember(value: unknown): void {
		const raw = JSON.stringify(value) as string | undefined;
		if (raw === undefined || raw.length < MIN_PART_CHARS) return;
		const json = strictJsonText(raw);
		this.parts.set(hashOf(json), json);
		if (raw !== json) this.parts.set(hashOf(raw), json);
	}

	/** Remember the parts of an entry the file now holds. */
	add(entry: Record<string, unknown>): void {
		if (!holdsSnapshots(entry)) return;
		mapEntrySnapshots(entry, (value) => {
			if (value !== undefined && !isSnapshotRef(value)) this.remember(value);
			return value;
		});
	}

	/** The stored form of an entry: each part this file already holds becomes a reference to it. */
	encode(entry: Record<string, unknown>): Record<string, unknown> {
		if (!holdsSnapshots(entry)) return entry;
		const added = new Map<string, string>();
		return mapEntrySnapshots(entry, (value) => {
			if (value === undefined || isSnapshotRef(value)) return value;
			const raw = JSON.stringify(value) as string | undefined;
			if (raw === undefined || raw.length < MIN_PART_CHARS) return value;
			const json = strictJsonText(raw);
			const hash = hashOf(json);
			// The same part twice in one entry (a compaction's base and folded state) is written once, at its first place.
			if (this.parts.get(hash) === json || added.get(hash) === json) return { $ref: hash };
			added.set(hash, json);
			return value;
		});
	}

	/** The entry with every reference replaced by the part it names; a reference this file does not hold stays as written. */
	decode(entry: Record<string, unknown>): Record<string, unknown> {
		if (!holdsSnapshots(entry)) return entry;
		// Parts defined earlier in the same entry resolve later references in it, in the order `encode` wrote them.
		return mapEntrySnapshots(entry, (value) => {
			if (!isSnapshotRef(value)) {
				if (value !== undefined) this.remember(value);
				return value;
			}
			const json = this.parts.get(value.$ref);
			return json === undefined ? value : JSON.parse(json);
		});
	}
}
