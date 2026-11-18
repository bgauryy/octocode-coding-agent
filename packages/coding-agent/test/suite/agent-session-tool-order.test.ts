import { fauxAssistantMessage } from "@octocodeai/octocode-ai";
import { Type } from "typebox";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { orderToolNames } from "../../src/core/agent-session/tool-definitions.ts";
import type { FeatureSetup, FeatureRegister } from "../../src/core/features/types.ts";
import { findToolCacheBoundary } from "../../src/core/tool-roles.ts";
import { createHarness, type Harness } from "./harness.ts";
import { publishRoles, RESEARCH, RESEARCH_ENTRY } from "../octocode/fake-research-roles.ts";
import { testFeatures } from "../helpers/features.ts";

const register = (api: FeatureSetup, name: string, namespace?: string, roleVariant?: boolean) =>
	api.tools.register({
		name,
		label: name,
		description: `${name} tool.`,
		parameters: Type.Object({}),
		...(namespace ? { namespace: { name: namespace } } : {}),
		...(roleVariant ? { roleVariant } : {}),
		execute: async () => ({ content: [], details: {} }),
	});

/** An extension standing in for an MCP server that registers its tools when its connection completes. */
const server =
	(namespace: string, tools: string[]): FeatureRegister =>
	(api) => {
		for (const tool of tools) register(api, `${namespace}__${tool}`, namespace);
	};

describe("declared tool order", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function declared(factories: FeatureRegister[]): Promise<string[]> {
		const harness = await createHarness({ features: testFeatures(factories) });
		harnesses.push(harness);
		await harness.session.bindFeatures({});
		harness.setResponses([fauxAssistantMessage("ok")]);
		await harness.session.prompt("go");
		return harness.session.agent.state.tools.map((tool) => tool.name);
	}

	it("sorts MCP tools by namespace and name whichever server registers first", async () => {
		const plain: FeatureRegister = (api) => register(api, "plain_tool");
		const alpha = server("mcp__alpha", ["zeta", "beta"]);
		const beta = server("mcp__beta", ["gamma", "alpha"]);
		const forward = await declared([plain, alpha, beta]);
		const reverse = await declared([plain, beta, alpha]);
		const mcp = ["mcp__alpha__beta", "mcp__alpha__zeta", "mcp__beta__alpha", "mcp__beta__gamma"];
		expect(forward.filter((name) => name.startsWith("mcp__"))).toEqual(mcp);
		expect(reverse).toEqual(forward);
		// Tools that are not MCP tools come ahead of the MCP tools.
		expect(forward.indexOf("plain_tool")).toBeLessThan(forward.indexOf(mcp[0]));
	});
});

describe("unlisted tools", () => {
	it("declare the same tool bytes and boundary whichever order they register in", async () => {
		const declare = async (names: string[]) => {
			const harness = await createHarness({
				features: testFeatures([(api) => names.forEach((n) => register(api, n))]),
			});
			try {
				await harness.session.bindFeatures({});
				harness.setResponses([fauxAssistantMessage("ok")]);
				await harness.session.prompt("go");
				const tools = harness.session.agent.state.tools;
				return {
					bytes: JSON.stringify(tools.map(({ name, description, parameters }) => ({ name, description, parameters }))),
					boundary: findToolCacheBoundary(
						tools.map((t) => t.name),
						(name) => tools.some((t) => t.name === name && t.roleVariant),
					),
				};
			} finally {
				harness.cleanup();
			}
		};
		const forward = await declare(["zz_tool", "aa_tool", "mm_tool"]);
		const reverse = await declare(["mm_tool", "zz_tool", "aa_tool"]);
		expect(reverse).toEqual(forward);
		expect(forward.bytes.indexOf("aa_tool")).toBeLessThan(forward.bytes.indexOf("zz_tool"));
	});
});

