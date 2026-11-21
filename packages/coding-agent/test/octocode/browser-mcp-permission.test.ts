import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ToolCallEvent } from "../../src/core/features/index.ts";
import { Permission } from "../../src/octocode/permission/ask.ts";
import { permissionGate } from "../../src/octocode/permission/gate.ts";
import { browserMcpUrls } from "@octocodeai/octocode-common/browser-mcp";
import { browserMcpEscalations } from "../../src/octocode/permission/browser-mcp-escalations.ts";
import {
	PERMISSION_ENV,
	PERMISSION_GRANTS_ENV,
	PERMISSION_RELAY_ENV,
	READ_ONLY_ENV,
	SUBAGENT_ENV,
} from "@octocodeai/octocode-common/env";
import { browserMcpRequest, browserMetadataRefusal } from "../../src/octocode/web/browser-mcp.ts";
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
		expect(browserMcpUrls("mcp__browser__group", { action: "open", urls: ["https://e.test/", "about:blank"] })).toEqual(
			["https://e.test/", "about:blank"],
		);
		expect(
			browserMcpUrls("mcp__browser__flow", {
				action: "run",
				name: "extract-links",
				params: { url: "https://g.test/" },
			}),
		).toEqual(["https://g.test/"]);
		expect(browserMcpUrls("mcp__browser__flow", { action: "list", params: { url: "https://h.test/" } })).toEqual([]);
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
		const evaluate = { plan: { steps: [{ op: "evaluate", expression: "1" }] } };
		expect((await browserMcpRequest(createMcpToolName("browser", "run"), evaluate, lookup))?.action).toBe(
			"browser.control",
		);
		expect(
			(await browserMcpRequest(createMcpToolName("browser", "cdp"), { method: "Network.getCookies" }, lookup))?.action,
		).toBe("browser.cookies");
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
		const script = await gate(
			call({ plan: { steps: [{ op: "evaluate", expression: "document.cookie" }] }, connection: { port: 9222 } }),
			ctx,
		);
		expect(asked).toHaveLength(2);
		expect(script?.block).toBe(true);
	});
});

const browserTool = (tool: string) => createMcpToolName("browser", tool);

/** One call per gap: the real profile, another program as Chrome, an outside upload, and cookie or download CDP. */
const GAPS = {
	attach: { tool: "open", input: { port: 9222, attach: true, acknowledge: true } },
	chromePath: { tool: "open", input: { launch: { chromePath: "/tmp/evil" } } },
	upload: {
		tool: "run",
		input: { plan: { steps: [{ op: "act", action: "upload", selector: "input", value: "/etc/hosts" }] } },
	},
	cookies: { tool: "cdp", input: { method: "Network.getAllCookies" } },
	downloads: {
		tool: "run",
		input: {
			plan: {
				steps: [
					{ op: "cdp", method: "Browser.setDownloadBehavior", params: { behavior: "allow", downloadPath: "/tmp" } },
				],
			},
		},
	},
} as const;

