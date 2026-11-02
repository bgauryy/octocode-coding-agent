import { toolBlock } from "./file.ts";
import { functionNames, OUTPUT_FIELD_PREFIX, renderServer } from "./render.ts";
import { isShapeless, schemaToTs } from "./schema-to-ts.ts";
import type { CompactServerInput, CompactToolInput, DescriptionOverrides, JsonSchema } from "./types.ts";

/** Longest override per kind, in characters; longer text defeats the point of compacting. */
const OVERRIDE_LIMITS = { server: 1200, tool: 600, trigger: 200, field: 240 } as const;

const URL_PATTERN = /\bhttps?:\/\/\S+/gi;

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

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Property names and enum/const values that must appear in a tool's rendered block. */
function requiredTokens(schema: JsonSchema | undefined, out: Set<string>, seen = new Set<unknown>()): void {
	if (!schema || typeof schema !== "object" || seen.has(schema)) return;
	seen.add(schema);
	if (Array.isArray(schema)) {
		for (const item of schema) requiredTokens(item as JsonSchema, out, seen);
		return;
	}
	if (schema.properties && typeof schema.properties === "object")
		for (const key of Object.keys(schema.properties)) out.add(key);
	if (schema.const !== undefined) out.add(JSON.stringify(schema.const));
	if (Array.isArray(schema.enum)) for (const value of schema.enum) out.add(JSON.stringify(value));
	for (const value of Object.values(schema))
		if (value && typeof value === "object") requiredTokens(value as JsonSchema, out, seen);
}

function checkText(label: string, text: string, source: string, limit: number, problems: string[]): void {
	if (text.length > limit) problems.push(`${label}: ${text.length} chars exceeds ${limit}`);
	const known = new Set(source.match(URL_PATTERN) ?? []);
	for (const url of text.match(URL_PATTERN) ?? []) if (!known.has(url)) problems.push(`${label}: adds URL ${url}`);
}

/**
 * Problems of one tool's rendered block against its schemas: a property name or enum/const value missing, a required
 * key shown only as optional, a branch-only requirement not stated, or a part the renderer could not express.
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
		if (keys.length && !block.includes(`${keys.join(" + ")} required`))
			problems.push(`${tool.name}: loses the alternative requiring ${keys.join(" + ")}`);
	return problems;
}

/** Each field path an override may address (`fieldDocs`, `output.`-prefixed for output), and whether it is always required. */
function fieldPaths(tool: CompactToolInput): Map<string, boolean> {
	const paths = new Map<string, boolean>();
	const collect = (schema: JsonSchema, prefix: string) =>
		schemaToTs(schema, {
			scope: "F_",
			onField: (path, required) => paths.set(prefix + path, (paths.get(prefix + path) ?? true) && required),
		});
	collect(tool.inputSchema, "");
	if (tool.outputSchema !== undefined) collect(tool.outputSchema, OUTPUT_FIELD_PREFIX);
	return paths;
}

/**
 * Checks a rendered file against its source catalog: every tool present and faithful (`checkToolBlock`), and
 * overrides within limits, without URLs the source lacks, naming tools and fields the server has, and not calling a
 * required field optional. Structure comes from the schema, so a failure here means a renderer limit or a bad override.
 */
export function checkFidelity(
	input: CompactServerInput,
	text: string,
	overrides?: DescriptionOverrides,
): { ok: boolean; problems: string[] } {
	const problems: string[] = [];
	const names = functionNames(input);
	for (const tool of input.tools) {
		const block = toolBlock(text, names.get(tool.name)?.fn ?? tool.name);
		if (block) problems.push(...checkToolBlock(tool, block));
		else problems.push(`${tool.name}: missing from file`);
	}
	if (overrides?.server !== undefined)
		checkText("server", overrides.server, input.instructions ?? "", OVERRIDE_LIMITS.server, problems);
	for (const [tool, text] of Object.entries(overrides?.tools ?? {})) {
		if (!names.has(tool)) problems.push(`override names unknown tool ${tool}`);
		const source = input.tools.find((candidate) => candidate.name === tool)?.description ?? "";
		checkText(tool, text, source, OVERRIDE_LIMITS.tool, problems);
	}
	for (const [tool, text] of Object.entries(overrides?.triggers ?? {})) {
		if (!names.has(tool)) problems.push(`trigger names unknown tool ${tool}`);
		if (/[\r\n]/.test(text)) problems.push(`${tool} trigger: must be one line`);
		const source = input.tools.find((candidate) => candidate.name === tool)?.description ?? "";
		checkText(`${tool} trigger`, text, source, OVERRIDE_LIMITS.trigger, problems);
	}
	for (const [tool, fields] of Object.entries(overrides?.fields ?? {})) {
		const declared = input.tools.find((candidate) => candidate.name === tool);
		if (!declared) problems.push(`override names unknown tool ${tool}`);
		const source = JSON.stringify([declared?.inputSchema ?? {}, declared?.outputSchema ?? {}]);
		const paths = declared ? fieldPaths(declared) : undefined;
		for (const [field, text] of Object.entries(fields)) {
			checkText(`${tool}.${field}`, text, source, OVERRIDE_LIMITS.field, problems);
			const required = paths?.get(field);
			if (paths && required === undefined) problems.push(`${tool}.${field}: no such field`);
			if (required && /\boptional\b/i.test(text)) problems.push(`${tool}.${field}: calls a required field optional`);
		}
	}
	return { ok: problems.length === 0, problems };
}

/**
 * The fidelity of `text`, the file rendered with `overrides`, counting only what the overrides could change. A tool the
 * renderer cannot express (a schema with unreachable definitions, say) fails the plain file too: its sessions declare
 * it in full (`McpPresentation`), and it must not void the overrides of the tools that render faithfully. Those
 * problems come back as `inherent`.
 */
export function checkOverrides(
	input: CompactServerInput,
	text: string,
	overrides: DescriptionOverrides,
): { ok: boolean; problems: string[]; inherent: string[] } {
	const plain = new Set(checkFidelity(input, renderServer(input)).problems);
	const found = checkFidelity(input, text, overrides).problems;
	const problems = found.filter((problem) => !plain.has(problem));
	return { ok: problems.length === 0, problems, inherent: found.filter((problem) => plain.has(problem)) };
}
