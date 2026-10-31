import { readFileSync } from "node:fs";
import { stripBom } from "./text.ts";

/** Strip `//` line comments and trailing commas from JSON, leaving string literals untouched. */
export function stripJsonComments(input: string): string {
	return input
		.replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, (m) => (m[0] === '"' ? m : ""))
		.replace(/"(?:\\.|[^"\\])*"|,(\s*[}\]])/g, (m, tail) => tail ?? (m[0] === '"' ? m : ""));
}

/** Whether JSON text has `//` comments outside string literals, which a parse-and-rewrite would drop. */
export function hasJsonComments(input: string): boolean {
	for (const [match] of input.matchAll(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g)) if (match[0] !== '"') return true;
	return false;
}

/**
 * Parse the JSON file at `file`, ignoring a leading byte-order mark. Without `fallback` a missing, unreadable or invalid
 * file throws, as `JSON.parse(readFileSync(...))` does, so the caller keeps its own error policy. With `fallback`, any of
 * those failures returns it instead.
 */
export function readJsonFile<T = unknown>(file: string, options?: { fallback: T }): T {
	try {
		return JSON.parse(stripBom(readFileSync(file, "utf8"))) as T;
	} catch (error) {
		if (options) return options.fallback;
		throw error;
	}
}