describe("browser MCP calls that leave the isolated browser", () => {
	it("finds attach, another program, cookie and download CDP, page scripts and uploads wherever the package reads them", () => {
		const found = (tool: string, input: Record<string, unknown>) =>
			browserMcpEscalations(browserTool(tool), input).map(({ kind, path }) => `${kind}${path ? `:${path}` : ""}`);
		expect(found("open", { attach: true, port: 9222, acknowledge: true })).toEqual(["control"]);
		expect(found("open", { launch: { chromePath: "/x", windowSize: "800x600" } })).toEqual(["control"]);
		expect(found("open", { headless: true, port: 9333, launch: { windowSize: "800x600" } })).toEqual([]);
		expect(found("run", { plan: { steps: [{ op: "cdp", method: "Storage.getCookies" }] } })).toEqual(["cookies"]);
		expect(found("run", { plan: { steps: [{ op: "evaluate", expression: "1" }] } })).toEqual(["control"]);
		expect(found("flow", { action: "run", name: "handle-dialog", params: { trigger: "alert(1)" } })).toEqual([
			"control",
		]);
		expect(
			found("flow", { action: "save", name: "x", plan: { steps: [{ op: "evaluate", expression: "1" }] } }),
		).toEqual(["control"]); // Saved, it runs unseen later.
		expect(found("cdp", { method: "Target.sendMessageToTarget", params: { message: "{}" } })).toEqual([
			"cookies",
			"control",
		]);
		expect(found("cdp", { method: "Page.setDownloadBehavior", params: { behavior: "deny" } })).toEqual(["cookies"]);
		expect(found("cdp", { method: "Runtime.evaluate", params: { expression: "1" } })).toEqual(["cookies"]);
		expect(found("cdp", { method: "DOM.setFileInputFiles", params: { files: ["/a", "b"] } })).toEqual([
			"cookies",
			"upload:/a",
			"upload:b",
		]);
		expect(found("run", { plan: { steps: [{ op: "act", action: "upload", value: "/a | /b" }] } })).toEqual([
			"upload:/a",
			"upload:/b",
		]);
		expect(browserMcpEscalations("mcp__other__open", { launch: { chromePath: "/x" } })).toEqual([]);
	});

	it("asks in workspace mode for each gap, with the existing classes, and lets workspace uploads run", async () => {
		const cwd = fs.realpathSync(tmp());
		fs.mkdirSync(path.join(cwd, ".git"));
		fs.writeFileSync(path.join(cwd, "fixture.txt"), "x");
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
			network: (toolName, input, at) => browserMcpRequest(toolName, input, lookup, at),
		});
		const call = (tool: string, input: Record<string, unknown>) =>
			gate({ type: "tool_call", toolCallId: `t-${tool}`, toolName: browserTool(tool), input }, ctx);
		for (const [gap, { tool, input }] of Object.entries(GAPS)) {
			const before = asked.length;
			expect((await call(tool, input))?.block, gap).toBe(true);
			expect(asked.length, gap).toBe(before + 1);
		}
		expect((await browserMcpRequest(browserTool("cdp"), GAPS.cookies.input, lookup, cwd))?.action).toBe(
			"browser.cookies",
		);
		for (const gap of ["attach", "chromePath", "downloads"] as const)
			expect((await browserMcpRequest(browserTool(GAPS[gap].tool), GAPS[gap].input, lookup, cwd))?.action).toBe(
				"browser.control",
			);
		expect(await browserMcpRequest(browserTool("run"), GAPS.upload.input, lookup, cwd)).toMatchObject({
			action: "upload.outside",
			what: [fs.realpathSync("/etc/hosts")],
		});
		// Several classes in one call: one ask naming them all, and no per-host grant.
		const both = await browserMcpRequest(
			browserTool("run"),
			{ plan: { steps: [{ op: "goto", url: "http://127.0.0.1:3000/" }, ...GAPS.upload.input.plan.steps] } },
			lookup,
			cwd,
		);
		expect(both).toMatchObject({ action: "upload.outside", also: ["net.private"] });
		expect(both?.grant).toBeUndefined();
		const before = asked.length;
		const inside = { plan: { steps: [{ op: "act", action: "upload", selector: "input", value: "fixture.txt" }] } };
		expect(await call("run", inside)).toBeUndefined();
		expect(asked.length).toBe(before);
	});

	it("refuses each gap in a read-only role that holds browser.control, and still runs the granted tools", async () => {
		const cwd = fs.realpathSync(tmp());
		fs.mkdirSync(path.join(cwd, ".git"));
		const env = {
			[SUBAGENT_ENV]: "1",
			[READ_ONLY_ENV]: "1",
			[PERMISSION_ENV]: "workspace",
			[PERMISSION_GRANTS_ENV]: "browser.control",
		};
		const fake = fakeHost();
		const permission = new Permission({ api: fake.api, env, isSubagent: true });
		const ctx = fakeCtx({ cwd, hasUI: false });
		permission.start(ctx);
		const gate = permissionGate({
			permission,
			provenance: { check: () => undefined },
			powershell: async () => false,
			network: (toolName, input, at) => browserMcpRequest(toolName, input, lookup, at),
			env,
		});
		const call = (tool: string, input: Record<string, unknown>) =>
			gate({ type: "tool_call", toolCallId: `r-${tool}`, toolName: browserTool(tool), input }, ctx);
		for (const [gap, { tool, input }] of Object.entries(GAPS))
			if (gap !== "cookies") expect((await call(tool, input))?.reason, gap).toMatch(/read-only role/);
		expect((await call("run", { plan: { steps: [{ op: "evaluate", expression: "1" }] } }))?.block).toBe(true);
		expect(await call("open", { headless: true })).toBeUndefined();
	});

	describe("cookie access in a read-only role", () => {
		const child = (selects: Array<string | undefined>) => {
			const cwd = fs.realpathSync(tmp());
			fs.mkdirSync(path.join(cwd, ".git"));
			const env = {
				[SUBAGENT_ENV]: "1",
				[READ_ONLY_ENV]: "1",
				[PERMISSION_ENV]: "workspace",
				[PERMISSION_GRANTS_ENV]: "browser.control",
				[PERMISSION_RELAY_ENV]: "1",
			};
			const permission = new Permission({ api: fakeHost().api, env, isSubagent: true });
			const ctx = fakeCtx({ cwd, hasUI: true, ui: { selects } });
			permission.start(ctx);
			const asked: string[][] = [];
			const select = ctx.ui.select;
			ctx.ui.select = async (title: string, choices: string[]) => {
				asked.push(choices);
				return select(title, choices);
			};
			const gate = permissionGate({
				permission,
				provenance: { check: () => undefined },
				powershell: async () => false,
				network: (toolName, input, at) => browserMcpRequest(toolName, input, lookup, at),
				env,
			});
			let id = 0;
			const call = (tool: string, input: Record<string, unknown>) =>
				gate({ type: "tool_call", toolCallId: `c-${(id += 1)}`, toolName: browserTool(tool), input }, ctx);
			return { asked, call };
		};
		const KIND = "Allow all browser cookie access for this session";

		it("asks the user for cookie CDP instead of refusing, and remembers an approval for the session", async () => {
			const { asked, call } = child([KIND]);
			expect(await call("cdp", { method: "Network.getCookies" })).toBeUndefined();
			expect(asked).toHaveLength(1);
			expect(asked[0]).toContain(KIND);
			expect(await call("cdp", { method: "Network.getAllCookies" })).toBeUndefined();
			expect(await call("run", { plan: { steps: [{ op: "cdp", method: "Storage.getCookies" }] } })).toBeUndefined();
			expect(asked).toHaveLength(1);
		});

		it("asks again after a one-time answer, and blocks a denial", async () => {
			const { asked, call } = child(["Allow once", "Deny"]);
			expect(await call("cdp", { method: "Network.getCookies" })).toBeUndefined();
			expect((await call("cdp", { method: "Network.getCookies" }))?.block).toBe(true);
			expect(asked).toHaveLength(2);
		});

		it("does not offer a session answer when the call also needs another class", async () => {
			const { asked, call } = child(["Allow once"]);
			await call("run", {
				plan: {
					steps: [
						{ op: "goto", url: "http://127.0.0.1:3000/" },
						{ op: "cdp", method: "Network.getCookies" },
					],
				},
			});
			expect(asked[0]).not.toContain(KIND);
		});
	});
});

describe("browser and cloud metadata addresses", () => {
	const tool = createMcpToolName("browser", "browser_action");
	it("refuses opening one, also through a name that resolves to it, and leaves other pages to the mode", async () => {
		const resolving = async (hostname: string) => {
			if (hostname === "metadata.internal") return [{ address: "169.254.169.254" }];
			return lookup(hostname);
		};
		expect(await browserMetadataRefusal(tool, goto("http://169.254.169.254/latest"), resolving)).toMatch(
			/cloud metadata/,
		);
		expect(await browserMetadataRefusal(tool, goto("http://metadata.internal/"), resolving)).toMatch(/cloud metadata/);
		expect(await browserMetadataRefusal(tool, goto("https://example.com/"), resolving)).toBeUndefined();
		expect(await browserMetadataRefusal(tool, goto("http://10.0.0.1/"), resolving)).toBeUndefined();
		expect(await browserMetadataRefusal("bash", { command: "curl 169.254.169.254" }, resolving)).toBeUndefined();
	});
});
