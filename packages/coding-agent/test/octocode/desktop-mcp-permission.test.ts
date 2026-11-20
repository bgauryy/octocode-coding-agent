import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ToolCallEvent } from "../../src/core/features/index.ts";
import { Permission } from "../../src/octocode/permission/ask.ts";
import { desktopMcpRequest } from "../../src/octocode/permission/desktop-mcp.ts";
import { permissionGate } from "../../src/octocode/permission/gate.ts";
import { readOnlyRoleRefusal } from "../../src/octocode/permission/read-only-role.ts";
import { setMcpReadOnlyTools } from "../../src/octocode/permission/mcp-reads.ts";
import { PERMISSION_ENV, READ_ONLY_ENV, SUBAGENT_ENV } from "@octocodeai/octocode-common/env";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

beforeEach(() => setMcpReadOnlyTools(() => new Set(["mcp__desktop__screenshot"])));
afterEach(() => setMcpReadOnlyTools(() => new Set()));

describe("desktop MCP calls", () => {
	it("are a desktop.control ask unless the server entry declares the tool read-only", () => {
		expect(desktopMcpRequest("mcp__desktop__click", { x: 1, y: 2 })).toMatchObject({
			action: "desktop.control",
			title: "Take control of the desktop?",
			what: [expect.stringContaining("mcp__desktop__click")],
		});
		expect(desktopMcpRequest("mcp__desktop__screenshot", {})).toBeUndefined();
		expect(desktopMcpRequest("mcp__browser__run", {})).toBeUndefined();
		expect(desktopMcpRequest("mcp__desktop_other__click", {})).toBeUndefined();
	});

	it.each(["manual", "workspace", "full"])("ask in %s mode, and the answer decides", async (mode) => {
		const cwd = tmp();
		fs.mkdirSync(path.join(cwd, ".git"));
		const fake = fakeHost();
		const permission = new Permission({ api: fake.api, env: { [PERMISSION_ENV]: mode }, isSubagent: false });
		const ctx = fakeCtx({ cwd, hasUI: true, ui: { selects: [] } });
		permission.start(ctx);
		const asked: string[] = [];
		const select = ctx.ui.select;
		ctx.ui.select = async (title: string, choices: string[]) => {
			asked.push(title);
			return select(title, choices);
		};
		const gate = permissionGate({
			permission,
			provenance: { check: () => undefined },
			powershell: async () => false,
			network: async (toolName, input) => desktopMcpRequest(toolName, input),
		});
		const call = (toolName: string) => ({ type: "tool_call", toolCallId: "t1", toolName, input: {} }) as ToolCallEvent;
		const refused = await gate(call("mcp__desktop__click"), ctx);
		expect(asked).toHaveLength(1);
		expect(asked[0]).toMatch(/desktop/i);
		expect(refused?.block).toBe(true);
	});
});

describe("a read-only desktop child", () => {
	const env = { [SUBAGENT_ENV]: "1", [READ_ONLY_ENV]: "1" };

	it("may call desktop tools, because desktop.control decides them, and still cannot change the repository", () => {
		const cwd = tmp();
		expect(readOnlyRoleRefusal({ toolName: "mcp__desktop__click", input: {} }, cwd, env)).toBeUndefined();
		expect(readOnlyRoleRefusal({ toolName: "mcp__other__click", input: {} }, cwd, env)).toMatch(/read-only/i);
		expect(readOnlyRoleRefusal({ toolName: "bash", input: { command: "rm -rf src" } }, cwd, env)).toMatch(/read-only/i);
	});
});
