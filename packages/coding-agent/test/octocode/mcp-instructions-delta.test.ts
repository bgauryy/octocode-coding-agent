import "../mcp-host.ts";
import { getCurrentTools, getInitialSystemMessage } from "@octocodeai/octocode-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createMcpRefreshSetup,
	fresh,
	mcpsPatches,
	newestMcps,
	OLD_RULE,
	SEARCH,
	type ServerState,
	systemMessages,
} from "../suite/mcp-refresh-fixture.ts";
import type { Harness } from "../suite/harness.ts";

/**
 * Server instructions that change after the first request, in `declared` presentation (the default). The leading
 * system prompt and the tool list the first request carried are the provider's cached prefix; a late connect or a
 * removal reaches the model as the generic section diff's system-update message (`preparePromptAndToolLoadout`), and
 * the prefix is only appended to.
 */
const LATE_RULE = "Late rules: always cite the page.";
const late = (): ServerState => ({
	instructions: LATE_RULE,
	tools: [{ ...SEARCH, description: "Search late docs." }],
});

/** The leading system message exactly as the provider receives it: text, sections in order, initial tools. */
const leading = (harness: Harness) => {
	const head = getInitialSystemMessage(harness.session.messages);
	return head ? JSON.stringify([head.content, Object.entries(head.sections ?? {}), head.toolsAdded]) : undefined;
};

describe("MCP instructions after the first request (declared presentation)", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});
	const setup = createMcpRefreshSetup(harnesses);
	const toolNames = (harness: Harness) => getCurrentTools(harness.session.messages).map((tool) => tool.name);

	it("a server that connects late keeps the leading prompt byte-identical and adds one patch with its instructions", async () => {
		const { harness, callable, turn } = await setup(fresh(), { late: late(), presentation: "declared" });
		const first = await turn("start");
		// The late server was still pending when the first request went out.
		expect(newestMcps(first)).toContain("Not connected yet");
		const head = leading(harness);
		const before = toolNames(harness);
		await vi.waitFor(() => expect(callable()).toContain("mcp__late__search"));

		const updates = await turn("after connect");
		const patches = mcpsPatches(updates);
		expect(patches).toHaveLength(1);
		expect(patches[0]).toContain(LATE_RULE);
		expect(patches[0]).toContain(OLD_RULE);
		expect(patches[0]).not.toContain("Not connected yet");
		// Exactly one update carries it, and the leading message is untouched.
		expect(updates.filter((update) => update.sections?.["mcps"])).toHaveLength(1);
		expect(leading(harness)).toBe(head);
		// Existing declarations keep their order; the new server's tools are appended.
		const after = toolNames(harness);
		expect(after.slice(0, before.length)).toEqual(before);
		expect(after.slice(before.length)).toEqual(["mcp__late__search"]);
		// Later requests repeat nothing.
		expect(mcpsPatches(await turn("again"))).toEqual([]);
	});

	it("a server that is disabled leaves a patch without its block; the leading prompt stays identical", async () => {
		const { harness, callable, turn, switchMcp } = await setup(fresh(), { late: late(), presentation: "declared" });
		await turn("start");
		await vi.waitFor(() => expect(callable()).toContain("mcp__late__search"));
		await turn("after connect");
		expect(newestMcps(harness.session.messages)).toContain(LATE_RULE);
		const head = leading(harness);
		const from = harness.session.messages.length;

		await switchMcp("late", false);
		await turn("after disable");
		const patches = mcpsPatches(systemMessages(harness, from));
		expect(patches).toHaveLength(1);
		expect(patches[0]).not.toContain(LATE_RULE);
		expect(patches[0]).toContain(OLD_RULE);
		expect(newestMcps(harness.session.messages)).not.toContain(LATE_RULE);
		expect(leading(harness)).toBe(head);
	});

	it("a changed description or schema reaches the tool's declaration verbatim, with no patch of the block", async () => {
		const server = fresh();
		const { harness, listChanged, turn } = await setup(server, { presentation: "declared" });
		await turn("start");
		const head = leading(harness);
		const schema = { type: "object", properties: { title: { type: "string" } }, required: ["title"] };
		server.tools = [
			{ ...SEARCH, description: "Search the docs by title.", inputSchema: schema },
			...server.tools.slice(1),
		];
		await listChanged();

		const updates = await turn("after change");
		expect(mcpsPatches(updates)).toEqual([]);
		const declared = getCurrentTools(harness.session.messages).find((tool) => tool.name === "mcp__docs__search");
		expect(declared?.description).toContain("Search the docs by title.");
		expect(declared?.parameters).toMatchObject(schema);
		expect(leading(harness)).toBe(head);
	});

	it("before the first request nothing is patched: a server that connected in time is described once", async () => {
		const { harness, turn } = await setup(fresh(), { presentation: "declared" });
		const first = await turn("start");
		expect(newestMcps(first)).toContain(OLD_RULE);
		expect(mcpsPatches(await turn("second"))).toEqual([]);
		expect(systemMessages(harness).length).toBeGreaterThan(0);
	});
});
