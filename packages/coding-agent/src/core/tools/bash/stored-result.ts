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

/** Structured contents whose `output` is read from the saved file when first read, with that file's path. */
const savedOutputs = new WeakMap<object, string>();

/** Copy of `record` with the key `from` renamed to `to` and given `value`, in the same place. */
function replaceKey(record: Record_, from: string, to: string, value: unknown): Record_ {
	return Object.fromEntries(Object.entries(record).map(([key, old]) => (key === from ? [to, value] : [key, old])));
}

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
	const saved = savedOutputs.get(structured);
	if (saved !== undefined) return replaceKey(structured, "output", "outputFile", saved);
	const span = spanOf(text, structured.output);
	if (span) return replaceKey(structured, "output", "outputAt", span);
	if (typeof fullOutputPath === "string" && typeof structured.output === "string") {
		// Only when the file reads back as exactly this text, so reading the result later restores it.
		if (savedOutput(fullOutputPath) === structured.output)
			return replaceKey(structured, "output", "outputFile", fullOutputPath);
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
		const settle = (value: string | undefined) => {
			Object.defineProperty(restored, "output", { value, enumerable: true, writable: true, configurable: true });
			savedOutputs.delete(restored);
		};
		Object.defineProperty(restored, "output", {
			enumerable: true,
			configurable: true,
			get: () => {
				const value = savedOutput(path);
				settle(value);
				return value;
			},
			set: settle,
		});
	}
	savedOutputs.set(restored, path);
	return restored;
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
