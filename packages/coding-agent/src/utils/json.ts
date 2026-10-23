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
