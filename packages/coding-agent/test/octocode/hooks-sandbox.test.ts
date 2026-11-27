import fs from "node:fs";
import path from "node:path";
import { findOnPath } from "@octocodeai/octocode-common/find-on-path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../../src/config.ts";
import { parseHooks } from "../../src/octocode/hooks/config/parse.ts";
import type { HookCommand } from "../../src/octocode/hooks/contracts.ts";
import { runHook } from "../../src/octocode/hooks/runner.ts";
import { setOptInSandboxSession } from "../../src/octocode/permission/sandbox/opt-in.ts";
import { tmp } from "./helpers.ts";

/** Where the sandbox runs for real: macOS, or Linux with bubblewrap installed; other hosts skip those tests. */
const sandboxHost =
	process.platform === "darwin" || (process.platform === "linux" && findOnPath("bwrap") !== undefined);

const SECRET = "fake-ssh-key";
const saved = { HOME: process.env.HOME, agentDir: process.env[ENV_AGENT_DIR] };
let home = "";
let workspace = "";

beforeEach(() => {
	home = fs.realpathSync(tmp());
	workspace = fs.realpathSync(tmp());
	process.env.HOME = home;
	process.env[ENV_AGENT_DIR] = fs.realpathSync(tmp());
	fs.mkdirSync(path.join(home, ".ssh"));
	fs.writeFileSync(path.join(home, ".ssh", "id_ed25519"), SECRET);
	setOptInSandboxSession(() => "workspace", undefined);
});

afterEach(() => {
	if (saved.HOME === undefined) delete process.env.HOME;
	else process.env.HOME = saved.HOME;
	if (saved.agentDir === undefined) delete process.env[ENV_AGENT_DIR];
	else process.env[ENV_AGENT_DIR] = saved.agentDir;
});

function parsed(handler: Record<string, unknown>): { hooks: HookCommand[]; errors: string[] } {
	const errors: string[] = [];
	const config = parseHooks({ hooks: { PreToolUse: [{ hooks: [handler] }] } }, "fixture", undefined, errors);
	const groups = (config as unknown as Record<string, Array<{ hooks: HookCommand[] }>>).PreToolUse ?? [];
	return { hooks: groups.flatMap((group) => group.hooks), errors };
}

const readKey = (sandbox: boolean): HookCommand => ({
	command: `cat "${path.join(home, ".ssh", "id_ed25519")}"`,
	timeoutMs: 20_000,
	source: "fixture",
	...(sandbox ? { sandbox: true as const } : {}),
});

describe("a command hook's opt-in sandbox", () => {
	it("is read from `sandbox: true` and rejects a value that is not a boolean", () => {
		expect(parsed({ type: "command", command: "true", sandbox: true }).hooks[0]?.sandbox).toBe(true);
		expect(parsed({ type: "command", command: "true" }).hooks[0]?.sandbox).toBeUndefined();
		expect(parsed({ type: "command", command: "true", sandbox: "yes" }).errors.join("\n")).toMatch(
			/sandbox must be a boolean/,
		);
	});

	it("does not start a sandboxed PowerShell hook", async () => {
		const run = await runHook({ ...readKey(true), protocol: "claude", shell: "powershell" }, {}, workspace);
		expect(run.code).toBeNull();
		expect(run.stderr).toMatch(/sandboxed hook was not started/);
	});

	it("does not start a sandboxed hook where the sandbox cannot start", async () => {
		const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
		Object.defineProperty(process, "platform", { ...platform, value: "aix" });
		try {
			const run = await runHook(readKey(true), {}, workspace);
			expect(run.code).toBeNull();
			expect(run.stdout).not.toContain(SECRET);
			expect(run.stderr).toMatch(/sandboxed hook was not started: .*supports macOS and Linux only/);
		} finally {
			Object.defineProperty(process, "platform", platform);
		}
	});

	it.runIf(sandboxHost)(
		"cannot read ~/.ssh, and the same hook without the opt-in can (needs macOS, or Linux with bwrap)",
		async () => {
			const sandboxed = await runHook(readKey(true), {}, workspace);
			expect(sandboxed.code).not.toBe(0);
			expect(sandboxed.stdout).not.toContain(SECRET);
			const plain = await runHook(readKey(false), {}, workspace);
			expect(plain.code).toBe(0);
			expect(plain.stdout).toBe(SECRET);
		},
	);
});
