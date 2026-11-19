import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { BashJobs } from "../../src/octocode/files/bash-jobs.ts";
import { applyCommandSandboxSetting as applySetting } from "../../src/octocode/permission/sandbox/apply.ts";
import { tempDirTooLongForSocket } from "../../src/octocode/permission/sandbox/socket-dir.ts";
import { setCommandSandbox } from "../../src/utils/command-sandbox.ts";
import { getShellEnv, resolveBashShell, spawnShell } from "../../src/utils/shell.ts";
import { tmp } from "./helpers.ts";
import { mainEnv } from "./sandbox-helpers.ts";

/**
 * A long `TMPDIR` (the isolated one `./test.sh` makes, or a nested one under a user's `/var/folders/...`): the library's
 * proxy socket path would pass the Unix socket limit there. A separate file, so the library starts here for the first
 * time in this process, with the long folder already named.
 */
const macOnly = process.platform === "darwin" ? describe : describe.skip;

const hostTmpdir = process.env.TMPDIR;
let longTmpdir = "";
let root = "";

beforeAll(() => {
	root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "octocode-long-tmpdir-"));
	longTmpdir = root;
	while (!tempDirTooLongForSocket(longTmpdir) || Buffer.byteLength(longTmpdir) < 104)
		longTmpdir = fs.mkdirSync(path.join(longTmpdir, "a-long-temporary-folder-segment"), { recursive: true }) as string;
	process.env.TMPDIR = longTmpdir;
});

afterEach(() => setCommandSandbox(undefined));

afterAll(() => {
	if (hostTmpdir === undefined) delete process.env.TMPDIR;
	else process.env.TMPDIR = hostTmpdir;
	fs.rmSync(root, { recursive: true, force: true });
});

const applyCommandSandboxSetting = () => {
	const agentDir = tmp();
	fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ sandbox: { mode: "on" } }));
	applySetting(() => "workspace", agentDir, mainEnv());
};

const writeFile = (target: string) => `node -e "require('fs').writeFileSync(process.argv[1],'1')" '${target}'`;

macOnly("the command sandbox under a long TMPDIR", () => {
	it("starts a foreground command and a background job, keeping the long TMPDIR for them", async () => {
		expect(Buffer.byteLength(path.join(os.tmpdir(), "srt-mux-1234567-0.sock"))).toBeGreaterThan(104);
		applyCommandSandboxSetting();
		const workspace = tmp();

		const child = await spawnShell(resolveBashShell(), `echo "$TMPDIR"; ${writeFile(path.join(workspace, "x"))}`, {
			cwd: workspace,
			env: getShellEnv(),
		});
		let output = "";
		child.stdout?.on("data", (chunk: Buffer) => (output += chunk));
		child.stderr?.on("data", (chunk: Buffer) => (output += chunk));
		const code = await new Promise<number | null>((resolve) => child.once("close", resolve));
		expect(output).toContain(longTmpdir);
		expect(code).toBe(0);
		expect(fs.readFileSync(path.join(workspace, "x"), "utf8")).toBe("1");
		expect(process.env.TMPDIR).toBe(longTmpdir);

		const jobs = new BashJobs(tmp());
		const finished = new Promise<void>((resolve) => {
			void jobs.start(writeFile(path.join(workspace, "y")), workspace, undefined, () => resolve());
		});
		await finished;
		expect(fs.readFileSync(path.join(workspace, "y"), "utf8")).toBe("1");
	});

	it("reaches the proxy, whose HTTP side listens on the socket: a host nothing allows gets the proxy's refusal, not a failed dial", async () => {
		applyCommandSandboxSetting();
		const child = await spawnShell(
			resolveBashShell(),
			"NO_PROXY= no_proxy= curl -s -o /dev/null -w '%{http_code}' -m 10 http://localhost:9/",
			{ cwd: tmp(), env: getShellEnv() },
		);
		let output = "";
		child.stdout?.on("data", (chunk: Buffer) => (output += chunk));
		await new Promise<number | null>((resolve) => child.once("close", resolve));
		expect(output).toBe("403");
	});
});
