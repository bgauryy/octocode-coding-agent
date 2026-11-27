import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR, getOctocodeHome } from "../../src/config.ts";
import { apiDir } from "../../src/octocode/api/registry.ts";
import { sandboxPolicy } from "../../src/octocode/permission/sandbox/policy.ts";
import { outputDir } from "../../src/octocode/shared/home.ts";
import { attachRecordPath, webDaemonPaths } from "../../src/octocode/web-daemon/paths.ts";
import { SrtCommandSandbox } from "../../src/octocode/permission/sandbox/srt.ts";
import { setCommandSandbox } from "../../src/utils/command-sandbox.ts";
import { getShellEnv, resolveBashShell, spawnShell } from "../../src/utils/shell.ts";
import { tmp } from "./helpers.ts";
import { mainEnv } from "./sandbox-helpers.ts";

const SECRET = "fake-credential-contents";
const saved = { HOME: process.env.HOME, agentDir: process.env[ENV_AGENT_DIR] };
let home = "";
let agentDir = "";
let workspace = "";

beforeEach(() => {
	home = fs.realpathSync(tmp());
	agentDir = fs.realpathSync(tmp());
	workspace = fs.realpathSync(tmp());
	process.env.HOME = home;
	process.env[ENV_AGENT_DIR] = agentDir;
	for (const folder of [".ssh", ".aws", ".gnupg"]) {
		fs.mkdirSync(path.join(home, folder));
		fs.writeFileSync(path.join(home, folder, "secret"), SECRET);
	}
	fs.writeFileSync(path.join(agentDir, "auth.json"), SECRET);
	fs.writeFileSync(path.join(workspace, "plain.txt"), "plain");
});

afterEach(() => {
	setCommandSandbox(undefined);
	if (saved.HOME === undefined) delete process.env.HOME;
	else process.env.HOME = saved.HOME;
	if (saved.agentDir === undefined) delete process.env[ENV_AGENT_DIR];
	else process.env[ENV_AGENT_DIR] = saved.agentDir;
});

const context = (setting: "on" | "auto", mode: "manual" | "full", env = mainEnv()) => ({ setting, mode, env });

describe("the sandbox policy's read denials", () => {
	// S1 widened the list (an intended contract change): a sandboxed command read the web daemon's and each session's attach
	// token, and with it drove the session over loopback. Octocode's stores and token folders are denied with the rest.
	it("names Octocode's credential stores and token folders and the home credential folders, in every sandboxed mode and for a read-only child", () => {
		const octocodeHome = getOctocodeHome();
		const expected = [
			path.join(agentDir, "auth.json"),
			path.join(agentDir, "mcp-auth.json"),
			path.join(octocodeHome, "auth.json"),
			path.join(octocodeHome, "mcp-auth.json"),
			path.join(octocodeHome, "web"),
			path.join(octocodeHome, "api"),
			path.join(octocodeHome, "child-credentials"),
			path.join(home, ".ssh"),
			path.join(home, ".aws"),
			path.join(home, ".gnupg"),
		];
		for (const mode of ["manual", "full"] as const)
			expect(sandboxPolicy(workspace, context("on", mode))?.denyRead).toEqual(expected);
		const readOnly = sandboxPolicy(workspace, context("on", "manual", mainEnv({ OCTOCODE_READ_ONLY: "1" })));
		expect(readOnly?.denyRead).toEqual(expected);
	});

	it("covers every token file the web daemon, the API registry and a subagent handoff write", () => {
		const denied = sandboxPolicy(workspace, context("on", "manual"))?.denyRead ?? [];
		const covered = (file: string) => denied.some((entry) => file === entry || file.startsWith(`${entry}${path.sep}`));
		for (const file of [
			webDaemonPaths().record,
			attachRecordPath(process.env, "session-1"),
			path.join(apiDir(), "instances", "a.json"),
			path.join(outputDir("child-credentials"), "nonce-x"),
			path.join(agentDir, "mcp-auth.json"),
		])
			expect(covered(file), file).toBe(true);
	});

	it("names a models.json only while it holds a literal apiKey", () => {
		const models = path.join(agentDir, "models.json");
		const denied = () => sandboxPolicy(workspace, context("on", "manual"))?.denyRead ?? [];
		fs.writeFileSync(models, JSON.stringify({ providers: { p: { apiKey: "$P_KEY" } } }));
		expect(denied()).not.toContain(models);
		fs.writeFileSync(models, JSON.stringify({ providers: { p: { apiKey: "sk-literal" } } }));
		expect(denied()).toContain(models);
	});

	it("follows the agent directory and home folder in effect, not fixed paths", () => {
		const other = fs.realpathSync(tmp());
		process.env.HOME = other;
		const denied = sandboxPolicy(workspace, context("on", "manual"))?.denyRead ?? [];
		expect(denied).toContain(path.join(other, ".ssh"));
		expect(denied).not.toContain(path.join(home, ".ssh"));
	});
});

describe.runIf(process.platform === "darwin")("a sandboxed command reading credentials", () => {
	async function run(command: string): Promise<{ output: string; code: number | null }> {
		setCommandSandbox(new SrtCommandSandbox((cwd) => sandboxPolicy(cwd, context("on", "manual"))));
		const child = await spawnShell(resolveBashShell(), command, { cwd: workspace, env: getShellEnv() });
		let output = "";
		child.stdout?.on("data", (chunk: Buffer) => (output += chunk));
		child.stderr?.on("data", (chunk: Buffer) => (output += chunk));
		const code = await new Promise<number | null>((resolve) => child.once("close", resolve));
		return { output, code };
	}

	it("is refused for auth.json and each credential folder, and still reads an ordinary file", async () => {
		const ok = await run("cat plain.txt");
		expect(ok).toEqual({ output: "plain", code: 0 });
		const attach = attachRecordPath(process.env, "session-1");
		fs.mkdirSync(path.dirname(attach), { recursive: true });
		fs.writeFileSync(attach, SECRET);
		fs.writeFileSync(webDaemonPaths().record, SECRET);
		fs.writeFileSync(path.join(agentDir, "mcp-auth.json"), SECRET);
		for (const target of [
			path.join(agentDir, "auth.json"),
			path.join(agentDir, "mcp-auth.json"),
			attach,
			webDaemonPaths().record,
			...[".ssh", ".aws", ".gnupg"].map((f) => path.join(home, f, "secret")),
		]) {
			const refused = await run(`cat '${target}'`);
			expect(refused.code).not.toBe(0);
			expect(refused.output).not.toContain(SECRET);
		}
	});
});
