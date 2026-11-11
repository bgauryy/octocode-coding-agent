import { createHash } from "node:crypto";
import { assignMcpToolNames } from "../tool-names.ts";
import { structureApplicability, withOverrideNotes } from "./applicability.ts";
import { inlineTinyRefs } from "./inline-refs.ts";
import { dedupeFieldDocs } from "./field-docs.ts";
import { isHoistableUnion, oneLine } from "./schema-nodes.ts";
import { hoistedBlock, indentBlock, INDENT, sharedBlock } from "./file.ts";
import { schemaToTs } from "./schema-to-ts.ts";
import type { CompactServerInput, CompactToolInput, DescriptionOverrides } from "./types.ts";

/** Bump when the rendered text changes for the same catalog, so stored files regenerate. */
export const COMPACT_GENERATOR_VERSION = 15;

/**
 * A field doc repeated by at least this many tools is written once, in the server's shared-fields block, when every
 * field of that name in the server has that doc.
 */
const SHARED_DOC_MIN_TOOLS = 3;

/** Prefix of a field path in {@link DescriptionOverrides.fields} that addresses the tool's output schema. */
export const OUTPUT_FIELD_PREFIX = "output.";

/**
 * An object type repeated by at least this many tools, and at least this long, becomes one server-level alias; so
 * does a longer one written out twice anywhere (union branches of one tool repeat a nested rule verbatim).
 */
const HOISTED_TYPE_MIN_TOOLS = 3;
const HOISTED_TYPE_MIN_CHARS = 60;
const HOISTED_REPEAT_MIN_CHARS = 200;
/** A union of plain types (`string | Record<string, unknown>`) used this many times is named once. */
const HOISTED_UNION_MIN_USES = 4;

interface RenderContext {
	sharedDocs?: ReadonlyMap<string, string>;
	hoisted?: ReadonlyMap<string, string>;
	onDoc?: (field: string, doc: string) => void;
	onObject?: (field: string, type: string, source: object) => void;
}

/** A TypeScript identifier for the namespace: server names may contain `-` or `.`. */
function namespaceName(server: string): string {
	const cleaned = server.replace(/[^\w$]/g, "_");
	return /^[A-Za-z_$]/.test(cleaned) ? cleaned : `_${cleaned}`;
}

/** A tool's function in the file and the name the model calls it by. */
export interface FunctionName {
	/** The TypeScript identifier of the tool's function. */
	fn: string;
	/** The tool name the model calls. */
	call: string;
	/** Whether `call` is other than `mcp__<server>__<fn>`, so the file names it beside the function. */
	explicit: boolean;
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
const CALL_AS = "// call as ";
const scopeOf = (fn: string) => `${fn[0].toUpperCase()}${fn.slice(1)}_`;
const byName = (a: CompactToolInput, b: CompactToolInput) => a.name.localeCompare(b.name);

/** The name the model calls each tool by: the input's `toolNames`, else the names a lone server would assign. */
function callNames(input: CompactServerInput): Map<string, string> {
	const defaults = assignMcpToolNames(
		input.server,
		input.tools.map((tool) => tool.name),
	);
	return new Map([...defaults].map(([tool, name]) => [tool, input.toolNames?.[tool] ?? name]));
}

/**
 * Each tool's function in the file, by MCP tool name. A function is named by its call name after
 * `mcp__<server>__`, so the `mcps` section's calling rule holds. A call name with another form (a plugin server's `-`, a
 * shortened name) gets a function named after the tool, unique within the file, and a `// call as` line.
 */
export function functionNames(input: CompactServerInput): Map<string, FunctionName> {
	const prefix = `mcp__${input.server}__`;
	const calls = callNames(input);
	const tools = [...input.tools].sort(byName).map((tool) => tool.name);
	const names = new Map<string, FunctionName>();
	const taken = new Set<string>();
	for (const tool of tools) {
		const call = calls.get(tool) ?? tool;
		const rest = call.startsWith(prefix) ? call.slice(prefix.length) : "";
		if (!IDENTIFIER.test(rest)) continue;
		names.set(tool, { fn: rest, call, explicit: false });
		taken.add(rest);
	}
	for (const tool of tools) {
		if (names.has(tool)) continue;
		const cleaned = tool.replace(/[^\w$]/g, "_");
		const base = /^[A-Za-z_$]/.test(cleaned) ? cleaned : `_${cleaned}`;
		let fn = base;
		for (let index = 2; taken.has(fn); index++) fn = `${base}_${index}`;
		taken.add(fn);
		names.set(tool, { fn, call: calls.get(tool) ?? tool, explicit: true });
	}
	return names;
}

/** Canonical JSON: keys sorted, so equal catalogs hash equally whatever order a server sends. */
function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value && typeof value === "object")
		return `{${Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
			.join(",")}}`;
	return JSON.stringify(value) ?? "null";
}

