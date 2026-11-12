import { readSavedOutput } from "../saved-output.ts";

/**
 * How a bash result is stored in a session file. At run time it holds its output up to three times: in `content` (what
 * the model reads), in `details.output` (the same text without the header line, for renderers) and in
 * `structuredContent.output` (for programmatic callers; up to 1 MiB read back from the saved full output). On disk,
 * `output` is replaced by `outputAt: [start, length]` when it is a span of the content text, and
 * `structuredContent.output` by `outputFile: <path>` when it is what that saved file reads back as. Reading puts
 * `output` back in its place: from the content text, or, for `outputFile`, from the file when a caller first reads it.
 */

/** Most bytes of `structuredContent.output` that programmatic callers receive. */
export const STRUCTURED_OUTPUT_MAX_BYTES = 1024 * 1024;

/** Outputs shorter than this stay inline: a reference would save little. */
const MIN_OUTPUT_CHARS = 64;

type Record_ = Record<string, unknown>;

const isRecord = (value: unknown): value is Record_ =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** The saved full output as `structuredContent.output` holds it, or undefined when the file cannot be read. */
function savedOutput(path: string): string | undefined {
	try {
		return readSavedOutput(path, STRUCTURED_OUTPUT_MAX_BYTES).content;
	} catch {
		return undefined;
	}
}

/**
 * Structured contents known to hold what a saved output file reads back as, by that file's path: one the bash tool
 * built from the file (`output` is the text it read), or one whose `output` is read from the file when first read
 * (no `output` here). Storing either needs no read of the file.
 */
const savedOutputs = new WeakMap<object, { path: string; output?: string }>();

/** Remember that `structured.output` is what the file at `path` reads back as (`readSavedOutput`), as just read. */
export function rememberSavedOutput(structured: { output?: unknown }, path: string): void {
	if (typeof structured.output === "string") savedOutputs.set(structured, { path, output: structured.output });
}

/**
 * Carry what `rememberSavedOutput` knows about `structured` to `next`, a copy with other fields changed, holding the
 * same output, whose file is now at `path` (moved) or where it was.
 */
export function carrySavedOutput(structured: unknown, next: object, path?: string): void {
	const saved = isRecord(structured) ? savedOutputs.get(structured) : undefined;
	if (saved?.output === undefined || (next as Record_).output !== saved.output) return;
	savedOutputs.set(next, { path: path ?? saved.path, output: saved.output });
}

/** The saved file `structured` holds the output of, when known without reading it; else undefined. */
function knownSavedPath(structured: Record_): string | undefined {
	const saved = savedOutputs.get(structured);
	if (!saved) return undefined;
	// A remembered output changed in place since is no longer the file's text.
	if (saved.output !== undefined && structured.output !== saved.output) return undefined;
	return saved.path;
}

/**
 * Copy of `record` with the key `from` renamed to `to` and given `value`, in the same place. `from` is never read, so
 * an `output` still to be read from its file stays unread.
 */
function replaceKey(record: Record_, from: string, to: string, value: unknown): Record_ {
	const copy: Record_ = {};
	for (const key of Object.keys(record)) copy[key === from ? to : key] = key === from ? value : record[key];
	return copy;
}

const isBashResult = (message: Record_): boolean => message.role === "toolResult" && message.toolName === "bash";

/** The one text block of a result's content, which every bash result has. */
function contentText(message: Record_): string | undefined {
	const content = message.content;
	if (!Array.isArray(content) || content.length !== 1) return undefined;
	const block = content[0] as Record_ | undefined;
	return block?.type === "text" && typeof block.text === "string" ? block.text : undefined;
}

function spanOf(text: string | undefined, output: unknown): [number, number] | undefined {
	if (text === undefined || typeof output !== "string" || output.length < MIN_OUTPUT_CHARS) return undefined;
	const start = text.indexOf(output);
	return start >= 0 ? [start, output.length] : undefined;
}

function storedStructured(structured: Record_, text: string | undefined, fullOutputPath: unknown): Record_ {
	const saved = knownSavedPath(structured);
	if (saved !== undefined) return replaceKey(structured, "output", "outputFile", saved);
	const span = spanOf(text, structured.output);
	if (span) return replaceKey(structured, "output", "outputAt", span);
	if (typeof fullOutputPath === "string" && typeof structured.output === "string") {
		// Only when the file reads back as exactly this text, so reading the result later restores it. Remembered,
		// so storing this result again (a rewrite of the whole file) does not read the file again.
		if (savedOutput(fullOutputPath) === structured.output) {
			rememberSavedOutput(structured, fullOutputPath);
			return replaceKey(structured, "output", "outputFile", fullOutputPath);
		}
	}
	return structured;
}

