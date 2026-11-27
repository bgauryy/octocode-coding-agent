import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { ToolExposureListSchema, ToolPinCommandSchema, type ToolExposureList } from "../src/config.ts";
import { DAEMON_ROUTES } from "../src/protocol.ts";

const list: ToolExposureList = {
	setting: "recent",
	live: true,
	groups: [
		{
			kind: "native",
			name: "native",
			pinnable: true,
			tools: [
				{ name: "archive", pin: "deferred", state: "deferred", decidedBy: "pin" },
				{ name: "bash", state: "direct", decidedBy: "core" },
			],
		},
		{
			kind: "mcp",
			name: "docs",
			pinnable: true,
			note: "Not connected in the running session, so only pinned tools are listed.",
			tools: [{ name: "search", pin: "hidden", state: "hidden", decidedBy: "pin" }],
		},
	],
	workspace: { trusted: true },
};

describe("tool exposure contract", () => {
	it("accepts the read model and refuses a state, a reason or a field it does not know", () => {
		expect(Value.Check(ToolExposureListSchema, list)).toBe(true);
		const withRow = (row: unknown) => ({ ...list, groups: [{ ...list.groups[0], tools: [row] }] });
		expect(Value.Check(ToolExposureListSchema, withRow({ name: "archive", state: "full", decidedBy: "pin" }))).toBe(
			false,
		);
		expect(Value.Check(ToolExposureListSchema, withRow({ name: "archive", state: "direct", decidedBy: "luck" }))).toBe(
			false,
		);
		expect(Value.Check(ToolExposureListSchema, withRow({ name: "a\nb", state: "direct", decidedBy: "pin" }))).toBe(
			false,
		);
		expect(Value.Check(ToolExposureListSchema, { ...list, schema: {} })).toBe(false);
	});

	it("accepts the usage decider with an audit and refuses an audit that is out of range or has unknown fields", () => {
		const audit = { declared: 25, called: 0, used: 0, refused: 0, rate: 0, reason: "unused", bytesSaved: 812 };
		const withRow = (row: unknown) => ({ ...list, groups: [{ ...list.groups[0], tools: [row] }] });
		const row = { name: "archive", state: "deferred", decidedBy: "usage", audit };
		expect(Value.Check(ToolExposureListSchema, withRow(row))).toBe(true);
		for (const bad of [
			{ ...audit, rate: 2 },
			{ ...audit, reason: "idle" },
			{ ...audit, lastUsed: "today" },
			{ ...audit, x: 1 },
		])
			expect(Value.Check(ToolExposureListSchema, withRow({ ...row, audit: bad }))).toBe(false);
	});

	it("accepts a pin and an unpin of one MCP tool or one deferrable native tool", () => {
		for (const command of [
			{ kind: "mcp", server: "docs", tool: "search", pin: "hidden", scope: "global" },
			{ kind: "mcp", server: "docs", tool: "search", pin: null, scope: "workspace", repoId: "session" },
			{ kind: "native", tool: "archive", pin: "deferred", scope: "global" },
			{ kind: "native", tool: "backlogPlan", pin: null, scope: "global" },
			{ kind: "native", tool: "memory", pin: "direct", scope: "global" },
			{ kind: "native", tool: "notify", pin: "deferred", scope: "global" },
		])
			expect(Value.Check(ToolPinCommandSchema, command), JSON.stringify(command)).toBe(true);
	});

	it("refuses a pattern, a core native tool, hiding a native tool, a path and extra fields", () => {
		for (const command of [
			{ kind: "mcp", server: "docs", tool: "*", pin: "hidden", scope: "global" },
			{ kind: "mcp", server: "docs", tool: "sea*", pin: "direct", scope: "global" },
			{ kind: "mcp", server: "docs", tool: "a\nb", pin: "direct", scope: "global" },
			{ kind: "mcp", tool: "search", pin: "direct", scope: "global" },
			{ kind: "native", tool: "bash", pin: "deferred", scope: "global" },
			{ kind: "native", tool: "archive", pin: "hidden", scope: "global" },
			{ kind: "native", tool: "archive", pin: "direct", scope: "project" },
			{ kind: "native", tool: "archive", pin: "direct", scope: "workspace", repoId: "../etc" },
			{ kind: "native", tool: "archive", pin: "direct", scope: "global", path: "/tmp/settings.json" },
			{ kind: "native", tool: "archive", scope: "global" },
		])
			expect(Value.Check(ToolPinCommandSchema, command), JSON.stringify(command)).toBe(false);
	});

	it("keeps the route under the launch-only admin prefix", () => {
		expect(DAEMON_ROUTES.configTools.startsWith("/api/admin/")).toBe(true);
	});
});
