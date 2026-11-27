import { join, resolve } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createHarness, createTestUiContext, type Harness } from "../../coding-agent/test/suite/harness.ts";
import { createSlotHost, PENDING, settled, type SlotHost } from "../../coding-agent/test/interactive-slot-host.ts";
import { initTheme } from "../../coding-agent/src/theme/theme.ts";
import type { McpServerEntry } from "../src/config.ts";
import { registerMcpHost } from "../src/index.ts";
import * as manager from "../src/manager.ts";
import type { McpFeatureState } from "../src/state.ts";
import { testFeatures } from "../../coding-agent/test/helpers/features.ts";

const entry: McpServerEntry = {
	name: "octocode",
	source: "built-in octocode",
	scope: "default",
	config: {
		command: process.execPath,
		args: [resolve(import.meta.dirname, "client/fixtures/stdio-server.mjs")],
		exposure: "direct",
	},
};

beforeAll(() => initTheme("dark"));

/** `/mcp` in the terminal manager when something else takes the editor slot. */
describe("the /mcp manager view displaced by another dialog, selector or the reset", () => {
	const harnesses: Harness[] = [];
	const states: McpFeatureState[] = [];
	const hosts: SlotHost[] = [];
	afterEach(async () => {
		vi.restoreAllMocks();
		for (const env of hosts.splice(0)) env.ui.stop();
		await Promise.all(states.splice(0).flatMap((state) => state.connections().map((connection) => connection.close())));
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	/** A session with the MCP host whose `/mcp` runs in the TUI and opens its view in `env`'s editor slot. */
	async function openMcp() {
		const env = createSlotHost();
		hosts.push(env);
		let state!: McpFeatureState;
		const harness = await createHarness({
			initialActiveToolNames: [],
			features: testFeatures([
				(api) => {
					state = registerMcpHost(
						{
							...api,
							commands: {
								register: (name, definition) =>
									api.commands.register(name, {
										...definition,
										handler: (args, ctx) => definition.handler(args, { ...ctx, mode: "tui" }),
									}),
							},
						},
						{
							loadConfig: (ctx) => ({ servers: [entry], errors: [], globalConfig: join(ctx.cwd, "agent", "mcp.json") }),
						},
					);
				},
			]),
		});
		harnesses.push(harness);
		states.push(state);
		await harness.session.bindFeatures({ uiContext: createTestUiContext({ custom: env.custom }) });
		await state.pending;

		const manage = manager.manage;
		let run: Promise<void> | undefined;
		vi.spyOn(manager, "manage").mockImplementation((...args) => {
			run = manage(...args);
			return run;
		});
		const listenersBefore = state.listeners.size;
		const command = harness.session.prompt("/mcp");
		await vi.waitFor(async () => expect(await env.screen()).toContain("MCP servers"));
		expect(await env.screen()).toContain("octocode");
		// The open menu rebuilds on MCP changes through one state listener.
		expect(state.listeners.size).toBe(listenersBefore + 1);
		expect(run).toBeDefined();
		return { env, state, command, run: run!, listenersBefore };
	}

	/** After displacement the run has ended, the menu no longer listens, and later changes neither throw nor render. */
	async function expectReleased(opened: Awaited<ReturnType<typeof openMcp>>) {
		await opened.command;
		expect(await settled(opened.run)).toBeUndefined();
		expect(opened.state.listeners.size).toBe(opened.listenersBefore);
		const renders = vi.spyOn(opened.env.ui, "requestRender");
		expect(() => opened.state.emitChange()).not.toThrow();
		expect(renders).not.toHaveBeenCalled();
	}

	it("an extension dialog taking the slot ends the manager and unsubscribes its menu", async () => {
		const opened = await openMcp();
		const answer = opened.env.host.showSelectorDialog("Extension question", ["yes", "no"]);
		expect(await opened.env.screen()).toContain("Extension question");
		await expectReleased(opened);
		// The dialog that displaced the manager stays open and answers normally.
		expect(await settled(answer)).toBe(PENDING);
		opened.env.host.hideSelectorDialog();
		expect(await settled(answer)).toBeUndefined();
		expect(opened.env.editorContainer.children).toEqual([opened.env.editor]);
	});

	it("a built-in selector taking the slot from a nested server menu ends the manager", async () => {
		const opened = await openMcp();
		// Enter the server's own menu, which subscribes again in place of the server list.
		opened.env.terminal.sendInput("\r");
		await vi.waitFor(async () => expect(await opened.env.screen()).toContain("octocode — MCP server"));
		expect(opened.state.listeners.size).toBe(opened.listenersBefore + 1);
		const selectorDispose = vi.fn();
		const selector = { render: () => ["built-in selector"], invalidate: () => {} };
		opened.env.host.showSelector(() => ({ component: selector, focus: selector, dispose: selectorDispose }));
		expect(await opened.env.screen()).toContain("built-in selector");
		await expectReleased(opened);
		expect(selectorDispose).not.toHaveBeenCalled();
	});

	it("the reset on reload or session replacement ends the manager", async () => {
		const opened = await openMcp();
		opened.env.host.resetFeatureUI();
		await expectReleased(opened);
		expect(await opened.env.screen()).not.toContain("MCP servers");
	});
});
