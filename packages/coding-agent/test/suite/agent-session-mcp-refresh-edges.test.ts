import "../mcp-host.ts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Harness } from "./harness.ts";
import {
	createMcpRefreshSetup,
	currentStatus,
	FAIL,
	fresh,
	mcpsPatches,
	newestMcps,
	NEW_RULE,
	SEARCH,
	toolChanges,
} from "./mcp-refresh-fixture.ts";

/**
 * Edges of the `mcps` semantic refresh (option A) in a real AgentSession. The block is renewed only when
 * the connected server's instructions or a described tool's description or schemas change; everything else keeps the
 * block's bytes and the thin declarations built from it, and `mcp_status` names what is not ready.
 */

describe("AgentSession MCP refresh edges", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});
	const setup = createMcpRefreshSetup(harnesses);

	it("F3-a1: a tool withdrawn then offered again with the same contract leaves no status and no patch", async () => {
		const server = fresh();
		const { harness, callable, listChanged, turn, thin } = await setup(server);
		const block = newestMcps(await turn("start"));
		server.tools = [SEARCH];
		await listChanged();
		await vi.waitFor(() => expect(callable()).not.toContain("mcp__docs__fail"));
		const withdrawn = await turn("withdrawn");
		expect(currentStatus(harness.session.messages)).toContain("not declared: fail");
		server.tools = [SEARCH, { ...FAIL }];
		await listChanged();
		await vi.waitFor(() => expect(callable()).toContain("mcp__docs__fail"));
		const back = await turn("back");
		expect(mcpsPatches([...withdrawn, ...back])).toEqual([]);
		expect(newestMcps(harness.session.messages)).toBe(block);
		expect(currentStatus(harness.session.messages)).toBeUndefined();
		expect(toolChanges(back)).toEqual(["+mcp__docs__fail"]);
		expect(thin("mcp__docs__fail")).toBe(true);
	});

	it("F3-a2: a server disabled and enabled again between two requests appends nothing", async () => {
		const { harness, callable, turn, thin, switchMcp } = await setup(fresh());
		const block = newestMcps(await turn("start"));
		await switchMcp("docs", false);
		await vi.waitFor(() => expect(callable()).not.toContain("mcp__docs__search"));
		await switchMcp("docs", true);
		await vi.waitFor(() => expect(callable()).toContain("mcp__docs__search"));
		const updates = await turn("after re-enable");
		expect(mcpsPatches(updates)).toEqual([]);
		expect(toolChanges(updates)).toEqual([]);
		expect(newestMcps(harness.session.messages)).toBe(block);
		expect(currentStatus(harness.session.messages)).toBeUndefined();
		expect(thin("mcp__docs__search")).toBe(true);
	});

	it("F3-a3: a server disabled for one request comes back with its block once and one current status", async () => {
		const { harness, callable, turn, switchMcp } = await setup(fresh());
		const block = newestMcps(await turn("start"));
		await switchMcp("docs", false);
		await vi.waitFor(() => expect(callable()).not.toContain("mcp__docs__search"));
		await turn("while disabled");
		expect(newestMcps(harness.session.messages)).toBeUndefined();
		await switchMcp("docs", true);
		await vi.waitFor(() => expect(callable()).toContain("mcp__docs__search"));
		const back = await turn("after re-enable");
		expect(mcpsPatches(back)).toEqual([block]);
		expect(currentStatus(harness.session.messages)).toBeUndefined();
	});

	it("F3-b1: a reconnect that reorders the tools and their schema keys appends nothing and keeps them thin", async () => {
		const server = fresh();
		const { reconnect, turn, thin } = await setup(server);
		await turn("start");
		server.tools = [
			{ ...FAIL, inputSchema: { properties: {}, type: "object" } },
			{
				inputSchema: { required: ["query"], properties: { query: { type: "string" } }, type: "object" },
				description: SEARCH.description,
				name: SEARCH.name,
			},
		];
		await reconnect();
		const updates = await turn("after reorder");
		expect(mcpsPatches(updates)).toEqual([]);
		expect(toolChanges(updates)).toEqual([]);
		expect(thin("mcp__docs__search")).toBe(true);
		expect(thin("mcp__docs__fail")).toBe(true);
	});

	it("F3-b2: a change outside the contract (title, execution) keeps the block and the thin declaration", async () => {
		const server = fresh();
		const { listChanged, turn, thin } = await setup(server);
		await turn("start");
		expect(thin("mcp__docs__search")).toBe(true);
		// The client keeps `title` and `execution` (`toTool`); neither is part of the block, which shows the description.
		server.tools = [{ ...SEARCH, title: "Docs search", execution: { taskSupport: "optional" } }, FAIL];
		await listChanged();
		const updates = await turn("after metadata change");
		expect(mcpsPatches(updates)).toEqual([]);
		expect(thin("mcp__docs__search")).toBe(true);
		expect(toolChanges(updates)).not.toContain("+mcp__docs__search");
	});

	it("F3-b3: in compact presentation a title the block does not show appends nothing and stays thin", async () => {
		const server: ReturnType<typeof fresh> = { ...fresh(), tools: [{ ...SEARCH, description: "", title: "A" }, FAIL] };
		const { listChanged, turn, thin } = await setup(server);
		await turn("start");
		server.tools = [{ ...SEARCH, description: "", title: "B" }, FAIL];
		await listChanged();
		const updates = await turn("after title change");
		expect(mcpsPatches(updates)).toEqual([]);
		expect(thin("mcp__docs__search")).toBe(true);
	});

	it("F3-c/g: a tool the agent does not hold changes its contract with no refresh", async () => {
		const server = fresh();
		const { harness, listChanged, turn } = await setup(server);
		// The agent (a role with fewer MCP tools) holds only search.
		harness.session.setActiveToolsByName(["mcp__docs__search"]);
		const block = newestMcps(await turn("start"));
		expect(block).not.toContain("Always fails.");
		server.tools = [SEARCH, { ...FAIL, description: "Always fails, loudly." }];
		await listChanged();
		const updates = await turn("after change of an unheld tool");
		expect(mcpsPatches(updates)).toEqual([]);
		expect(newestMcps(harness.session.messages)).toBe(block);
		expect(harness.session.getActiveToolNames()).not.toContain("mcp__docs__fail");
	});

	it("F3-e: in json presentation a reload is a no-op and a changed description appends one patch", async () => {
		const server = fresh();
		const { listChanged, reconnect, turn, thin } = await setup(server, { presentation: "json" });
		const block = newestMcps(await turn("start"));
		expect(block).toContain("Input schema (JSON Schema)");
		await reconnect();
		server.tools = server.tools.map((tool) => ({ ...tool }));
		await listChanged();
		const noop = await turn("after reload");
		expect(mcpsPatches(noop)).toEqual([]);
		expect(toolChanges(noop)).toEqual([]);
		server.tools = [{ ...SEARCH, description: "Search the docs by title." }, FAIL];
		await listChanged();
		const changed = await turn("after change");
		const patches = mcpsPatches(changed);
		expect(patches).toHaveLength(1);
		expect(patches[0]).toContain("Search the docs by title.");
		expect(thin("mcp__docs__search")).toBe(true);
	});

	it("F3-e2: in json presentation the title a tool without description shows is part of its contract", async () => {
		const server: ReturnType<typeof fresh> = {
			...fresh(),
			tools: [{ ...SEARCH, description: "", title: "Docs search" }, FAIL],
		};
		const { listChanged, turn, thin } = await setup(server, { presentation: "json" });
		expect(newestMcps(await turn("start"))).toContain("Docs search");
		server.tools = [{ ...SEARCH, description: "", title: "Search docs by title" }, FAIL];
		await listChanged();
		const patches = mcpsPatches(await turn("after title change"));
		expect(patches).toHaveLength(1);
		expect(patches[0]).toContain("Search docs by title");
		expect(thin("mcp__docs__search")).toBe(true);
	});

	const twoModels = [{ id: "faux-a" }, { id: "faux-b" }];

	it("F3-d1: a loadout rebuild after a refresh keeps one current section and no status", async () => {
		const server = fresh();
		const { harness, listChanged, turn, thin } = await setup(server, { models: twoModels });
		await turn("start");
		server.tools = [{ ...SEARCH, description: "Search the docs by title." }, FAIL];
		await listChanged();
		const refreshed = mcpsPatches(await turn("after change"))[0];
		expect(refreshed).toContain("Search the docs by title.");
		await harness.session.setModel(harness.models[1]);
		const updates = await turn("after rebuild");
		expect(mcpsPatches(updates)).toEqual([]);
		expect(newestMcps(harness.session.messages)).toBe(refreshed);
		expect(currentStatus(harness.session.messages)).toBeUndefined();
		expect(thin("mcp__docs__search")).toBe(true);
	});

	it("F3-d2: a rebuild after a withdrawal describes the server once without the tool and clears its status", async () => {
		const server = fresh();
		const { harness, callable, listChanged, turn, thin } = await setup(server, { models: twoModels });
		await turn("start");
		server.tools = [SEARCH];
		await listChanged();
		await vi.waitFor(() => expect(callable()).not.toContain("mcp__docs__fail"));
		expect(mcpsPatches(await turn("after withdrawal"))).toEqual([]);
		expect(currentStatus(harness.session.messages)).toContain("not declared: fail");
		await harness.session.setModel(harness.models[1]);
		const patches = mcpsPatches(await turn("after rebuild"));
		expect(patches).toHaveLength(1);
		expect(patches[0]).not.toContain("Always fails.");
		expect(newestMcps(harness.session.messages)).toBe(patches[0]);
		expect(currentStatus(harness.session.messages)).toBeUndefined();
		expect(mcpsPatches(await turn("after that"))).toEqual([]);
		expect(thin("mcp__docs__search")).toBe(true);
	});

	it("F3-f: a compaction between a contract change and the next request projects the current section once", async () => {
		const server = fresh();
		const { harness, listChanged, turn } = await setup(server);
		await turn("start");
		await turn("one more");
		server.instructions = NEW_RULE;
		await listChanged();
		await harness.session.prompt("/mcp reconnect docs");
		await vi.waitFor(() => expect(harness.session.getCallableToolNames()).toContain("mcp__docs__search"));
		await harness.session.compact();
		const patches = mcpsPatches(await turn("after compaction"));
		expect(patches).toHaveLength(1);
		expect(patches[0]).toContain(NEW_RULE);
		const copies = (messages: ReturnType<typeof harness.sessionManager.buildSessionContext>["messages"]) =>
			mcpsPatches(messages.filter((message) => message.role === "system")).filter((text) => text === patches[0]);
		expect(copies(harness.sessionManager.buildSessionContext().messages)).toHaveLength(1);
		expect(newestMcps(harness.sessionManager.buildSessionContext().messages)).toBe(patches[0]);
		await turn("later");
		await harness.session.compact();
		const compacted = harness.sessionManager.buildSessionContext().messages;
		expect(copies(compacted).length).toBeLessThanOrEqual(1);
		expect(newestMcps(compacted)).toBe(patches[0]);
		expect(mcpsPatches(await turn("after second compaction"))).toEqual([]);
	});
});
