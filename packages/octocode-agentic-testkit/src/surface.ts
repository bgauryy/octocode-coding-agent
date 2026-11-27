import type { ToolDef } from "./mcp.ts";
import { toolParts } from "./measure.ts";
import { findSuspicious, suspiciousDetail, SUSPICIOUS_RULES, type SuspiciousRule } from "./surface-poison.ts";
import { mcpToolName, type CapturedRequest } from "./trace.ts";

/**
 * Static review of what a model reads before it acts: tool names, descriptions, input schemas, server instructions
 * and skill descriptions. No model call and no cost. Sizes are characters; tokens are estimated as chars / 4.
 */
export interface SurfaceTool {
	name: string;
	description?: string;
	inputSchema?: unknown;
}

export interface SurfaceInput {
	/** MCP servers (a `MockMcp` passes as is); each tool is named `mcp__<server>__<tool>`. */
	servers?: { name: string; defs: readonly SurfaceTool[] }[];
	/** Tools that already carry the name the model sees, such as `surfaceOfRequest(req)`. */
	tools?: SurfaceTool[];
	/** Server instructions by server name. */
	instructions?: Record<string, string>;
	skills?: { name: string; description: string }[];
}

export interface SurfaceLimits {
	/** Soft limit: a long description costs attention on every request. */
	descriptionChars: number;
	/** The host's cut-off: description text past it never reaches the model. */
	hostDescriptionChars: number;
	schemaChars: number;
	schemaDepth: number;
	/** The host's cut-off for server instructions. */
	instructionsChars: number;
	/** The Agent Skills specification allows at most 1,024 characters. */
	skillDescriptionChars: number;
	/** Word-set Jaccard similarity at which two descriptions look interchangeable. */
	overlap: number;
	/** Everything bound to one agent: names, descriptions, schemas, instructions and skills. */
	totalChars: number;
	/** When set, tool definitions reaching `deferShare` of this window are reported: a host in threshold mode defers them behind search. */
	contextWindowTokens?: number;
	deferShare: number;
	/** The `suspicious-instruction` rules (default `SUSPICIOUS_RULES`); drop one by id to accept what it flags. */
	suspiciousRules?: readonly SuspiciousRule[];
}

export const DEFAULT_LIMITS: SurfaceLimits = {
	descriptionChars: 1200,
	hostDescriptionChars: Number.POSITIVE_INFINITY,
	schemaChars: 4000,
	schemaDepth: 4,
	instructionsChars: Number.POSITIVE_INFINITY,
	skillDescriptionChars: 1024,
	overlap: 0.6,
	totalChars: 60_000,
	deferShare: 0.1,
	suspiciousRules: SUSPICIOUS_RULES,
};

export type IssueKind =
	| "description-missing"
	| "description-too-long"
	| "description-truncated"
	| "duplicate-name"
	| "schema-too-large"
	| "schema-too-deep"
	| "param-undocumented"
	| "open-object"
	| "instructions-truncated"
	| "skill-description-too-long"
	| "overlapping-tools"
	| "surface-too-large"
	| "tools-deferred"
	| "suspicious-instruction";

export interface SurfaceIssue {
	kind: IssueKind;
	target: string;
	detail: string;
}

export interface SurfaceItem {
	name: string;
	kind: "tool" | "instructions" | "skill";
	descriptionChars: number;
	schemaChars: number;
	estTokens: number;
}

export interface SurfaceReport {
	/** Largest first, by estimated tokens. */
	items: SurfaceItem[];
	totalChars: number;
	estTokens: number;
	issues: SurfaceIssue[];
}

type Schema = Record<string, unknown>;

const isObject = (v: unknown): v is Schema => typeof v === "object" && v !== null && !Array.isArray(v);
const tokens = (chars: number): number => Math.ceil(chars / 4);

