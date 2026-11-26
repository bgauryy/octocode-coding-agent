import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Permission } from "../../src/octocode/permission/ask.ts";
import { desktopMcpRequest } from "../../src/octocode/permission/desktop-mcp.ts";
import { permissionGate } from "../../src/octocode/permission/gate.ts";
import { ALLOW_ONCE } from "../../src/octocode/permission/ask/text.ts";
import { AGENT_SCRATCH_ENV, PERMISSION_ENV, READ_ONLY_ENV, SUBAGENT_ENV } from "@octocodeai/octocode-common/env";
import { installMcpHost } from "../../../mcp/src/host.ts";
import { defineDesktopTool } from "../../../mcp/src/presets/desktop/tools.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

beforeEach(() =>
	installMcpHost({
		render: { timedTool: (tool: unknown) => tool } as never,
		output: { textMaxChars: 50_000, capResultText: (text: string) => text } as never,
	}),
);
afterEach(() => installMcpHost({ render: undefined, output: undefined }));

/** A workspace whose paths are canonical, so the path a user is shown can be compared exactly. */
function workspace(): string {
	const cwd = fs.realpathSync(tmp());
	fs.mkdirSync(path.join(cwd, ".git"));
	return cwd;
}

/** The real desktop tool, its server call recorded: the preset's `prepareCall` runs inside `execute`. */
function desktopTool(sent: Array<Record<string, unknown>>) {
	return defineDesktopTool({
		server: "desktop",
		tool: { name: "get_window_state", description: "Read a window.", inputSchema: { type: "object" } },
		name: "mcp__desktop__get_window_state",
		exposure: "direct",
		namespace: { name: "mcp__desktop" },
		timeoutMs: 1000,
		getClient: async () => ({
			callTool: vi.fn(async (_name: string, args: Record<string, unknown>) => {
				sent.push(args);
				return { content: [{ type: "text" as const, text: "Found 1 window(s)." }] };
			}),
		}),
	} as never);
}

/** The gate of a session in `mode`, the way tool-gates.ts wires it; a call then runs the tool only when the gate lets it pass. */
async function run(mode: string, cwd: string, input: Record<string, unknown>, selects: string[] = []) {
	const permission = new Permission({ api: fakeHost().api, env: { [PERMISSION_ENV]: mode }, isSubagent: false });
	const ctx = fakeCtx({ cwd, hasUI: true, ui: { selects } });
	permission.start(ctx);
	const gate = permissionGate({
		permission,
		provenance: { check: () => undefined },
		powershell: async () => false,
		network: (toolName, args, where) => desktopMcpRequest(toolName, args, where),
	});
	const toolName = "mcp__desktop__get_window_state";
	const verdict = await gate({ type: "tool_call", toolCallId: "t1", toolName, input }, ctx);
	const sent: Array<Record<string, unknown>> = [];
	const result = verdict?.block ? undefined : await desktopTool(sent).execute("t1", input, undefined, undefined, ctx);
	return { verdict, sent, result };
}

describe("a screenshot_out_file through the gate and the preset's call", () => {
	it("creates the missing folder of an allowed path and sends Driver the absolute path", async () => {
		const cwd = workspace();
		const shots = path.join(cwd, ".octocode", "agent", "temp", "shots");
		const { verdict, sent } = await run(
			"manual",
			cwd,
			{ pid: 1, window_id: 2, screenshot_out_file: ".octocode/agent/temp/shots/a.png" },
			[ALLOW_ONCE],
		);
		expect(verdict).toBeUndefined();
		expect(fs.existsSync(shots)).toBe(true);
		expect(sent[0]?.screenshot_out_file).toBe(path.join(shots, "a.png"));
	});

	it("creates no folder and makes no call when the gate refuses the path", async () => {
		const cwd = workspace();
		const folder = path.join(cwd, "src", "evidence");
		const { verdict, sent } = await run("manual", cwd, {
			pid: 1,
			window_id: 2,
			screenshot_out_file: folder + "/a.png",
		});
		expect(verdict?.block).toBe(true);
		expect(fs.existsSync(folder)).toBe(false);
		expect(sent).toEqual([]);
	});

	it("never reaches Driver with a missing folder", async () => {
		const cwd = workspace();
		const file = path.join(cwd, ".octocode", "agent", "tmp", "deep", "er", "a.png");
		const { sent, result } = await run("manual", cwd, { pid: 1, window_id: 2, screenshot_out_file: file }, [
			ALLOW_ONCE,
		]);
		expect(sent).toHaveLength(1);
		expect(fs.existsSync(path.dirname(sent[0]?.screenshot_out_file as string))).toBe(true);
		expect(JSON.stringify(result)).not.toContain("px_capture_unavailable");
	});
});

describe("which screenshot_out_file paths ask", () => {
	it("shows the exact canonical path, and asks for MEMORY.md, state and the repository, not for scratch", async () => {
		const cwd = workspace();
		const ask = (file: string) =>
			desktopMcpRequest("mcp__desktop__get_window_state", { screenshot_out_file: file }, cwd);
		const agent = path.join(cwd, ".octocode", "agent");
		for (const file of [path.join(agent, "MEMORY.md"), path.join(agent, "state", "db.png"), path.join(cwd, "a.png")]) {
			const request = await ask(file);
			expect(request?.also, file).toEqual(["file.outside"]);
			expect(request?.what[1], file).toContain(`Saves a screenshot in ${file},`);
		}
		const outside = path.join(fs.realpathSync(tmp()), "a.png");
		expect((await ask(outside))?.what[1]).toBe(`Saves a screenshot in ${outside}, outside the workspace.`);
		for (const file of ["temp/a.png", "tmp/a.png"])
			expect((await ask(path.join(agent, file)))?.also, file).toBeUndefined();
	});
});

