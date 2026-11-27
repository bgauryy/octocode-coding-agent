import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TEST_WORKER_TITLE } from "../helpers/worker-title.ts";
import type { ToolCallEvent } from "../../src/core/features/index.ts";
import { Permission } from "../../src/octocode/permission/ask.ts";
import { desktopMcpRequest, desktopRefusal } from "../../src/octocode/permission/desktop-mcp.ts";
import { permissionGate } from "../../src/octocode/permission/gate.ts";
import { readOnlyRoleRefusal } from "../../src/octocode/permission/read-only-role.ts";
import { setMcpReadOnlyTools } from "../../src/octocode/permission/mcp-reads.ts";
import {
	PERMISSION_ENV,
	PERMISSION_GRANTS_ENV,
	PERMISSION_RELAY_ENV,
	READ_ONLY_ENV,
	SUBAGENT_ENV,
} from "@octocodeai/octocode-common/env";
import { SPAWN_GRANTABLE } from "../../src/octocode/permission/mode.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

beforeEach(() => setMcpReadOnlyTools(() => new Set(["mcp__desktop__screenshot"])));
afterEach(() => setMcpReadOnlyTools(() => new Set()));

/** DNS without the network: example.com is public, everything else fails to resolve. */
const lookup = async (hostname: string) => {
	if (hostname === "example.com") return [{ address: "93.184.215.14" }];
	throw new Error(`ENOTFOUND ${hostname}`);
};