export function analyzeSurface(input: SurfaceInput, limits: Partial<SurfaceLimits> = {}): SurfaceReport {
	const L = { ...DEFAULT_LIMITS, ...limits };
	const items: SurfaceItem[] = [];
	const issues: SurfaceIssue[] = [];
	const described: [string, string][] = [];
	const issue = (kind: IssueKind, target: string, detail: string): void => void issues.push({ kind, target, detail });
	const poison = (target: string, text: string): void => {
		for (const m of findSuspicious(text, L.suspiciousRules))
			issue("suspicious-instruction", target, suspiciousDetail(m, text));
	};

	const tools = [
		...(input.servers ?? []).flatMap((s) => s.defs.map((d) => ({ ...d, name: mcpToolName(s.name, d.name) }))),
		...(input.tools ?? []),
	];
	const seen = new Set<string>();
	for (const tool of tools) {
		const { name } = tool;
		const description = tool.description ?? "";
		const schema = tool.inputSchema ?? {};
		const schemaChars = JSON.stringify(schema).length;
		items.push({
			name,
			kind: "tool",
			descriptionChars: description.length,
			schemaChars,
			estTokens: tokens(name.length + description.length + schemaChars),
		});
		described.push([name, description]);
		if (seen.has(name)) issue("duplicate-name", name, "two tools share this name: the model cannot tell them apart");
		seen.add(name);
		if (!description.trim()) issue("description-missing", name, "empty description: the model routes by name alone");
		if (description.length > L.hostDescriptionChars)
			issue(
				"description-truncated",
				name,
				`${description.length} > ${L.hostDescriptionChars} chars; the host cuts the rest`,
			);
		else if (description.length > L.descriptionChars)
			issue("description-too-long", name, `${description.length} > ${L.descriptionChars} chars`);
		if (schemaChars > L.schemaChars) issue("schema-too-large", name, `${schemaChars} > ${L.schemaChars} chars`);
		const depth = schemaDepth(schema);
		if (depth > L.schemaDepth) issue("schema-too-deep", name, `nesting ${depth} > ${L.schemaDepth}`);
		for (const path of undocumentedParams(schema))
			issue("param-undocumented", `${name}.${path}`, "parameter has no description");
		for (const path of openObjects(schema))
			issue("open-object", path ? `${name}.${path}` : name, "object without properties: the model must guess its keys");
		poison(name, description);
		for (const [path, text] of schemaDescriptions(schema)) poison(path ? `${name}.${path}` : name, text);
	}

	for (const [server, text] of Object.entries(input.instructions ?? {})) {
		const name = `instructions:${server}`;
		items.push({
			name,
			kind: "instructions",
			descriptionChars: text.length,
			schemaChars: 0,
			estTokens: tokens(text.length),
		});
		if (text.length > L.instructionsChars)
			issue(
				"instructions-truncated",
				server,
				`${text.length} > ${L.instructionsChars} chars; the tail never reaches the model`,
			);
		poison(name, text);
	}

	for (const skill of input.skills ?? []) {
		const name = `skill:${skill.name}`;
		const chars = skill.description.length;
		items.push({ name, kind: "skill", descriptionChars: chars, schemaChars: 0, estTokens: tokens(chars) });
		described.push([name, skill.description]);
		if (chars > L.skillDescriptionChars)
			issue("skill-description-too-long", skill.name, `${chars} > ${L.skillDescriptionChars} chars`);
		poison(name, skill.description);
	}

	const wordSets = described.map(([name, text]) => [name, words(text)] as const);
	for (let i = 0; i < wordSets.length; i++)
		for (let j = i + 1; j < wordSets.length; j++) {
			const sim = jaccard(wordSets[i][1], wordSets[j][1]);
			if (sim >= L.overlap)
				issue(
					"overlapping-tools",
					`${wordSets[i][0]} ~ ${wordSets[j][0]}`,
					`description similarity ${sim.toFixed(2)}: the model may not tell them apart`,
				);
		}

	const totalChars = items.reduce((n, i) => n + i.name.length + i.descriptionChars + i.schemaChars, 0);
	const toolTokens = items.filter((i) => i.kind === "tool").reduce((n, i) => n + i.estTokens, 0);
	if (L.contextWindowTokens !== undefined && toolTokens >= L.deferShare * L.contextWindowTokens)
		issue(
			"tools-deferred",
			"all",
			`~${toolTokens} tool tokens past ${L.deferShare * 100}% of the ${L.contextWindowTokens}-token context window: a host in threshold mode defers tools behind search, so routing depends on search hits`,
		);
	if (totalChars > L.totalChars)
		issue("surface-too-large", "all", `${totalChars} > ${L.totalChars} chars bound to one agent`);
	return {
		items: items.toSorted((a, b) => b.estTokens - a.estTokens),
		totalChars,
		estTokens: tokens(totalChars),
		issues,
	};
}

/**
 * The tools a captured request sent, as the model received them: OpenAI chat, Responses, Anthropic and Gemini
 * (`functionDeclarations`). Provider built-in tools (a `type` other than `function` or `custom`) are skipped: the
 * provider describes them, not the harness.
 */
export function surfaceOfRequest(req: CapturedRequest): SurfaceTool[] {
	const raw = (req.raw ?? {}) as { tools?: unknown };
	if (!Array.isArray(raw.tools)) return [];
	return raw.tools.flatMap((t: unknown): SurfaceTool[] => {
		if (!isObject(t)) return [];
		if (Array.isArray(t.functionDeclarations))
			return (t.functionDeclarations as Schema[]).map((d) => ({
				name: typeof d.name === "string" ? d.name : "?",
				description: typeof d.description === "string" ? d.description : "",
				inputSchema: d.parameters ?? d.parametersJsonSchema ?? {},
			}));
		if (typeof t.type === "string" && t.type !== "function" && t.type !== "custom") return [];
		const { name, description, schema } = toolParts(t);
		return [{ name, description, inputSchema: schema }];
	});
}