describe("role-variant tools", () => {
	it("declare after the shared tools and set the boundary from the definition alone", async () => {
		const declare = async (names: Array<[string, boolean]>) => {
			const harness = await createHarness({
				features: testFeatures([(api) => names.forEach(([name, variant]) => register(api, name, undefined, variant))]),
			});
			try {
				await harness.session.bindFeatures({});
				harness.setResponses([fauxAssistantMessage("ok")]);
				await harness.session.prompt("go");
				const tools = harness.session.agent.state.tools;
				const order = tools.map((tool) => tool.name);
				return {
					order,
					boundary: findToolCacheBoundary(order, (n) => tools.some((t) => t.name === n && t.roleVariant)),
				};
			} finally {
				harness.cleanup();
			}
		};
		const forward = await declare([
			["plain_b", false],
			["new_role_tool", true],
			["plain_a", false],
		]);
		const reverse = await declare([
			["plain_a", false],
			["plain_b", false],
			["new_role_tool", true],
		]);
		expect(reverse).toEqual(forward);
		expect(forward.boundary).toBe("new_role_tool");
		expect(forward.order.indexOf("plain_b")).toBeLessThan(forward.order.indexOf("new_role_tool"));
		expect(forward.order.at(-1)).toBe("new_role_tool");
	});
});

describe("orderToolNames", () => {
	beforeAll(() => publishRoles([RESEARCH_ENTRY]));
	afterAll(() => publishRoles([]));
	// The server with roles sorts after `mcp__a` by name, so its place first comes from its roles.
	const namespaces: Record<string, string> = {
		mcp__b__x: "mcp__b",
		mcp__a__y: "mcp__a",
		mcp__a__x: "mcp__a",
		[RESEARCH.reader]: "mcp__research",
		[RESEARCH.search]: "mcp__research",
	};
	const namespaceOf = (name: string) => namespaces[name];
	const research = [RESEARCH.search, RESEARCH.reader].toSorted();
	const variantNames = new Set([
		"backlog",
		"backlogPlan",
		"archive",
		"memory",
		"askUser",
		"agent",
		"skill",
		"models",
		"compact",
	]);
	const isVariant = (name: string) => variantNames.has(name);

	it("sorts other tools by name, then MCP tools by namespace and name, without duplicates", () => {
		expect(
			orderToolNames(["read", "mcp__b__x", "bash", "mcp__a__y", "mcp__a__x", "read"], namespaceOf, isVariant),
		).toEqual(["bash", "read", "mcp__a__x", "mcp__a__y", "mcp__b__x"]);
	});

	it("declares role-invariant tools first and role-variant tools last, whatever order they arrive in", () => {
		const invariant = ["bash", "file", "web", "mcp"];
		const variant = ["backlog", "backlogPlan", "archive", "memory", "askUser", "agent", "skill", "models", "compact"];
		const octocode = research;
		const arrivals = [
			[...variant, ...invariant, ...octocode, "mcp__a__x"],
			[...octocode, "mcp__a__x", ...invariant.slice().reverse(), ...variant.slice().reverse()],
		];
		for (const names of arrivals)
			expect(orderToolNames(names, namespaceOf, isVariant)).toEqual([
				...invariant,
				...octocode,
				"mcp__a__x",
				...variant,
			]);
	});

	it("places a definition-declared variant tool after the others with no list change", () => {
		const names = ["zz_role", "bash", "aa_plain", "agent", "mcp__a__x"];
		expect(orderToolNames(names, namespaceOf, (name) => name === "zz_role" || isVariant(name))).toEqual([
			"bash",
			"aa_plain",
			"mcp__a__x",
			"agent",
			"zz_role",
		]);
	});

	it("gives a child and its parent the same declaration prefix up to the first role-variant tool", () => {
		const shared = ["bash", "file", "web", "mcp"];
		const octocode = research;
		// The parent also has the browser server, askUser and a skill tool; a read-only child has none of them.
		const parent = orderToolNames(
			["skill", "askUser", "agent", "archive", "backlog", ...octocode, "mcp__a__x", ...shared],
			namespaceOf,
			isVariant,
		);
		const child = orderToolNames(["agent", "archive", "backlog", ...octocode, ...shared], namespaceOf, isVariant);
		expect(parent.slice(0, shared.length + octocode.length)).toEqual([...shared, ...octocode]);
		expect(child.slice(0, shared.length + octocode.length)).toEqual([...shared, ...octocode]);
	});
});
