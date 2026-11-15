import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ToolCallEvent } from "../../src/core/features/index.ts";
import { Permission } from "../../src/octocode/permission/ask.ts";
import { permissionGate } from "../../src/octocode/permission/gate.ts";
import { browserMcpUrls } from "../../../common/src/browser-mcp.ts";
import { browserMcpEscalations } from "../../src/octocode/permission/browser-mcp-escalations.ts";
import {
	PERMISSION_ENV,
	PERMISSION_GRANTS_ENV,
	PERMISSION_RELAY_ENV,
	READ_ONLY_ENV,
	SUBAGENT_ENV,
} from "../../../common/src/env.ts";
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
		for (const tool of ["script", "api-replay"])
			expect((await browserMcpRequest(createMcpToolName("browser", tool), { args: [] }, lookup))?.action).toBe(
				"browser.control",
			);
		expect((await browserMcpRequest(createMcpToolName("browser", "cookies"), { args: [] }, lookup))?.action).toBe(
			"browser.cookies",
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

const browserTool = (tool: string) => createMcpToolName("browser", tool);

/** One call per gap: the real profile, another program as Chrome, an outside upload, and cookie or download CDP. */
const GAPS = {
	profile: { tool: "open", input: { args: ["--profile", "Default"] } },
	chromePath: { tool: "open", input: { args: ["--chromePath=/tmp/evil"] } },
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
	it("finds launcher flags, cookie and download CDP, and uploads wherever the package reads them", () => {
		const found = (tool: string, input: Record<string, unknown>) =>
			browserMcpEscalations(browserTool(tool), input).map(({ kind, path }) => `${kind}${path ? `:${path}` : ""}`);
		expect(found("open", { args: ["--profile", "Work", "--CHROMEPATH", "/x"] })).toEqual(["control", "control"]);
		expect(found("open", { args: ["--headless", "--port", "9333"] })).toEqual([]);
		expect(found("cookies", { args: ["--chrome-path", "/x"] })).toEqual(["control"]);
		expect(found("step", { step: { op: "cdp", method: "Storage.getCookies" } })).toEqual(["cookies"]);
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
		expect(found("step", { step: { op: "act", action: "upload", value: "/a | /b" } })).toEqual([
			"upload:/a",
			"upload:/b",
		]);
		expect(
			found("check", { recipe: "dom-operations-check", options: { DOM_ACTION: "upload", DOM_VALUE: "/c" } }),
		).toEqual(["upload:/c"]);
		expect(
			found("check", {
				recipe: "dom-operations-check",
				options: { DOM_STEPS: JSON.stringify([{ action: "upload", value: "/d" }]) },
			}),
		).toEqual(["upload:/d"]);
		expect(browserMcpEscalations("mcp__other__open", { args: ["--profile"] })).toEqual([]);
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
		for (const gap of ["profile", "chromePath", "downloads"] as const)
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
		expect((await call("script", { args: ["probe.mjs"] }))?.block).toBe(true);
		expect(await call("open", { args: ["--headless"] })).toBeUndefined();
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
			expect(await call("cookies", { args: [] })).toBeUndefined();
			expect(asked).toHaveLength(1);
		});

		it("asks again after a one-time answer, and blocks a denial", async () => {
			const { asked, call } = child(["Allow once", "Deny"]);
			expect(await call("cdp", { method: "Network.getCookies" })).toBeUndefined();
			expect((await call("cdp", { method: "Network.getCookies" }))?.block).toBe(true);
			expect(asked).toHaveLength(2);
		});

		it("asks for the cookies tool the same way, though the profile declares browser.control", async () => {
			const { asked, call } = child([KIND]);
			expect(await call("cookies", { args: [] })).toBeUndefined();
			expect(asked).toHaveLength(1);
			expect(await call("cdp", { method: "Storage.getCookies" })).toBeUndefined();
			expect(asked).toHaveLength(1);
		});

		it("does not offer a session answer when the call also needs another class", async () => {
			const { asked, call } = child(["Allow once"]);
			await call("cookies", { args: [], url: "http://127.0.0.1:3000/" });
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
