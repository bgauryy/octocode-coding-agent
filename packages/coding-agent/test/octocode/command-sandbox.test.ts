import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyCommandSandboxSetting as applySetting } from "../../src/octocode/permission/sandbox/apply.ts";
import { BashJobs } from "../../src/octocode/files/bash-jobs.ts";
import { sandboxPolicy } from "../../src/octocode/permission/sandbox/policy.ts";
import { SrtCommandSandbox } from "../../src/octocode/permission/sandbox/srt.ts";
import { setCommandSandbox } from "../../src/utils/command-sandbox.ts";
import { getShellEnv, resolveBashShell, spawnShell } from "../../src/utils/shell.ts";
import { tmp } from "./helpers.ts";
import { mainEnv } from "./sandbox-helpers.ts";

/** Applies the setting in `agentDir` for a main session in `workspace` mode. */
const applyCommandSandboxSetting = (agentDir: string) => applySetting(() => "workspace", agentDir, mainEnv());
/** The adapter with the policy of a main session in `workspace` mode under `sandbox.mode: on`. */
const srtSandbox = () =>
	new SrtCommandSandbox((cwd) => sandboxPolicy(cwd, { setting: "on", mode: "workspace", env: mainEnv() }));

const macOnly = process.platform === "darwin" ? describe : describe.skip;

/** A folder the sandbox policy does not open: outside the workspace, the system temporary folders and the agent scratch. */
const outsideDirs: string[] = [];
function outsideDir(): string {
	const dir = fs.mkdtempSync(path.join("/private/var/tmp", "octocode-sandbox-test-"));
	outsideDirs.push(dir);
	return dir;
}

afterEach(() => {
	setCommandSandbox(undefined);
	for (const dir of outsideDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function agentDirWith(settings: object | undefined): string {
	const dir = tmp();
	if (settings) fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify(settings));
	return dir;
}

async function run(command: string, cwd: string, options: { unsandboxed?: boolean } = {}) {
	const child = await spawnShell(resolveBashShell(), command, { cwd, env: getShellEnv(), ...options });
	let output = "";
	child.stdout?.on("data", (chunk: Buffer) => (output += chunk));
	child.stderr?.on("data", (chunk: Buffer) => (output += chunk));
	const code = await new Promise<number | null>((resolve) => child.once("close", resolve));
	return { code, output };
}

const writeFile = (target: string) => `node -e "require('fs').writeFileSync(process.argv[1],'1')" '${target}'`;

macOnly("the command sandbox (sandbox.mode: on)", () => {
	it("refuses a write outside the workspace with EPERM and allows one inside", async () => {
		const workspace = tmp();
		const outside = outsideDir();
		applyCommandSandboxSetting(agentDirWith({ sandbox: { mode: "on" } }));

		const denied = await run(writeFile(path.join(outside, "x")), workspace);
		expect(denied.code).not.toBe(0);
		expect(denied.output).toContain("EPERM");
		expect(fs.existsSync(path.join(outside, "x"))).toBe(false);

		const allowed = await run(writeFile(path.join(workspace, "x")), workspace);
		expect(allowed.code).toBe(0);
		expect(fs.readFileSync(path.join(workspace, "x"), "utf8")).toBe("1");
	});

	it("keeps the host's temporary folder as TMPDIR and loopback reachable", async () => {
		applyCommandSandboxSetting(agentDirWith({ sandbox: { mode: "on" } }));
		const server = net.createServer((socket) => socket.end("pong"));
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		try {
			const { port } = server.address() as net.AddressInfo;
			const temp = await run('echo "$TMPDIR"', tmp());
			expect(fs.realpathSync(temp.output.trim())).toBe(fs.realpathSync(os.tmpdir()));
			const connect = `node -e "require('net').connect(${port},'127.0.0.1').on('data',d=>{console.log(String(d));process.exit(0)}).on('error',e=>{console.log(e.code);process.exit(1)})"`;
			const result = await run(connect, tmp());
			expect(result.output).toContain("pong");
		} finally {
			server.close();
		}
	});

	it("does not apply to the user's own commands", async () => {
		const outside = outsideDir();
		applyCommandSandboxSetting(agentDirWith({ sandbox: { mode: "on" } }));
		const result = await run(writeFile(path.join(outside, "x")), tmp(), { unsandboxed: true });
		expect(result.code).toBe(0);
		expect(fs.existsSync(path.join(outside, "x"))).toBe(true);
	});

	it("sandboxes background jobs too", async () => {
		const workspace = tmp();
		const outside = outsideDir();
		applyCommandSandboxSetting(agentDirWith({ sandbox: { mode: "on" } }));
		const jobs = new BashJobs(tmp());
		const finished = new Promise<void>((resolve) => {
			void jobs.start(
				`${writeFile(path.join(outside, "x"))}; ${writeFile(path.join(workspace, "y"))}`,
				workspace,
				undefined,
				() => resolve(),
			);
		});
		await finished;
		expect(fs.existsSync(path.join(outside, "x"))).toBe(false);
		expect(fs.existsSync(path.join(workspace, "y"))).toBe(true);
	});

	it("refuses to run in the home folder, where the whole home would become writable", async () => {
		applyCommandSandboxSetting(agentDirWith({ sandbox: { mode: "on" } }));
		await expect(run("true", os.homedir())).rejects.toThrow(/needs a project folder/);
	});
});

describe("sandbox.mode: off (the default)", () => {
	it("runs commands as before", async () => {
		const outside = outsideDir();
		for (const settings of [undefined, { sandbox: { mode: "off" } }]) {
			applyCommandSandboxSetting(agentDirWith(settings));
			const result = await run(writeFile(path.join(outside, "x")), tmp());
			expect(result.code).toBe(0);
			fs.rmSync(path.join(outside, "x"));
		}
	});

	it("is not changed by a project settings file", async () => {
		const workspace = tmp();
		fs.mkdirSync(path.join(workspace, ".octocode"));
		fs.writeFileSync(path.join(workspace, ".octocode", "settings.json"), JSON.stringify({ sandbox: { mode: "on" } }));
		applyCommandSandboxSetting(agentDirWith(undefined));
		const outside = outsideDir();
		expect((await run(writeFile(path.join(outside, "x")), workspace)).code).toBe(0);
	});
});

describe("the sandbox adapter", () => {
	it.runIf(process.platform !== "darwin")("refuses a command on a platform it does not support", async () => {
		setCommandSandbox(srtSandbox());
		await expect(run("true", tmp())).rejects.toThrow(/supports macOS only/);
	});

	it("refuses a shell that does not take `-c <command>`", async () => {
		await expect(
			srtSandbox().wrap({
				shell: "/bin/sh",
				shellArgs: ["-s"],
				viaStdin: true,
				command: "true",
				cwd: tmp(),
			}),
		).rejects.toThrow(/-c <command>/);
	});

	it("writes the workspace, the temporary folders and the agent scratch, and re-denies Claude Code's folders", () => {
		const workspace = fs.realpathSync(tmp());
		const scratch = path.join(workspace, "scratch");
		const env = mainEnv({ OCTOCODE_AGENT_SCRATCH: scratch });
		const policy = sandboxPolicy(workspace, { setting: "on", mode: "workspace", env });
		expect(policy?.allowWrite).toEqual(
			expect.arrayContaining([workspace, fs.realpathSync(os.tmpdir()), "/tmp", scratch]),
		);
		expect(policy?.denyWrite).toEqual(
			expect.arrayContaining(["/tmp/claude", path.join(os.homedir(), ".claude", "debug")]),
		);
	});
});
