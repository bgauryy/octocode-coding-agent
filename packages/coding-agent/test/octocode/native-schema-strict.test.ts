import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { anthropicToolSchema } from "../../../ai/src/api/ai-sdk/anthropic-map.ts";
import type { Tool } from "../../../ai/src/types.ts";
import octocode from "../../src/octocode/index.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

/**
 * Every native tool must be eligible for provider strict tool use, so `supportsStrictTools` can be switched on without
 * a grammar-compile 400 or a silent per-tool downgrade. The schemas are taken from the registry as the provider
 * receives them (after the native `reason` wrapper), then run through the Anthropic converter with strict `require`,
 * which throws the reason a schema is not eligible.
 */

/**
 * Free-form fields strict mode cannot describe. Each is a JSON-Schema-typed hole by design; the key is
 * `tool.path.to.property` and its property is replaced by an empty closed object before the check.
 */
const FREE_FORM = new Map<string, string>([
	["agent.resultSchema", "user-supplied JSON Schema for a child's structured result"],
	// Batch entries are plain objects so every request stays small (about 150 characters instead of 550-700 for spelled-out
	// entries); each entry is validated in code against the single call's own schema, so none goes unchecked.
	// `backlogPlan.items` is not here: its entries are typed, so strict mode constrains them like any other field.
	["agent.tasks", "batch entries, each validated against the single task call's schema (native/tools/agent/batch.ts)"],
	["backlog.items", "batch entries, each validated against the single write's fields (native/tools/backlog/tool.ts)"],
	["memory.items", "batch entries, each validated as a single set or delete (native/tools/memory/tool.ts)"],
	["notify.items", "batch entries, each validated against the single call's fields (native/tools/notify/tool.ts)"],
]);

type Node = Record<string, unknown>;

/** The schema with every allowlisted free-form property swapped for an empty closed object. */
function withoutFreeForm(tool: string, schema: Node): Node {
	const copy = structuredClone(schema);
	const walk = (node: unknown, path: string): void => {
		if (Array.isArray(node)) {
			for (const item of node) walk(item, path);
			return;
		}
		if (!node || typeof node !== "object") return;
		const record = node as Node;
		const properties = record.properties as Record<string, unknown> | undefined;
		if (properties) {
			for (const key of Object.keys(properties)) {
				const at = `${path}.${key}`;
				if (FREE_FORM.has(at)) properties[key] = { type: "object", properties: {}, additionalProperties: false };
				else walk(properties[key], at);
			}
		}
		for (const key of ["items", "anyOf", "oneOf", "allOf"]) walk(record[key], path);
	};
	walk(copy, tool);
	return copy;
}

/**
 * Open shapes the converter accepts but strict mode would close to nothing: it adds `additionalProperties: false` to
 * every object, so an object with no `properties` can only be `{}`, and an array without `items` has no element type.
 * Returns the `tool.path` of each such node that is not allowlisted.
 */
function openShapes(tool: string, schema: Node): string[] {
	const found: string[] = [];
	const walk = (node: unknown, path: string): void => {
		if (Array.isArray(node)) {
			for (const item of node) walk(item, path);
			return;
		}
		if (!node || typeof node !== "object") return;
		const record = node as Node;
		const types = Array.isArray(record.type) ? record.type : [record.type];
		const properties = record.properties as Record<string, unknown> | undefined;
		if (!FREE_FORM.has(path)) {
			if (types.includes("object") && !properties) found.push(`${path} is an open object`);
			if (types.includes("object") && types.length > 1) found.push(`${path} mixes object with another type`);
			if (types.includes("array") && !record.items) found.push(`${path} is an array without items`);
		}
		for (const [key, value] of Object.entries(properties ?? {})) walk(value, `${path}.${key}`);
		for (const key of ["items", "anyOf", "oneOf", "allOf"]) walk(record[key], path);
	};
	walk(schema, tool);
	return found;
}

/** Why the converter refuses the tool's schema in strict mode, or undefined when it is eligible. */
function strictViolation(name: string, description: string, parameters: Node): string | undefined {
	const tool = {
		name,
		description,
		parameters: withoutFreeForm(name, parameters),
		constrainedSampling: { type: "json_schema", strict: "require" },
	} as unknown as Tool;
	try {
		const converted = anthropicToolSchema(tool, true);
		return (converted as { strict?: boolean }).strict === true ? undefined : "converted without strict";
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

let saved: NodeJS.ProcessEnv;
beforeEach(() => {
	saved = { ...process.env };
	process.env.OCTOCODE_HOME = tmp();
});
afterEach(() => {
	process.env = saved;
});

describe("native tool schemas are strict-eligible", () => {
	for (const subagent of [false, true]) {
		it(`every declared tool converts in strict mode (${subagent ? "subagent" : "main session"})`, async () => {
			if (subagent) process.env.OCTOCODE_SUBAGENT = "1";
			// Every tool declared in full: a deferred declaration (`mcpExposure: "recent"`) carries only its top-level field
			// names, by design open, and the schema checked here is the one a used tool declares.
			const fake = fakeHost({ mcpExposure: "direct" });
			Object.assign(fake.api.session, { getName: () => undefined });
			await octocode(fake.api);
			const ctx = fakeCtx({ cwd: tmp(), hasUI: !subagent });
			Object.assign(ctx.ui, { onTerminalInput: () => () => undefined });
			await fake.fire("session_start", { type: "session_start", reason: "startup" }, ctx);
			const tools = fake.api.tools.getAll() as unknown as Array<{
				name: string;
				description: string;
				parameters: Node;
			}>;
			expect(tools.length).toBeGreaterThan(5);
			const violations = tools.flatMap((tool) => {
				const why = strictViolation(tool.name, tool.description, tool.parameters);
				return [...(why ? [`${tool.name}: ${why}`] : []), ...openShapes(tool.name, tool.parameters)];
			});
			expect(violations).toEqual([]);
		});
	}

	it("the free-form allowlist names only fields that exist", async () => {
		const fake = fakeHost();
		Object.assign(fake.api.session, { getName: () => undefined });
		await octocode(fake.api);
		const ctx = fakeCtx({ cwd: tmp(), hasUI: true });
		Object.assign(ctx.ui, { onTerminalInput: () => () => undefined });
		await fake.fire("session_start", { type: "session_start", reason: "startup" }, ctx);
		const tools = fake.api.tools.getAll() as unknown as Array<{ name: string; parameters: Node }>;
		for (const path of FREE_FORM.keys()) {
			const [name, ...keys] = path.split(".");
			let node: unknown = tools.find((tool) => tool.name === name)?.parameters;
			for (const key of keys) node = (node as { properties?: Record<string, unknown> } | undefined)?.properties?.[key];
			expect(node, `${path} is declared`).toBeDefined();
		}
	});
});
