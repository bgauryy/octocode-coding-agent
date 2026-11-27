import { describe, expect, it } from "vitest";
import { createEventBus } from "@octocodeai/octocode-agent-core";
import { PendingMcpTools } from "../src/core/agent-session/pending-mcp-tools.ts";
import { type McpServerStatus, setMcpSessionStatus } from "../../mcp/src/status.ts";

const server = (name: string, state: string, enabled = true): McpServerStatus => ({
	name,
	enabled,
	state,
	exposure: "direct",
	toolCount: 0,
	source: "test",
});

function setup(initial: McpServerStatus[], names: string[]) {
	const events = createEventBus();
	setMcpSessionStatus(events, initial);
	const pending = new Set(names);
	const pendingMcp = new PendingMcpTools();
	return { events, pending, pendingMcp, retain: () => pendingMcp.retain(() => pending, events) };
}

describe("PendingMcpTools", () => {
	it("keeps MCP tools of connecting servers at run start and drops every other pending tool, including unselected servers", () => {
		const { pending, retain } = setup(
			[
				server("browser-tools", "starting"),
				server("docs", "connecting"),
				server("ready", "connected"),
				server("broken", "failed"),
				server("off", "disabled", false),
				server("browser", "unselected"),
				server("held", "not checked"),
			],
			[
				"bash",
				"mcp__browser__open",
				"mcp__browser_tools__open",
				"mcp__docs__search",
				"mcp__ready__a",
				"mcp__broken__a",
				"mcp__off__a",
				"mcp__gone__a",
				"mcp__held__a",
			],
		);

		retain();

		expect([...pending].sort()).toEqual(["mcp__browser_tools__open", "mcp__docs__search"]);
	});

	it("drops everything when no MCP status is published", () => {
		const events = createEventBus();
		const pending = new Set(["bash", "mcp__docs__search"]);
		new PendingMcpTools().retain(() => pending, events);
		expect([...pending]).toEqual([]);
	});

	it.each([
		["fails", server("docs", "failed")],
		["stops", server("docs", "stopped")],
		["is disabled", server("docs", "disabled", false)],
		// Switched on, but the security review holds it back: it never starts, so its tools never register.
		["is held back by the security review", server("docs", "not checked")],
		["is removed", undefined],
	])("drops its pending tools when the server %s", (_, next) => {
		const { events, pending, retain } = setup(
			[server("docs", "connecting"), server("other", "connecting")],
			["mcp__docs__search", "mcp__other__a"],
		);
		retain();

		setMcpSessionStatus(events, [...(next ? [next] : []), server("other", "connecting")]);

		expect([...pending]).toEqual(["mcp__other__a"]);
	});

	it("keeps pending tools while their server connects, and stops watching once none are pending", () => {
		const { events, pending, pendingMcp, retain } = setup([server("docs", "starting")], ["mcp__docs__search"]);
		retain();

		setMcpSessionStatus(events, [server("docs", "connecting")]);
		setMcpSessionStatus(events, [server("docs", "connected")]);
		expect([...pending]).toEqual(["mcp__docs__search"]);

		// The tool registers and leaves the pending set; a later failure has nothing left to drop.
		pending.clear();
		setMcpSessionStatus(events, [server("docs", "failed")]);
		pending.add("mcp__docs__search");
		setMcpSessionStatus(events, [server("docs", "failed")]);
		expect([...pending]).toEqual(["mcp__docs__search"]);
		pendingMcp.dispose();
	});

	it("stops watching when disposed", () => {
		const { events, pending, pendingMcp, retain } = setup([server("docs", "connecting")], ["mcp__docs__search"]);
		retain();
		pendingMcp.dispose();

		setMcpSessionStatus(events, [server("docs", "failed")]);

		expect([...pending]).toEqual(["mcp__docs__search"]);
	});
});
