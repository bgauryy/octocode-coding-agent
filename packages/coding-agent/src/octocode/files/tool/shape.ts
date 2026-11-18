/**
 * The refusal for a `file` call with neither or both of `queries` and `patch`. It echoes the corrected call built from
 * what the model sent, so the next attempt copies a valid shape instead of repeating the same one. A model that wrote
 * its parameters as text inside `reason` (`<parameter name="type">edit`) gets them read back out of that text.
 */

const CHANGE_FIELDS = ["type", "path", "edits", "content"] as const;
const FORMS =
	"file takes either queries (an array, one object per change: {type, path, edits|content}) or patch (a Codex apply_patch string), not both";
const ECHO_STRING_LIMIT = 200;

/** `<parameter name="x">value` runs, as a model writes them when its call's parameters land in text. */
const PARAMETER_TEXT = /<parameter name="([^"]+)">([\s\S]*?)(?=<parameter name="|<\/parameter>|$)/g;

function clip(_key: string, value: unknown): unknown {
	return typeof value === "string" && value.length > ECHO_STRING_LIMIT
		? `${value.slice(0, ECHO_STRING_LIMIT)}…`
		: value;
}

function echo(call: Record<string, unknown>): string {
	return JSON.stringify(call, clip, 2);
}

/** A string that parses as JSON is decoded (`edits`, `queries`); anything else stays as written. */
function decode(name: string, value: string): unknown {
	if (name !== "edits" && name !== "queries") return value;
	try {
		return JSON.parse(value);
	} catch {
		return value;
	}
}

function pickChange(source: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(
		CHANGE_FIELDS.filter((name) => source[name] !== undefined).map((name) => [name, source[name]]),
	);
}

/** The refusal for a call whose change-carrying fields are wrong, or undefined when the shape is right. */
export function fileShapeError(args: Record<string, unknown>): Error | undefined {
	const reason = typeof args.reason === "string" ? args.reason : undefined;
	if (args.queries !== undefined && args.patch !== undefined) {
		const { patch: _dropped, ...kept } = args;
		return new Error(`${FORMS}. Send one. Corrected call:\n${echo(kept)}`);
	}
	if (args.queries !== undefined || args.patch !== undefined) return undefined;
	const written = reason !== undefined && reason.includes('<parameter name="');
	if (written) {
		const parameters: Record<string, unknown> = {};
		for (const match of reason.matchAll(PARAMETER_TEXT)) parameters[match[1]] = decode(match[1], match[2].trim());
		const change = { ...pickChange(args), ...pickChange(parameters) };
		const queries = Array.isArray(parameters.queries) ? parameters.queries : [change];
		const sayReason = reason.split("<")[0].trim();
		const corrected = { ...(sayReason ? { reason: sayReason } : {}), queries };
		return new Error(
			`file got no queries or patch: its parameters were written as text inside \`reason\`, not as fields. Send each as its own field. Corrected call:\n${echo(corrected)}`,
		);
	}
	const change = pickChange(args);
	if (Object.keys(change).length === 0)
		return new Error(`${FORMS}. This call had neither. Send one of them as a field.`);
	return new Error(
		`${FORMS}. This call had neither. Wrap the change as queries. Corrected call:\n${echo({ ...(reason ? { reason } : {}), queries: [change] })}`,
	);
}