describe("desktop MCP calls", () => {
	it("are a desktop.control ask unless the server entry declares the tool read-only", async () => {
		expect(await desktopMcpRequest("mcp__desktop__click", { x: 1, y: 2 })).toMatchObject({
			action: "desktop.control",
			title: "Take control of the desktop?",
			what: [expect.stringContaining("mcp__desktop__click")],
		});
		expect(await desktopMcpRequest("mcp__desktop__screenshot", {})).toBeUndefined();
		expect(await desktopMcpRequest("mcp__browser__run", {})).toBeUndefined();
		expect(await desktopMcpRequest("mcp__desktop_other__click", {})).toBeUndefined();
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

describe("the browser tools of the desktop server reach beyond the desktop", () => {
	const ask = (tool: string, input: Record<string, unknown>) =>
		desktopMcpRequest(`mcp__desktop__${tool}`, input, tmp(), lookup);

	it("asks net.private for a private, local or unresolved page, and nothing more for a public one", async () => {
		expect((await ask("browser_navigate", { url: "https://example.com/" }))?.also).toBeUndefined();
		expect((await ask("browser_navigate", { url: "about:blank" }))?.also).toBeUndefined();
		for (const url of ["http://127.0.0.1:3000/", "http://intranet.corp/", "http://localhost:8080/"])
			expect(await ask("browser_navigate", { url }), url).toMatchObject({
				action: "desktop.control",
				also: ["net.private"],
			});
		expect(await ask("launch_app", { bundle_id: "com.google.Chrome", urls: ["http://10.0.0.5/admin"] })).toMatchObject({
			also: ["net.private"],
		});
	});

	it("refuses a cloud metadata address and a browser launched with debugging or profile flags, in every mode", async () => {
		expect(await desktopRefusal("mcp__desktop__browser_navigate", { url: "http://169.254.169.254/latest" })).toMatch(
			/metadata/i,
		);
		for (const argument of ["--remote-debugging-port=9222", "--user-data-dir=/tmp/x", "--disable-web-security"])
			expect(
				await desktopRefusal("mcp__desktop__launch_app", {
					bundle_id: "com.google.Chrome",
					additional_arguments: [argument],
				}),
				argument,
			).toMatch(/refused/);
		expect(
			await desktopRefusal("mcp__desktop__browser_navigate", { url: "https://example.com/" }, lookup),
		).toBeUndefined();
		expect(await desktopRefusal("mcp__browser__open", { url: "http://169.254.169.254/" })).toBeUndefined();
	});

	it("asks file.outside for a screenshot_out_file outside the workspace or the read-only role's folders, on any tool", async () => {
		const cwd = fs.realpathSync(tmp());
		fs.mkdirSync(path.join(cwd, ".git"));
		const request = (tool: string, file: string) =>
			desktopMcpRequest(`mcp__desktop__${tool}`, { pid: 1, screenshot_out_file: file }, cwd, lookup);
		const scratch = path.join(cwd, ".octocode", "agent", "temp", "shots", "a.png");
		expect((await request("get_window_state", scratch))?.also).toBeUndefined();
		const inRepo = path.join(cwd, "src", "a.png");
		const repo = await request("screenshot", inRepo);
		expect(repo).toMatchObject({ action: "file.outside" });
		expect(repo?.what[1]).toMatch(
			new RegExp(`^Saves a screenshot in ${inRepo.replace(/\W/g, "\\$&")}, in the repository`),
		);
		const outside = path.join(fs.realpathSync(tmp()), "a.png");
		const away = await request("get_window_state", outside);
		expect(away?.also).toEqual(["file.outside"]);
		expect(away?.what[1]).toBe(`Saves a screenshot in ${outside}, outside the workspace.`);
		const escape = await request("get_window_state", "../escape.png");
		expect(escape?.what[1]).toBe(
			`Saves a screenshot in ${path.join(path.dirname(cwd), "escape.png")}, outside the workspace.`,
		);
	});

	it("asks upload.outside for a file from outside the workspace, file.outside for a download saved outside it", async () => {
		const cwd = tmp();
		fs.mkdirSync(path.join(cwd, ".git"));
		const inside = path.join(cwd, "report.txt");
		const outside = path.join(tmp(), "secrets.txt");
		const request = (tool: string, input: Record<string, unknown>) =>
			desktopMcpRequest(`mcp__desktop__${tool}`, input, cwd, lookup);
		expect((await request("browser_set_input_files", { files: [inside], ref: "r1" }))?.also).toEqual([
			"desktop.sensitive",
		]);
		expect(await request("browser_set_input_files", { files: [inside, outside], ref: "r1" })).toMatchObject({
			also: ["upload.outside", "desktop.sensitive"],
		});
		expect((await request("browser_download", { destination_root: path.join(cwd, "dl"), ref: "r1" }))?.also).toEqual([
			"desktop.sensitive",
		]);
		expect(await request("browser_download", { destination_root: path.dirname(outside), ref: "r1" })).toMatchObject({
			also: ["file.outside", "desktop.sensitive"],
		});
	});

	it("asks browser.cookies to attach to the user's own profile, which a spawn grant never answers", async () => {
		expect(
			await ask("browser_prepare", { strategy: { kind: "existing_profile" }, pid: 1, window_id: 2 }),
		).toMatchObject({ also: ["browser.cookies"] });
		expect(
			(await ask("browser_prepare", { allow_launch: true, profile: { mode: "isolated_new" } }))?.also,
		).toBeUndefined();
		expect(SPAWN_GRANTABLE.has("browser.cookies")).toBe(false);
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

const SENSITIVE = [
	"clipboard_read",
	"clipboard_write",
	"kill_app",
	"replay_trajectory",
	"escalate_session",
	"start_recording",
	"browser_download",
	"browser_set_input_files",
];

describe("sensitive desktop tools", () => {
	it.each(SENSITIVE)("%s asks desktop.sensitive, which no spawn grant answers", async (tool) => {
		const request = await desktopMcpRequest(`mcp__desktop__${tool}`, {}, tmp(), lookup);
		expect(request?.action).toBe("desktop.control");
		expect(request?.also).toContain("desktop.sensitive");
		expect(SPAWN_GRANTABLE.has("desktop.sensitive")).toBe(false);
	});

	it("leaves the ordinary tools to desktop.control alone", async () => {
		expect((await desktopMcpRequest("mcp__desktop__click", { x: 1, y: 2 }))?.also).toBeUndefined();
	});

	it("asks in an approved child on every call, though desktop.control is granted", async () => {
		const cwd = fs.realpathSync(tmp());
		fs.mkdirSync(path.join(cwd, ".git"));
		const env = {
			[SUBAGENT_ENV]: "1",
			[PERMISSION_ENV]: "workspace",
			[PERMISSION_GRANTS_ENV]: "desktop.control",
			[PERMISSION_RELAY_ENV]: "1",
		};
		const permission = new Permission({ api: fakeHost().api, env, isSubagent: true });
		const ctx = fakeCtx({ cwd, hasUI: true, ui: { selects: [] } });
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
			network: (toolName, input) => desktopMcpRequest(toolName, input, cwd, lookup),
			env,
		});
		let id = 0;
		const call = (tool: string) =>
			gate({ type: "tool_call", toolCallId: `s-${(id += 1)}`, toolName: `mcp__desktop__${tool}`, input: {} }, ctx);
		expect(await call("click")).toBeUndefined();
		expect(asked).toHaveLength(0);
		await call("clipboard_read");
		await call("clipboard_read");
		expect(asked).toHaveLength(2);
	});
});

describe("apps no mode lets a desktop call target", () => {
	const none = async (): Promise<string | undefined> => undefined;
	const refusal = (tool: string, input: Record<string, unknown>, resolve = none) =>
		desktopRefusal(`mcp__desktop__${tool}`, input, lookup, resolve);

	it.each([
		["Terminal", { name: "Terminal" }],
		["Cursor", { name: "cursor" }],
		["Visual Studio Code", { name: "Visual Studio Code.app" }],
		["com.microsoft.VSCode", { bundle_id: "com.microsoft.VSCode" }],
		["com.googlecode.iterm2", { bundle_id: "com.googlecode.iterm2" }],
		["PyCharm CE", { name: "PyCharm CE" }],
		["com.jetbrains.intellij", { bundle_id: "com.jetbrains.intellij" }],
		["1Password 7", { name: "1Password 7" }],
		["Keychain Access", { name: "Keychain Access" }],
	])("refuses a launch of %s, naming it and every mode", async (named, input) => {
		const text = await refusal("launch_app", input);
		expect(text).toMatch(/refused in every mode/);
		expect(text?.toLowerCase()).toContain(named.toLowerCase());
	});

	it("refuses a pid that resolves to a denylisted app, and not one that is unknown or another app", async () => {
		expect(await refusal("click", { pid: 42 }, async () => "Terminal.app")).toMatch(/Terminal.*every mode/);
		expect(await refusal("get_window_state", { pid: 42 }, async () => "Cursor.app")).toMatch(/Cursor/);
		expect(await refusal("click", { pid: 42 }, none)).toBeUndefined();
		expect(await refusal("click", { pid: 42 }, async () => "Calculator.app")).toBeUndefined();
	});

	it("does not refuse Calculator, nor a name that only contains an app's name", async () => {
		expect(await refusal("launch_app", { name: "Calculator", bundle_id: "com.apple.calculator" })).toBeUndefined();
		expect(await refusal("launch_app", { name: "Terminal Notes" })).toBeUndefined();
		expect(await refusal("click", { x: 1, y: 2 })).toBeUndefined();
	});

	it("resolves a real pid to its app with ps, and leaves an unknown pid alone", async () => {
		const { psApp } = await import("../../src/octocode/permission/desktop-apps.ts");
		expect(await psApp(2_000_000_000)).toBeUndefined();
		// ps reports this worker by the fixed title the test setup gives it (`test/helpers/worker-title.ts`).
		expect(await psApp(process.pid)).toBe(TEST_WORKER_TITLE);
	});
});

describe("the user can lift the default app denylist for an app, in their own environment only", () => {
	it("allows an app named in OCTOCODE_DESKTOP_ALLOW_APPS and still refuses the others", async () => {
		const { deniedAppRefusal } = await import("../../src/octocode/permission/desktop-apps.ts");
		expect(deniedAppRefusal("Cursor", {})).toMatch(/refused in every mode/);
		expect(deniedAppRefusal("Cursor", { OCTOCODE_DESKTOP_ALLOW_APPS: "cursor, Zed" })).toBeUndefined();
		expect(deniedAppRefusal("Zed.app", { OCTOCODE_DESKTOP_ALLOW_APPS: "cursor, Zed" })).toBeUndefined();
		expect(deniedAppRefusal("Terminal", { OCTOCODE_DESKTOP_ALLOW_APPS: "cursor, Zed" })).toMatch(/terminal/);
	});
});