/** Mock tool definitions from a recorded `tools/list` result, with names, descriptions and schemas kept verbatim. */
export function toolsFromSnapshot(snapshot: {
	tools: { name: string; description?: string; inputSchema?: unknown; outputSchema?: unknown }[];
}): ToolDef[] {
	return snapshot.tools.map((t) => {
		if (!isObject(t.inputSchema) || t.inputSchema.type !== "object")
			throw new Error(`toolsFromSnapshot: tool ${t.name} has no object inputSchema`);
		if (t.outputSchema !== undefined && (!isObject(t.outputSchema) || t.outputSchema.type !== "object"))
			throw new Error(`toolsFromSnapshot: tool ${t.name} has an outputSchema that is not an object schema`);
		return {
			name: t.name,
			description: t.description ?? "",
			inputSchema: t.inputSchema as ToolDef["inputSchema"],
			// Kept, so a mock built from a production snapshot sends structured output as production does.
			...(t.outputSchema ? { outputSchema: t.outputSchema as NonNullable<ToolDef["outputSchema"]> } : {}),
		};
	});
}

/** Sub-schemas one level down: properties, items, combinators and a schema-valued `additionalProperties`. */
function children(s: Schema): unknown[] {
	const items = Array.isArray(s.items) ? s.items : s.items === undefined ? [] : [s.items];
	return [
		...(isObject(s.properties) ? Object.values(s.properties) : []),
		...items,
		...(Array.isArray(s.prefixItems) ? s.prefixItems : []),
		...(["anyOf", "oneOf", "allOf"] as const).flatMap((k) => (Array.isArray(s[k]) ? s[k] : [])),
		...(isObject(s.additionalProperties) ? [s.additionalProperties] : []),
	];
}

/** Nesting depth counted in object and array levels; a scalar is 0, a flat object 1. */
function schemaDepth(schema: unknown): number {
	if (!isObject(schema)) return 0;
	const container =
		schema.type === "object" ||
		schema.type === "array" ||
		schema.properties !== undefined ||
		schema.items !== undefined;
	return (container ? 1 : 0) + Math.max(0, ...children(schema).map(schemaDepth));
}

/** Property paths without a description, through nested objects (`a.b`) and array items (`a[].b`). */
function undocumentedParams(schema: unknown, prefix = ""): string[] {
	if (!isObject(schema) || !isObject(schema.properties)) return [];
	return Object.entries(schema.properties).flatMap(([key, value]) => {
		const path = prefix ? `${prefix}.${key}` : key;
		if (!isObject(value)) return [path];
		const own = typeof value.description === "string" && value.description.trim() ? [] : [path];
		return own.concat(undocumentedParams(value, path), undocumentedParams(value.items, `${path}[]`));
	});
}

/** Every `description` string in a schema with its property path (`a.b`, `a[]`); `""` is the schema's own. */
function schemaDescriptions(schema: unknown, path = ""): [string, string][] {
	if (Array.isArray(schema)) return schema.flatMap((s) => schemaDescriptions(s, path));
	if (!isObject(schema)) return [];
	const own: [string, string][] = typeof schema.description === "string" ? [[path, schema.description]] : [];
	const nested = Object.entries(schema).flatMap(([key, value]): [string, string][] => {
		if (key === "properties" && isObject(value))
			return Object.entries(value).flatMap(([p, sub]) => schemaDescriptions(sub, path ? `${path}.${p}` : p));
		if (key === "items") return schemaDescriptions(value, `${path}[]`);
		return key === "description" ? [] : schemaDescriptions(value, path);
	});
	return [...own, ...nested];
}

/** Paths of objects with no declared keys and no typed `additionalProperties`; `""` is the root. */
function openObjects(schema: unknown, path = ""): string[] {
	if (!isObject(schema)) return [];
	const open =
		schema.type === "object" &&
		schema.properties === undefined &&
		schema.patternProperties === undefined &&
		(schema.additionalProperties === undefined || schema.additionalProperties === true) &&
		!["anyOf", "oneOf", "allOf"].some((k) => schema[k] !== undefined);
	const nested = isObject(schema.properties)
		? Object.entries(schema.properties).flatMap(([k, v]) => openObjects(v, path ? `${path}.${k}` : k))
		: [];
	return [...(open ? [path] : []), ...nested, ...openObjects(schema.items, `${path}[]`)];
}

const STOP = new Set(["the", "and", "for", "with", "this", "that", "use", "when", "from", "into", "are", "its"]);

function words(text: string): Set<string> {
	return new Set(
		text
			.toLowerCase()
			.split(/[^a-z0-9]+/)
			.filter((w) => w.length > 2 && !STOP.has(w)),
	);
}

function jaccard(a: Set<string>, b: Set<string>): number {
	if (a.size === 0 || b.size === 0) return 0;
	let shared = 0;
	for (const w of a) if (b.has(w)) shared++;
	return shared / (a.size + b.size - shared);
}
