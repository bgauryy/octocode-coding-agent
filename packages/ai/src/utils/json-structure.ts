/** Closing brackets still owed at the end of `json`, innermost first, when its structure is otherwise sound. */
function closersOwed(stack: string[]): string {
	return [...stack].reverse().join("");
}

/**
 * What is wrong with the brackets of JSON text that does not parse, in words a model can act on, or undefined when
 * its structure looks sound (a bad escape, a stray token). Tool arguments nest `queries` and `edits` arrays several
 * levels deep, and a long call is where a model loses count of the closers.
 */
export function describeJsonStructure(json: string): string | undefined {
	const expected: string[] = [];
	let inString = false;
	for (let index = 0; index < json.length; index++) {
		const char = json[index];
		if (inString) {
			if (char === "\\") index++;
			else if (char === '"') inString = false;
		} else if (char === '"') {
			inString = true;
		} else if (char === "{") {
			expected.push("}");
		} else if (char === "[") {
			expected.push("]");
		} else if (char === "}" || char === "]") {
			const wanted = expected.pop();
			if (wanted !== char) {
				const wantedText = wanted === undefined ? "nothing more" : `\`${wanted}\``;
				return `Bracket mismatch: \`${char}\` at position ${index} where ${wantedText} was expected.`;
			}
		}
	}
	if (inString) return "The text ends inside a string: its closing quote is missing.";
	if (expected.length === 0) return undefined;
	return `The text ends with ${expected.length} unclosed ${expected.length === 1 ? "bracket" : "brackets"}; it needs \`${closersOwed(expected)}\` at the end.`;
}