/**
 * sha256 of the server name, instructions, each tool's name, description and schemas, and the call names that differ
 * from what a lone server would assign (a collision with another server's tool). The renderer version is not part of
 * it: overrides describe the catalog, so they survive renderer changes and are re-checked by `checkFidelity`; stored
 * files record `generatorVersion` separately.
 */
export function catalogHash(input: CompactServerInput): string {
	const tools = [...input.tools]
		.sort(byName)
		.map(({ name, description, inputSchema, outputSchema }) => ({ name, description, inputSchema, outputSchema }));
	const defaults = assignMcpToolNames(
		input.server,
		tools.map((tool) => tool.name),
	);
	const renamed = Object.fromEntries(
		[...defaults].flatMap(([tool, name]) => {
			const given = input.toolNames?.[tool];
			return given !== undefined && given !== name ? [[tool, given]] : [];
		}),
	);
	return createHash("sha256")
		.update(
			canonical({
				server: input.server,
				instructions: input.instructions ?? "",
				tools,
				...(Object.keys(renamed).length ? { toolNames: renamed } : {}),
			}),
		)
		.digest("hex");
}

const sha256 = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");

/**
 * sha256 of one tool's name, description and schemas, without the server name: overrides written for the tool still
 * describe it while this hash holds, whatever else the catalog changes or what the server is called.
 */
export function toolHash({ name, description, inputSchema, outputSchema }: CompactToolInput): string {
	return sha256({ name, description, inputSchema, outputSchema });
}

/** sha256 of the server instructions, so a server override is kept exactly while they are unchanged. */
export function instructionsHash(instructions: string | undefined): string {
	return sha256(instructions ?? "");
}

/** The `output.`-prefixed entries of a tool's field overrides, without the prefix. */
function outputFieldDocs(fieldDocs: Record<string, string>): Record<string, string> | undefined {
	const entries = Object.entries(fieldDocs)
		.filter(([path]) => path.startsWith(OUTPUT_FIELD_PREFIX))
		.map(([path, doc]) => [path.slice(OUTPUT_FIELD_PREFIX.length), doc] as const);
	return entries.length ? Object.fromEntries(entries) : undefined;
}

function renderTool(
	tool: CompactToolInput,
	name: FunctionName,
	overrides: DescriptionOverrides | undefined,
	context: RenderContext = {},
): string {
	const scope = scopeOf(name.fn);
	const { schema, fieldDocs } = withOverrideNotes(inlineTinyRefs(tool.inputSchema), overrides?.fields?.[tool.name]);
	const input = schemaToTs(structureApplicability(schema), { scope, fieldDocs, ...context });
	const outputDocs = fieldDocs && outputFieldDocs(fieldDocs);
	const output: { type: string; aliases: string[] } =
		tool.outputSchema === undefined
			? { type: "unknown", aliases: [] }
			: schemaToTs(tool.outputSchema, {
					scope: `${scope}Out_`,
					fieldDocs: outputDocs,
					sharedDocs: context.sharedDocs,
					hoisted: context.hoisted,
					onDoc: context.onDoc,
				});
	let block = "";
	for (const alias of [...input.aliases, ...output.aliases]) block += `${indentBlock(alias, INDENT)}\n`;
	if (name.explicit) block += `${INDENT}${CALL_AS}${name.call}\n`;
	const description = oneLine(overrides?.tools?.[tool.name] ?? tool.description);
	if (description) block += `${INDENT}/** ${description} */\n`;
	block += `${INDENT}function ${name.fn}(input: ${indentBlock(input.type, INDENT).trimStart()}): ${indentBlock(output.type, INDENT).trimStart()};\n`;
	return block;
}