/** The stored form of a bash tool result message: the copies of its output become references. */
export function storeBashResult(message: Record_): Record_ {
	const text = contentText(message);
	const details = isRecord(message.details) ? message.details : undefined;
	const structured = isRecord(message.structuredContent) ? message.structuredContent : undefined;
	let stored = message;
	const detailsSpan = spanOf(text, details?.output);
	if (details && detailsSpan) stored = { ...stored, details: replaceKey(details, "output", "outputAt", detailsSpan) };
	if (structured && "output" in structured) {
		const kept = storedStructured(structured, text, details?.fullOutputPath);
		if (kept !== structured) stored = { ...stored, structuredContent: kept };
	}
	return stored;
}

function restoredSpan(record: Record_, text: string | undefined): Record_ {
	const span = record.outputAt;
	if (text === undefined || !Array.isArray(span) || typeof span[0] !== "number" || typeof span[1] !== "number")
		return record;
	return replaceKey(record, "outputAt", "output", text.slice(span[0], span[0] + span[1]));
}

/** `structured` with `output` read from `path` when first read (and kept from then on), in the place `outputFile` held. */
function lazyOutput(structured: Record_, path: string): Record_ {
	const restored: Record_ = {};
	for (const [key, value] of Object.entries(structured)) {
		if (key !== "outputFile") {
			restored[key] = value;
			continue;
		}
		// Read from the file, the value is still the file's text; assigned, it is not.
		const settle = (value: string | undefined, read: boolean) => {
			Object.defineProperty(restored, "output", { value, enumerable: true, writable: true, configurable: true });
			if (read && value !== undefined) savedOutputs.set(restored, { path, output: value });
			else savedOutputs.delete(restored);
		};
		Object.defineProperty(restored, "output", {
			enumerable: true,
			configurable: true,
			get: () => {
				const value = savedOutput(path);
				settle(value, true);
				return value;
			},
			set: (value: string | undefined) => {
				settle(value, false);
			},
		});
	}
	savedOutputs.set(restored, { path });
	return restored;
}

/** The released form of each structured content `savedOutputTwin` was asked for: one per original, so views can match them. */
const twins = new WeakMap<object, Record_>();

/**
 * `structured` with its `output` read from its saved file when first read, as on resume (`restoreBashResult` of a stored
 * `outputFile`): the same object for the same `structured`. Undefined unless `rememberSavedOutput` knows the output is
 * that file's text; `structured` itself is unchanged, so whoever already holds it keeps its value.
 */
export function savedOutputTwin(structured: unknown): Record_ | undefined {
	if (!isRecord(structured)) return undefined;
	const known = twins.get(structured);
	if (known) return known;
	const saved = savedOutputs.get(structured);
	if (saved?.output === undefined || knownSavedPath(structured) === undefined) return undefined;
	const twin = lazyOutput(replaceKey(structured, "output", "outputFile", saved.path), saved.path);
	twins.set(structured, twin);
	return twin;
}

/**
 * Once a bash call has returned, its result message holds `savedOutputTwin` of its structured content: the output (up
 * to 1 MiB) for programmatic callers is read from its saved file only when something reads it. The tool's end event
 * already carried the value.
 */
export function releaseSavedOutput(message: Record_): void {
	if (!isBashResult(message)) return;
	const twin = savedOutputTwin(message.structuredContent);
	if (twin) message.structuredContent = twin;
}

/** The bash tool result message a stored one describes: every `output` back in its place. */
export function restoreBashResult(message: Record_): Record_ {
	const text = contentText(message);
	let restored = message;
	if (isRecord(message.details) && "outputAt" in message.details)
		restored = { ...restored, details: restoredSpan(message.details, text) };
	const structured = message.structuredContent;
	if (isRecord(structured)) {
		if ("outputAt" in structured) restored = { ...restored, structuredContent: restoredSpan(structured, text) };
		else if (typeof structured.outputFile === "string")
			restored = { ...restored, structuredContent: lazyOutput(structured, structured.outputFile) };
	}
	return restored;
}
