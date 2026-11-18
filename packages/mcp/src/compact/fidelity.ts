import { conditionallyRequired } from "./applicability.ts";
import { toolBlock } from "./file.ts";
import { functionNames } from "./render.ts";
import { identifier, inert, literal } from "./schema-nodes.ts";
import { isShapeless } from "./schema-to-ts.ts";
import type { CompactServerInput, CompactToolInput, JsonSchema } from "./types.ts";
import { escapeRegExp } from "@octocodeai/octocode-common/regexp";

/** Comments the renderer writes where it could not express the schema. */
const LOSS_MARKERS = ["/* unresolved $ref */", "/* schema too deep */", "/* unsupported schema shape */"];

/**
 * Keys some object in the schema requires (`required` arrays anywhere, including union branches). A union branch
 * with no shape (`{ required: ["a"] }`) requires its keys only on that branch, which the renderer states in a comment
 * (`a required`); those key lists go to `conditional` instead.
 */
function requiredKeys(
	schema: JsonSchema | undefined,
	out: Set<string>,
	conditional: string[][],
	seen = new Set<unknown>(),
): void {
	if (!schema || typeof schema !== "object" || seen.has(schema)) return;
	seen.add(schema);
	if (Array.isArray(schema)) {
		for (const item of schema) requiredKeys(item as JsonSchema, out, conditional, seen);
		return;
	}
	if (Array.isArray(schema.required)) for (const key of schema.required) out.add(String(key));
	for (const [keyword, value] of Object.entries(schema)) {
		if (!value || typeof value !== "object") continue;
		if ((keyword === "anyOf" || keyword === "oneOf") && Array.isArray(value)) {
			for (const branch of value) {
				const required = (branch as { required?: unknown })?.required;
				if (isShapeless(branch) && Array.isArray(required)) conditional.push(required.map(String));
				else requiredKeys(branch as JsonSchema, out, conditional, seen);
			}
		} else requiredKeys(value as JsonSchema, out, conditional, seen);
	}
}

/** Property names and enum/const values that must appear in a tool's rendered block. */
function requiredTokens(schema: JsonSchema | undefined, out: Set<string>, seen = new Set<unknown>()): void {
	if (!schema || typeof schema !== "object" || seen.has(schema)) return;
	seen.add(schema);
	if (Array.isArray(schema)) {
		for (const item of schema) requiredTokens(item as JsonSchema, out, seen);
		return;
	}
	if (schema.properties && typeof schema.properties === "object")
		for (const key of Object.keys(schema.properties)) out.add(identifier(key));
	if (schema.const !== undefined) out.add(literal(schema.const));
	if (Array.isArray(schema.enum)) for (const value of schema.enum) out.add(literal(value));
	for (const value of Object.values(schema))
		if (value && typeof value === "object") requiredTokens(value as JsonSchema, out, seen);
}

/**
 * Problems of one tool's rendered block against its schemas: a property name or enum/const value missing, a required
 * key shown only as optional, a branch-only requirement not stated, a requirement the descriptions state that reads
 * neither as required nor as the note itself, or a part the renderer could not express.
 */
export function checkToolBlock(tool: CompactToolInput, block: string): string[] {
	const problems: string[] = [];
	for (const marker of LOSS_MARKERS)
		if (block.includes(marker)) problems.push(`${tool.name}: renders ${marker.slice(3, -3)}`);
	const tokens = new Set<string>();
	requiredTokens(tool.inputSchema, tokens);
	requiredTokens(tool.outputSchema, tokens);
	for (const token of tokens) if (!block.includes(token)) problems.push(`${tool.name}: loses ${token}`);
	// A key the schema requires somewhere must render as required somewhere: shown only as `key?:` it reads optional.
	const required = new Set<string>();
	const conditional: string[][] = [];
	requiredKeys(tool.inputSchema, required, conditional);
	for (const key of required) {
		const name = `"?${escapeRegExp(key)}"?`;
		const optional = new RegExp(`(^|[\\s{;/])${name}\\?:`, "m").test(block);
		const mandatory = new RegExp(`(^|[\\s{;/])${name}:`, "m").test(block);
		if (optional && !mandatory) problems.push(`${tool.name}: shows required ${key} as optional`);
	}
	for (const keys of conditional)
		if (keys.length && !block.includes(`${inert(keys.join(" + "))} required`))
			problems.push(`${tool.name}: loses the alternative requiring ${keys.join(" + ")}`);
	for (const { field, note } of conditionallyRequired(tool.inputSchema)) {
		const mandatory = new RegExp(`(^|[\\s{;/])"?${escapeRegExp(field)}"?:`, "m").test(block);
		if (!mandatory && !block.includes(note)) problems.push(`${tool.name}: loses "${note}" on ${field}`);
	}
	return problems;
}

/**
 * Checks a rendered file against its source catalog: every tool present and faithful (`checkToolBlock`). Structure
 * comes from the schema, so a failure here means a renderer limit.
 */
export function checkFidelity(input: CompactServerInput, text: string): { ok: boolean; problems: string[] } {
	const problems: string[] = [];
	const names = functionNames(input);
	for (const tool of input.tools) {
		const block = toolBlock(text, names.get(tool.name)?.fn ?? tool.name);
		if (block) problems.push(...checkToolBlock(tool, block));
		else problems.push(`${tool.name}: missing from file`);
	}
	return { ok: problems.length === 0, problems };
}