/**
 * Docs that at least {@link SHARED_DOC_MIN_TOOLS} tools give a field, for fields whose every occurrence (input or
 * output, at any depth) has that one doc: a field name then attributes its shared doc exactly, in the file and in a
 * tool block shown alone.
 */
function findSharedDocs(
	tools: readonly CompactToolInput[],
	names: ReadonlyMap<string, FunctionName>,
	overrides?: DescriptionOverrides,
): Map<string, string> {
	const docsByField = new Map<string, Map<string, Set<string>>>();
	for (const tool of tools)
		renderTool(tool, names.get(tool.name)!, overrides, {
			onDoc: (field, doc) => {
				const docs = docsByField.get(field) ?? new Map<string, Set<string>>();
				const seen = docs.get(doc) ?? new Set<string>();
				seen.add(tool.name);
				docs.set(doc, seen);
				docsByField.set(field, docs);
			},
		});
	const shared: [string, string][] = [];
	for (const [field, docs] of docsByField) {
		const [[doc, seen], ...others] = docs;
		if (!others.length && doc && seen.size >= SHARED_DOC_MIN_TOOLS) shared.push([field, doc]);
	}
	return new Map(shared.sort(([a], [b]) => a.localeCompare(b)));
}

/** Object types that several tools repeat verbatim, named after their field (`connection` → `Connection`). */
function findHoistedTypes(
	tools: readonly CompactToolInput[],
	names: ReadonlyMap<string, FunctionName>,
	overrides: DescriptionOverrides | undefined,
	sharedDocs: ReadonlyMap<string, string>,
): Map<string, string> {
	const seen = new Map<string, { field: string; tools: Set<string>; sources: Set<object> }>();
	for (const tool of tools)
		renderTool(tool, names.get(tool.name)!, overrides, {
			sharedDocs,
			onObject: (field, type, source) => {
				if (type.length < HOISTED_TYPE_MIN_CHARS && !isHoistableUnion(type)) return;
				const entry = seen.get(type) ?? { field, tools: new Set<string>(), sources: new Set<object>() };
				entry.tools.add(tool.name);
				entry.sources.add(source);
				seen.set(type, entry);
			},
		});
	const hoisted = new Map<string, string>();
	const taken = new Set<string>();
	const repeated = [...seen].filter(([type, entry]) =>
		isHoistableUnion(type)
			? entry.sources.size >= HOISTED_UNION_MIN_USES
			: entry.tools.size >= HOISTED_TYPE_MIN_TOOLS ||
				(entry.sources.size >= 2 && type.length >= HOISTED_REPEAT_MIN_CHARS),
	);
	for (const [type, { field }] of repeated.sort(([, a], [, b]) => a.field.localeCompare(b.field))) {
		const base = isHoistableUnion(type)
			? "Value"
			: `${field[0]?.toUpperCase() ?? "T"}${field.slice(1).replace(/\W/g, "_")}`;
		let name = base;
		for (let index = 2; taken.has(name); index++) name = `${base}${index}`;
		taken.add(name);
		hoisted.set(type, name);
	}
	return hoisted;
}

/**
 * The model-facing text for one server: its instructions, docs shared by several tools, and one typed function per tool inside `declare namespace`. Tools are sorted by name; overrides
 * replace prose only.
 */
export function renderServer(input: CompactServerInput, overrides?: DescriptionOverrides): string {
	const tools = [...input.tools].sort(byName);
	const names = functionNames(input);
	const sharedDocs = findSharedDocs(tools, names, overrides);
	const hoisted = findHoistedTypes(tools, names, overrides, sharedDocs);
	// Only a name the section's calling rule cannot produce needs a word here.
	let out = [...names.values()].some((name) => name.explicit)
		? `// A function after a "${CALL_AS.trim()} <name>" line is called by that name.\n`
		: "";
	const instructions = oneLine(overrides?.server ?? input.instructions);
	if (instructions) out += `/** ${instructions} */\n`;
	out += `declare namespace ${namespaceName(input.server)} {\n`;
	if (sharedDocs.size) out += sharedBlock(sharedDocs);
	if (hoisted.size) out += hoistedBlock([...hoisted].map(([type, name]) => [name, type]));
	for (const tool of tools)
		out += dedupeFieldDocs(renderTool(tool, names.get(tool.name)!, overrides, { sharedDocs, hoisted }));
	return `${out}}\n`;
}
