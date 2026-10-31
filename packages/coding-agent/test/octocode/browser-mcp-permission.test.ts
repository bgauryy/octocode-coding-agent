import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ToolCallEvent } from "../../src/core/extensions/index.ts";
import { Permission } from "../../src/octocode/permission/ask.ts";
import { permissionGate } from "../../src/octocode/permission/gate.ts";
import { browserMcpUrls } from "../../src/octocode/shared/browser-mcp.ts";
import { PERMISSION_ENV } from "../../../common/src/env.ts";
import { browserMcpRequest } from "../../src/octocode/web/browser-mcp.ts";
import { createMcpToolName } from "../../../mcp/src/tool-names.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

/** DNS without the network: example.com is public, everything else fails to resolve. */
const lookup = async (hostname: string) => {
	if (hostname === "example.com") return [{ address: "93.184.215.14" }];
	throw new Error(`ENOTFOUND ${hostname}`);
};

const goto = (url: string) => ({ plan: { steps: [{ op: "goto", url }] }, connection: { port: 9222 } });

describe("browser MCP navigation targets", () => {
	it("collects every address a call asks Chrome to open, and nothing for other tools", () => {
		expect(
			browserMcpUrls("mcp__browser__run", {
				connection: { newTab: "https://a.test/" },
				plan: {
					steps: [
						{ op: "goto", url: "https://b.test/" },
						{ op: "act", action: "click", selector: "a" },
						{ op: "cdp", method: "Page.navigate", params: { url: "https://c.test/" } },
						{ op: "cdp", method: "Runtime.evaluate", params: { url: "https://ignored.test/" } },
					],
				},
			}),
		).toEqual(["https://a.test/", "https://b.test/", "https://c.test/"]);
		expect(browserMcpUrls("mcp__browser__open", { url: "https://d.test/" })).toEqual(["https://d.test/"]);
		expect(browserMcpUrls("mcp__browser__step", { step: { op: "goto", url: "https://e.test/" } })).toEqual([
			"https://e.test/",
		]);
		expect(
			browserMcpUrls("mcp__browser__cdp", { method: "Target.createTarget", params: { url: "https://f.test/" } }),
		).toEqual(["https://f.test/"]);
		expect(browserMcpUrls("mcp__other__run", goto("https://b.test/"))).toEqual([]);
	});

	it("asks net.private for private, unresolved and non-web targets, and browser.control for code and cookies", async () => {
		expect(await browserMcpRequest("mcp__browser__run", goto("https://example.com/"), lookup)).toBeUndefined();
		expect(await browserMcpRequest("mcp__browser__run", goto("about:blank"), lookup)).toBeUndefined();
		expect(await browserMcpRequest("mcp__browser__run", goto("http://127.0.0.1:3000/"), lookup)).toMatchObject({
			action: "net.private",
			grant: { key: "127.0.0.1:3000" },
			what: [expect.stringContaining("a local or private network address")],
		});
		expect(await browserMcpRequest("mcp__browser__open", { url: "https://intranet.corp/" }, lookup)).toMatchObject({
			action: "net.private",
			grant: { key: "intranet.corp:443" },
			what: [expect.stringContaining("does not resolve here")],
		});
		const file = await browserMcpRequest("mcp__browser__run", goto("file:///etc/passwd"), lookup);
		expect(file).toMatchObject({ action: "net.private", what: [expect.stringContaining("not a web address")] });
		expect(file?.grant).toBeUndefined();
		for (const tool of ["script", "cookies", "api-replay"])
			expect((await browserMcpRequest(createMcpToolName("browser", tool), { args: [] }, lookup))?.action).toBe(
				"browser.control",
			);
		expect(
			await browserMcpRequest("browser", { action: "navigate", url: "http://127.0.0.1/" }, lookup),
		).toBeUndefined();
	});

	it("lets public navigation run in workspace mode and asks before a private one", async () => {
		const cwd = tmp();
		fs.mkdirSync(path.join(cwd, ".git"));
		const fake = fakeHost();
		const permission = new Permission({ api: fake.api, env: { [PERMISSION_ENV]: "workspace" }, isSubagent: false });
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
			network: (toolName, input) => browserMcpRequest(toolName, input, lookup),
		});
		const call = (input: Record<string, unknown>) =>
			({ type: "tool_call", toolCallId: "t1", toolName: "mcp__browser__run", input }) as ToolCallEvent;
		expect(await gate(call(goto("https://example.com/")), ctx)).toBeUndefined();
		expect(asked).toEqual([]);
		const refused = await gate(call(goto("http://127.0.0.1:3000/")), ctx);
		expect(asked).toHaveLength(1);
		expect(refused?.block).toBe(true);
		const replay = await gate(
			{
				...call({ args: ["--url", "http://127.0.0.1:3000/", "--method", "POST"] }),
				toolName: createMcpToolName("browser", "api-replay"),
			},
			ctx,
		);
		expect(asked).toHaveLength(2);
		expect(asked[1]).toContain("Replay a captured request?");
		expect(replay?.block).toBe(true);
	});
});
