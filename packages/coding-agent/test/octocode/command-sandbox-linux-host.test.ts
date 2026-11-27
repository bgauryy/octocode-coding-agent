import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { findOnPath } from "@octocodeai/octocode-common/find-on-path";
import { afterEach, describe, expect, it } from "vitest";
import { applyCommandSandboxSetting } from "../../src/octocode/permission/sandbox/apply.ts";
import { setCommandSandbox } from "../../src/utils/command-sandbox.ts";
import { getShellEnv, resolveBashShell, spawnShell } from "../../src/utils/shell.ts";
import { tmp } from "./helpers.ts";

/**
 * Commands run through bubblewrap for real: only a Linux host with bubblewrap (and socat) installed can run them, so a
 * macOS host or a Linux host without bubblewrap skips the whole suite. The OS-independent part of the Linux backend is
 * tested in command-sandbox-linux.test.ts on every host.
 */
const linuxWithBubblewrap = process.platform === "linux" && findOnPath("bwrap") !== undefined;

const outsideDirs: string[] = [];

/** A folder outside every writable root: /var/tmp is neither the system temporary folder nor the workspace. */
function outsideDir(): string {
	const dir = fs.mkdtempSync(path.join("/var/tmp", "octocode-sandbox-test-"));
	outsideDirs.push(dir);
	return dir;
}

afterEach(() => {
	setCommandSandbox(undefined);
	for (const dir of outsideDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function sandboxOn(): void {
	const agentDir = tmp();
	fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ sandbox: { mode: "on" } }));
	applyCommandSandboxSetting(() => "workspace", agentDir);
}

async function run(command: string, cwd: string) {
	const child = await spawnShell(resolveBashShell(), command, { cwd, env: getShellEnv() });
	let output = "";
	child.stdout?.on("data", (chunk: Buffer) => (output += chunk));
	child.stderr?.on("data", (chunk: Buffer) => (output += chunk));
	const code = await new Promise<number | null>((resolve) => child.once("close", resolve));
	return { code, output };
}

const writeFile = (target: string) => `node -e "require('fs').writeFileSync(process.argv[1],'1')" '${target}'`;

describe.runIf(linuxWithBubblewrap)(
	"the command sandbox on Linux (bubblewrap; skipped without Linux and bwrap)",
	() => {
		it("refuses a write outside the workspace and allows one inside", async () => {
			const workspace = fs.realpathSync(tmp());
			const outside = outsideDir();
			sandboxOn();
			const denied = await run(writeFile(path.join(outside, "x")), workspace);
			expect(denied.code).not.toBe(0);
			expect(denied.output).toMatch(/EROFS|EPERM|EACCES/);
			expect(fs.existsSync(path.join(outside, "x"))).toBe(false);
			const allowed = await run(writeFile(path.join(workspace, "x")), workspace);
			expect(allowed.code).toBe(0);
			expect(fs.readFileSync(path.join(workspace, "x"), "utf8")).toBe("1");
		});

		it("protects the hooks of the repository and of one nested in it", async () => {
			const workspace = fs.realpathSync(tmp());
			execFileSync("git", ["init", "-q"], { cwd: workspace });
			fs.mkdirSync(path.join(workspace, "sub"));
			execFileSync("git", ["init", "-q"], { cwd: path.join(workspace, "sub") });
			sandboxOn();
			for (const hooks of [path.join(workspace, ".git", "hooks"), path.join(workspace, "sub", ".git", "hooks")]) {
				const result = await run(writeFile(path.join(hooks, "pre-commit")), workspace);
				expect(result.code).not.toBe(0);
				expect(fs.existsSync(path.join(hooks, "pre-commit"))).toBe(false);
			}
			expect((await run(writeFile(path.join(workspace, "sub", "file")), workspace)).code).toBe(0);
		});

		it("refuses a host outside the allow list when nothing can answer", async () => {
			sandboxOn();
			const result = await run("curl -sS --max-time 5 https://example.com", fs.realpathSync(tmp()));
			expect(result.code).not.toBe(0);
		});
	},
);
