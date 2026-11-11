import type { Tool } from "../types.ts";

/** Strip executable and display-only fields from a tool before transcript comparison or persistence. */
export function toToolDeclaration(tool: Tool): Tool {
	return {
		name: tool.name,
		description: tool.description,
		parameters: JSON.parse(JSON.stringify(tool.parameters)) as Tool["parameters"],
		...(tool.constrainedSampling === undefined ? {} : { constrainedSampling: tool.constrainedSampling }),
	};
}

/**
 * Whether two tools declare the same interface to the model.
 *
 * Both sides go through {@link toToolDeclaration} first: its JSON round-trip drops the
 * typebox symbol keys and `undefined` fields that a structural comparison would see, and
 * builds both objects with the same key order, so comparing the serialized declarations
 * is exact. This avoids a deep-equal dependency in a browser-safe package.
 */
export function declarationsEqual(left: Tool, right: Tool): boolean {
	return left === right || declarationText(left) === declarationText(right);
}

interface SerializedDeclaration {
	name: string;
	description: string;
	parameters: Tool["parameters"];
	constrainedSampling: Tool["constrainedSampling"];
	text: string;
}

const serializedDeclarations = new WeakMap<Tool, SerializedDeclaration>();

/**
 * A tool's serialized declaration, kept per tool object: the agent loop compares every tool before every request, and
 * serializing 27 schemas each time cost more than the request's own preparation. The entry is reused only while the
 * object still holds the same name, description, parameters object and sampling flag, so a tool given a new schema is
 * serialized again. A schema edited in place is not seen: schemas are built once and replaced, never edited.
 */
function declarationText(tool: Tool): string {
	const known = serializedDeclarations.get(tool);
	if (
		known &&
		known.name === tool.name &&
		known.description === tool.description &&
		known.parameters === tool.parameters &&
		known.constrainedSampling === tool.constrainedSampling
	)
		return known.text;
	const text = JSON.stringify(toToolDeclaration(tool));
	serializedDeclarations.set(tool, {
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters,
		constrainedSampling: tool.constrainedSampling,
		text,
	});
	return text;
}
