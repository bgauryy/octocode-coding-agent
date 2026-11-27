import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MCP_MANAGE_TOOL_NAME } from "@octocodeai/octocode-common/mcp-names";
import { NATIVE_FEATURES } from "../../src/main/native-features.ts";
import octocode from "../../src/octocode/index.ts";
import { getNativeToolNames, takesCallReason } from "../../src/octocode/permission/native-tools.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { resetOctocodeEnv, tmp } from "./helpers.ts";

type Schema = {
	type?: string;
	description?: string;
	required?: string[];
	properties?: Record<string, Schema>;
	items?: Schema;
	anyOf?: Schema[];
};

/** Tools that declare their own `reason` with a tool-specific description (`native/tools/archive/history.ts`). */
const ownReason = new Set(["archive"]);

/** The tools whose model-facing schema lacks a required string `reason`. */
const missingReason = (tools: Array<{ name: string; parameters: unknown }>): string[] =>
	tools
		.filter(({ parameters }) => {
			const schema = parameters as Schema;
			return !schema.required?.includes("reason") || schema.properties?.reason?.type !== "string";
		})
		.map(({ name }) => name);

/** Direct object arguments and object items, including the unified agent branches. */
const argumentContainers = (schema: Schema): Schema[] => [
	...Object.values(schema.properties ?? {}).flatMap((property) =>
		property.type === "object" && property.properties
			? [property]
			: property.type === "array" && property.items?.type === "object" && property.items.properties
				? [property.items]
				: [],
	),
	...(schema.anyOf ?? []).flatMap(argumentContainers),
];

/** The tools with an argument object that declares its own `reason` slot, though only `file` queries should. */
const nestedReasonSlots = (tools: Array<{ name: string; parameters: unknown }>): string[] =>
	tools
		.filter(({ parameters }) => argumentContainers(parameters as Schema).some((schema) => schema.properties?.reason))
		.map(({ name }) => name);

/** `reason` is the first declared property, so it is read before a long `queries` array. */
const reasonNotFirst = (tools: Array<{ name: string; parameters: unknown }>): string[] =>
	tools
		.filter(({ parameters }) => Object.keys((parameters as Schema).properties ?? {})[0] !== "reason")
		.map(({ name }) => name);

let saved: NodeJS.ProcessEnv;
beforeEach(() => {
	saved = { ...process.env };
	// Hermetic: a run inside an Octocode agent inherits its identity, which changes the registered tools.
	resetOctocodeEnv();
	process.env.OCTOCODE_HOME = tmp();
});
afterEach(() => {
	process.env = saved;
});

describe("the required reason on every core tool", () => {
	it("is required by every native tool a session registers, and every native tool is registered", async () => {
		const fake = fakeHost();
		Object.assign(fake.api.session, { getName: () => undefined });
		await octocode(fake.api);
		const ctx = fakeCtx({ cwd: tmp(), hasUI: true });
		Object.assign(ctx.ui, { onTerminalInput: () => () => undefined });
		await fake.fire("session_start", { type: "session_start", reason: "startup" }, ctx);
		const tools = fake.api.tools.getAll() as Array<{ name: string; parameters: unknown }>;
		expect(tools.map(({ name }) => name).sort()).toEqual(expect.arrayContaining(getNativeToolNames().sort()));
		const reasoned = tools.filter(({ name }) => takesCallReason(name));
		expect(missingReason(reasoned)).toEqual([]);
		expect(reasonNotFirst(reasoned)).toEqual([]);
		// Only the top-level slot is the model's; a nested one is declared where the tool reads it per item (`file` queries).
		expect(nestedReasonSlots(reasoned)).toEqual(["file"]);
		for (const { name, parameters } of reasoned) {
			// The shared schema carries no description (the policy says once what to write); only a tool that declares
			// its own `reason` (to read it in `execute`) adds one.
			const reason = (parameters as Schema).properties?.reason;
			expect(reason?.type, `${name} top-level reason`).toBe("string");
			if (!ownReason.has(name)) expect(reason, `${name} top-level reason`).toEqual({ type: "string" });
		}
	});

	it("is required by the built-in MCP extension's `mcp` tool", () => {
		const fake = fakeHost();
		const mcp = NATIVE_FEATURES.builtins.find((feature) => feature.id === "mcp");
		// The fake host lacks the MCP extension's other host methods (renderers, commands, servers); they do nothing here.
		const api = new Proxy(fake.api, {
			get: (target, property, receiver) =>
				property in target ? Reflect.get(target, property, receiver) : () => undefined,
		});
		mcp?.register(api);
		const tool = (fake.api.tools.getAll() as Array<{ name: string; parameters: unknown }>).find(
			({ name }) => name === MCP_MANAGE_TOOL_NAME,
		);
		expect(tool).toBeDefined();
		expect(takesCallReason(MCP_MANAGE_TOOL_NAME)).toBe(true);
		expect(missingReason([tool!])).toEqual([]);
		expect(reasonNotFirst([tool!])).toEqual([]);
		expect(nestedReasonSlots([tool!])).toEqual([]);
	});
});
