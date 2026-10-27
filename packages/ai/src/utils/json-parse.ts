import { parse as partialParse } from "partial-json";
import type { ToolCall } from "../types.ts";

const VALID_JSON_ESCAPES = new Set(['"', "\\", "/", "b", "f", "n", "r", "t"]);

function isControlCharacter(char: string): boolean {
	const codePoint = char.codePointAt(0);
	return codePoint !== undefined && codePoint >= 0x00 && codePoint <= 0x1f;
}

function escapeControlCharacter(char: string): string {
	switch (char) {
		case "\b":
			return "\\b";
		case "\f":
			return "\\f";
		case "\n":
			return "\\n";
		case "\r":
			return "\\r";
		case "\t":
			return "\\t";
		default:
			return `\\u${char.codePointAt(0)?.toString(16).padStart(4, "0") ?? "0000"}`;
	}
}

/**
 * Repairs malformed JSON string literals by:
 * - escaping raw control characters inside strings
 * - doubling backslashes before invalid escape characters
 */
export function repairJson(json: string): string {
	let repaired = "";
	let inString = false;

	for (let index = 0; index < json.length; index++) {
		const char = json[index];

		if (!inString) {
			repaired += char;
			if (char === '"') {
				inString = true;
			}
			continue;
		}

		if (char === '"') {
			repaired += char;
			inString = false;
			continue;
		}

		if (char === "\\") {
			const nextChar = json[index + 1];
			if (nextChar === undefined) {
				repaired += "\\\\";
				continue;
			}

			if (nextChar === "u") {
				const unicodeDigits = json.slice(index + 2, index + 6);
				if (/^[0-9a-fA-F]{4}$/.test(unicodeDigits)) {
					repaired += `\\u${unicodeDigits}`;
					index += 5;
					continue;
				}
			}

			if (VALID_JSON_ESCAPES.has(nextChar)) {
				repaired += `\\${nextChar}`;
				index += 1;
				continue;
			}

			repaired += "\\\\";
			continue;
		}

		repaired += isControlCharacter(char) ? escapeControlCharacter(char) : char;
	}

	return repaired;
}

export function parseJsonWithRepair<T>(json: string): T {
	try {
		return JSON.parse(json) as T;
	} catch (error) {
		const repairedJson = repairJson(json);
		if (repairedJson !== json) {
			return JSON.parse(repairedJson) as T;
		}
		throw error;
	}
}

/** Longest prefix of the model's arguments echoed back in an error message. */
export const MAX_ECHOED_ARGUMENTS_CHARS = 1500;

/** The model's arguments text for an error message: the first {@link MAX_ECHOED_ARGUMENTS_CHARS} characters and the size of the rest. */
export function describeReceivedArguments(received: string): string {
	if (received.length <= MAX_ECHOED_ARGUMENTS_CHARS) return `Received arguments:\n${received}`;
	const omitted = received.length - MAX_ECHOED_ARGUMENTS_CHARS;
	return `Received arguments (first ${MAX_ECHOED_ARGUMENTS_CHARS} of ${received.length} characters; ${omitted} more omitted):\n${received.slice(0, MAX_ECHOED_ARGUMENTS_CHARS)}`;
}

/**
 * Parses the model's complete arguments text of a finished tool call.
 *
 * Unlike {@link parseStreamingJson}, this never keeps a partially parsed prefix: once the call is
 * finished, text that is not a valid JSON object means the model sent malformed arguments. In that
 * case `arguments` is `{}` and `argumentsError` describes the problem, including the text the
 * model sent, so tool validation can report it back to the model.
 */
export function parseToolCallArguments(json: string | undefined): Pick<ToolCall, "arguments" | "argumentsError"> {
	if (!json?.trim()) return { arguments: {} };
	try {
		const parsed = parseJsonWithRepair<ToolCall["arguments"] | null>(json);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			throw new Error("Tool arguments must be a JSON object");
		}
		return { arguments: parsed };
	} catch (error) {
		return {
			arguments: {},
			argumentsError: `${error instanceof Error ? error.message : String(error)}\n\n${describeReceivedArguments(json)}`,
		};
	}
}

/**
 * Attempts to parse potentially incomplete JSON during streaming.
 * Always returns a valid object, even if the JSON is incomplete.
 *
 * @param partialJson The partial JSON string from streaming
 * @returns Parsed object or empty object if parsing fails
 */
export function parseStreamingJson<T = Record<string, unknown>>(partialJson: string | undefined): T {
	if (!partialJson || partialJson.trim() === "") {
		return {} as T;
	}

	try {
		return parseJsonWithRepair<T>(partialJson);
	} catch {
		try {
			const result = partialParse(partialJson);
			return (result ?? {}) as T;
		} catch {
			try {
				const result = partialParse(repairJson(partialJson));
				return (result ?? {}) as T;
			} catch {
				return {} as T;
			}
		}
	}
}

/** Arguments are re-parsed on every delta up to this length; beyond it, only after enough growth. */
const PARSE_EVERY_DELTA_UNTIL = 4096;
const MIN_PARSE_GROWTH = 2048;
/** Text length that each parsed arguments object was parsed from. */
const parsedLengths = new WeakMap<object, number>();

/**
 * Streaming counterpart of {@link parseStreamingJson} that keeps the cost of a long argument linear.
 *
 * Parsing the whole accumulated text on every delta is quadratic, so past a few KB it returns `previous`
 * (the object this function returned last for the same text) until the text has grown by an eighth
 * (at least 2 KB). The previews therefore lag by a bounded amount; the finished call is parsed exactly
 * with {@link parseToolCallArguments}.
 *
 * @param previous The arguments last returned for this call, if any
 * @param partialJson The accumulated partial JSON
 */
export function parseStreamingJsonThrottled<T extends object = Record<string, unknown>>(
	previous: T | undefined,
	partialJson: string | undefined,
): T {
	const length = partialJson?.length ?? 0;
	const parsedLength = previous === undefined ? undefined : parsedLengths.get(previous);
	if (
		previous !== undefined &&
		parsedLength !== undefined &&
		length >= parsedLength &&
		length > PARSE_EVERY_DELTA_UNTIL &&
		length - parsedLength < Math.max(MIN_PARSE_GROWTH, parsedLength / 8)
	) {
		return previous;
	}
	const parsed = parseStreamingJson<T>(partialJson);
	if (typeof parsed === "object" && parsed !== null) parsedLengths.set(parsed, length);
	return parsed;
}