describe("a screenshot_out_file in a read-only child", () => {
	afterEach(() => vi.unstubAllEnvs());

	/** The child's scratch folder, with the role env set as the parent sets it. */
	function child(): { cwd: string; scratch: string } {
		const cwd = workspace();
		const scratch = path.join(cwd, ".octocode", "agent", "temp", "agents", "child");
		fs.mkdirSync(scratch, { recursive: true });
		vi.stubEnv(SUBAGENT_ENV, "1");
		vi.stubEnv(READ_ONLY_ENV, "1");
		vi.stubEnv(AGENT_SCRATCH_ENV, scratch);
		return { cwd, scratch };
	}

	it("creates the folder in its scratch folder and calls Driver", async () => {
		const { cwd, scratch } = child();
		const file = path.join(scratch, "shots", "a.png");
		const { sent } = await run("manual", cwd, { pid: 1, window_id: 2, screenshot_out_file: file }, [ALLOW_ONCE]);
		expect(sent).toHaveLength(1);
		expect(sent[0]?.screenshot_out_file).toBe(file);
		expect(fs.existsSync(path.dirname(file))).toBe(true);
		expect(
			(await desktopMcpRequest("mcp__desktop__get_window_state", { screenshot_out_file: file }, cwd))?.also,
		).toBeUndefined();
	});

	it("asks for a repository file and blocks without approval: no folder, no call", async () => {
		const { cwd } = child();
		const folder = path.join(cwd, "src", "evidence");
		const { verdict, sent } = await run("manual", cwd, {
			pid: 1,
			window_id: 2,
			screenshot_out_file: path.join(folder, "a.png"),
		});
		expect(verdict?.block).toBe(true);
		expect(fs.existsSync(folder)).toBe(false);
		expect(sent).toEqual([]);
	});

	it("asks for temp/sessions too", async () => {
		const { cwd } = child();
		const sessions = path.join(cwd, ".octocode", "agent", "temp", "sessions", "s1");
		const { verdict, sent } = await run("manual", cwd, {
			pid: 1,
			window_id: 2,
			screenshot_out_file: path.join(sessions, "a.png"),
		});
		expect(verdict?.block).toBe(true);
		expect(fs.existsSync(sessions)).toBe(false);
		expect(sent).toEqual([]);
	});
});

describe("an empty or unusable screenshot_out_file", () => {
	it("asks nothing for an empty path, as the preset treats it as absent", async () => {
		const request = await desktopMcpRequest("mcp__desktop__get_window_state", { screenshot_out_file: "" }, workspace());
		expect(request?.also).toBeUndefined();
	});

	it("names the folder and the code when it cannot be created", async () => {
		const cwd = workspace();
		const blocker = path.join(cwd, ".octocode", "agent", "temp", "file");
		fs.mkdirSync(path.dirname(blocker), { recursive: true });
		fs.writeFileSync(blocker, "x");
		const folder = path.join(blocker, "sub");
		await expect(
			run("manual", cwd, { pid: 1, window_id: 2, screenshot_out_file: path.join(folder, "a.png") }, [ALLOW_ONCE]),
		).rejects.toThrow(`cannot create the screenshot folder ${folder}: ENOTDIR`);
	});
});

describe("a screenshot_out_file through a symlink", () => {
	it("asks for the link's target, and creates no folder behind it when refused", async () => {
		const cwd = workspace();
		const away = fs.realpathSync(tmp());
		const temp = path.join(cwd, ".octocode", "agent", "temp");
		fs.mkdirSync(temp, { recursive: true });
		fs.symlinkSync(away, path.join(temp, "shots"));
		const file = path.join(temp, "shots", "deep", "a.png");
		const request = await desktopMcpRequest("mcp__desktop__get_window_state", { screenshot_out_file: file }, cwd);
		expect(request?.also).toEqual(["file.outside"]);
		expect(request?.what[1]).toBe(`Saves a screenshot in ${path.join(away, "deep", "a.png")}, outside the workspace.`);
		const { verdict, sent } = await run("manual", cwd, { pid: 1, window_id: 2, screenshot_out_file: file });
		expect(verdict?.block).toBe(true);
		expect(sent).toEqual([]);
		expect(fs.existsSync(path.join(away, "deep"))).toBe(false);
	});

	it("sends Driver the link's target path, the one the gate judged, once approved", async () => {
		const cwd = workspace();
		const away = fs.realpathSync(tmp());
		const temp = path.join(cwd, ".octocode", "agent", "temp");
		fs.mkdirSync(temp, { recursive: true });
		fs.symlinkSync(away, path.join(temp, "shots"));
		const { sent } = await run(
			"manual",
			cwd,
			{ pid: 1, window_id: 2, screenshot_out_file: path.join(temp, "shots", "deep", "a.png") },
			[ALLOW_ONCE],
		);
		expect(sent[0]?.screenshot_out_file).toBe(path.join(away, "deep", "a.png"));
		expect(fs.existsSync(path.join(away, "deep"))).toBe(true);
	});
});
