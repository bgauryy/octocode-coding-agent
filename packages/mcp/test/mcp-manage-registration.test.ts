import { expect, it, vi } from "vitest";
import { createEventBus } from "../../coding-agent/src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../../coding-agent/src/core/extensions/loader.ts";
import type { ExtensionAPI } from "../../coding-agent/src/core/extensions/types.ts";
import { fakeCtx } from "../../coding-agent/test/octocode/fake-pi.ts";
import { registerMcpManageTool } from "../src/manage-tool-wiring.ts";
import { McpExtensionState } from "../src/state.ts";

it("does not claim or remove another extension's server when registration fails during approval", async () => {
	const runtime = createExtensionRuntime();
	const events = createEventBus();
	let state!: McpExtensionState;
	const extension = await loadExtensionFromFactory(
		(api) => {
			state = new McpExtensionState(api, {});
			registerMcpManageTool(state);
		},
		process.cwd(),
		events,
		runtime,
		"<mcp>",
	);
	let other!: ExtensionAPI;
	await loadExtensionFromFactory(
		(api) => {
			other = api;
		},
		process.cwd(),
		events,
		runtime,
		"<other>",
	);
	const tool = extension.tools.get("mcp")!.definition;
	const ctx = {
		...fakeCtx({ cwd: process.cwd() }),
		tools: [],
		executeTool: vi.fn(async () => {
			throw new Error("Unexpected nested tool call");
		}),
	};
	vi.spyOn(ctx.ui, "confirm").mockImplementation(async () => {
		other.registerMcpServer("notes", { command: "other-owner" });
		return true;
	});
	const run = (params: Record<string, unknown>) => tool.execute("test", params, undefined, undefined, ctx);
	try {
		await expect(run({ intent: "add", server: "notes", config: { command: "new-server" } })).rejects.toThrow(
			'already registered by extension "<other>"',
		);
		state.servers = state.registeredServers().servers;
		const listed = await run({ intent: "list" });
		expect(listed.details).toMatchObject({ servers: [{ name: "notes", origin: "configured" }] });
		await expect(run({ intent: "remove", server: "notes" })).rejects.toThrow("comes from configuration");
		expect(runtime.mcpServers.list()).toEqual([
			{ name: "notes", config: { command: "other-owner" }, extensionPath: "<other>" },
		]);
	} finally {
		runtime.invalidate();
	}
});
