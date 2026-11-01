import { fauxAssistantMessage } from "@octocodeai/octocode-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { orderToolNames } from "../../src/core/agent-session/tool-definitions.ts";
import type { ExtensionAPI, ExtensionFactory } from "../../src/core/extensions/types.ts";
import { createHarness, type Harness } from "./harness.ts";

const register = (api: ExtensionAPI, name: string, namespace?: string) =>
	api.registerTool({
		name,
		label: name,
		description: `${name} tool.`,
		parameters: Type.Object({}),
		...(namespace ? { namespace: { name: namespace } } : {}),
		execute: async () => ({ content: [], details: {} }),
	});

/** An extension standing in for an MCP server that registers its tools when its connection completes. */
const server =
	(namespace: string, tools: string[]): ExtensionFactory =>
	(api) => {
		for (const tool of tools) register(api, `${namespace}__${tool}`, namespace);
	};

describe("declared tool order", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function declared(factories: ExtensionFactory[]): Promise<string[]> {
		const harness = await createHarness({ extensionFactories: factories });
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		harness.setResponses([fauxAssistantMessage("ok")]);
		await harness.session.prompt("go");
		return harness.session.agent.state.tools.map((tool) => tool.name);
	}

	it("sorts MCP tools by namespace and name whichever server registers first", async () => {
		const plain: ExtensionFactory = (api) => register(api, "plain_tool");
		const alpha = server("mcp__alpha", ["zeta", "beta"]);
		const beta = server("mcp__beta", ["gamma", "alpha"]);
		const forward = await declared([plain, alpha, beta]);
		const reverse = await declared([plain, beta, alpha]);
		const mcp = ["mcp__alpha__beta", "mcp__alpha__zeta", "mcp__beta__alpha", "mcp__beta__gamma"];
		expect(forward.filter((name) => name.startsWith("mcp__"))).toEqual(mcp);
		expect(reverse).toEqual(forward);
		// Tools that are not MCP tools keep their place, ahead of the MCP tools.
		expect(forward.indexOf("plain_tool")).toBeLessThan(forward.indexOf(mcp[0]));
	});
});

describe("orderToolNames", () => {
	const namespaces: Record<string, string> = {
		mcp__b__x: "mcp__b",
		mcp__a__y: "mcp__a",
		mcp__a__x: "mcp__a",
		mcp__octocode__lspSearch: "mcp__octocode",
		mcp__octocode__localFetch: "mcp__octocode",
	};
	const namespaceOf = (name: string) => namespaces[name];

	it("keeps other tools in order, then MCP tools by namespace and name, without duplicates", () => {
		expect(orderToolNames(["read", "mcp__b__x", "bash", "mcp__a__y", "mcp__a__x", "read"], namespaceOf)).toEqual([
			"bash",
			"read",
			"mcp__a__x",
			"mcp__a__y",
			"mcp__b__x",
		]);
	});

	it("declares role-invariant tools first and role-variant tools last, whatever order they arrive in", () => {
		const invariant = ["bash", "file", "web", "archive", "mcp"];
		const variant = ["backlog", "steps", "memory", "debug", "askUser", "agent", "skill"];
		const octocode = ["mcp__octocode__localFetch", "mcp__octocode__lspSearch"];
		const arrivals = [
			[...variant, ...invariant, ...octocode, "mcp__a__x"],
			[...octocode, "mcp__a__x", ...invariant.slice().reverse(), ...variant.slice().reverse()],
		];
		for (const names of arrivals)
			expect(orderToolNames(names, namespaceOf)).toEqual([...invariant, ...octocode, "mcp__a__x", ...variant]);
	});

	it("gives a child and its parent the same declaration prefix up to the first role-variant tool", () => {
		const shared = ["bash", "file", "web", "archive", "mcp"];
		const octocode = ["mcp__octocode__localFetch", "mcp__octocode__lspSearch"];
		// The parent also has debug, the browser server, askUser and a skill tool; a read-only child has none of them.
		const parent = orderToolNames(
			["skill", "debug", "askUser", "agent", "memory", "backlog", ...octocode, "mcp__a__x", ...shared],
			namespaceOf,
		);
		const child = orderToolNames(["agent", "memory", "backlog", ...octocode, ...shared], namespaceOf);
		expect(parent.slice(0, shared.length + octocode.length)).toEqual([...shared, ...octocode]);
		expect(child.slice(0, shared.length + octocode.length)).toEqual([...shared, ...octocode]);
	});
});
