import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MCP_MANAGE_TOOL_NAME } from "../../../mcp/src/servers.ts";
import { BUILTIN_FEATURES } from "../../src/core/resource-loader/builtins.ts";
import octocode from "../../src/octocode/index.ts";
import { getNativeToolNames, takesCallReason } from "../../src/octocode/permission/native-tools.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

type Schema = {
	type?: string;
	description?: string;
	required?: string[];
	properties?: Record<string, Schema>;
	items?: Schema;
	anyOf?: Schema[];
};

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

const missingNestedReason = (tools: Array<{ name: string; parameters: unknown }>): string[] =>
	tools
		.filter(({ parameters }) =>
			argumentContainers(parameters as Schema).some((schema) => schema.properties?.reason?.type !== "string"),
		)
		.map(({ name }) => name);

let saved: NodeJS.ProcessEnv;
beforeEach(() => {
	saved = { ...process.env };
	// Hermetic: a run inside an Octocode agent inherits its identity, which changes the registered tools.
	for (const key of Object.keys(process.env)) if (key.startsWith("OCTOCODE_")) delete process.env[key];
	process.env.OCTOCODE_HOME = tmp();
});
afterEach(() => {
	process.env = saved;
});

describe("the required reason on every core tool", () => {
	it("is required by every native tool a session registers, and every native tool is registered", async () => {
		const fake = fakeHost();
		Object.assign(fake.api, { getSessionName: () => undefined });
		await octocode(fake.api);
		const ctx = fakeCtx({ cwd: tmp(), hasUI: true });
		Object.assign(ctx.ui, { onTerminalInput: () => () => undefined });
		await fake.fire("session_start", { type: "session_start", reason: "startup" }, ctx);
		const tools = fake.api.getAllTools() as Array<{ name: string; parameters: unknown }>;
		expect(tools.map(({ name }) => name).sort()).toEqual(expect.arrayContaining(getNativeToolNames().sort()));
		const reasoned = tools.filter(({ name }) => takesCallReason(name));
		expect(missingReason(reasoned)).toEqual([]);
		expect(missingNestedReason(reasoned)).toEqual([]);
		// The top-level slot is the one the model reads and carries the description; nested slots only accept a lifted value.
		for (const { name, parameters } of reasoned) {
			const root = parameters as Schema;
			const described = root.properties?.reason?.description;
			expect(described, `${name} top-level reason`).toBeTruthy();
			for (const container of argumentContainers(root)) {
				expect(container.properties?.reason?.description, `${name} nested reason`).not.toBe(described);
			}
		}
	});

	it("is required by the built-in MCP extension's `mcp` tool", () => {
		const fake = fakeHost();
		const mcp = BUILTIN_FEATURES.find((feature) => feature.id === "mcp");
		// The fake host lacks the MCP extension's other host methods (renderers, commands, servers); they do nothing here.
		const api = new Proxy(fake.api, {
			get: (target, property, receiver) =>
				property in target ? Reflect.get(target, property, receiver) : () => undefined,
		});
		mcp?.register(api);
		const tool = (fake.api.getAllTools() as Array<{ name: string; parameters: unknown }>).find(
			({ name }) => name === MCP_MANAGE_TOOL_NAME,
		);
		expect(tool).toBeDefined();
		expect(takesCallReason(MCP_MANAGE_TOOL_NAME)).toBe(true);
		expect(missingReason([tool!])).toEqual([]);
		expect(missingNestedReason([tool!])).toEqual([]);
	});
});
