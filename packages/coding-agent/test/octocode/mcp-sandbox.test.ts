import fs from "node:fs";
import path from "node:path";
import { findOnPath } from "@octocodeai/octocode-common/find-on-path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StdioTransport } from "../../../mcp/src/client/index.ts";
import { ENV_AGENT_DIR } from "../../src/config.ts";
import { mcpSandboxPort, setOptInSandboxSession } from "../../src/octocode/permission/sandbox/opt-in.ts";
import { tmp } from "./helpers.ts";

/** Where the sandbox runs for real: macOS, or Linux with bubblewrap installed; other hosts skip it. */
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

/** Runs a server that tries to read the key and reports what it read, or its error code, on stderr. */
async function readKey(sandboxed: boolean): Promise<string> {
	const script = `try { process.stderr.write(require("fs").readFileSync(process.argv[1], "utf8")) } catch (e) { process.stderr.write("refused " + e.code) }`;
	const transport = new StdioTransport({
		command: process.execPath,
		args: ["-e", script, path.join(home, ".ssh", "id_ed25519")],
		cwd: workspace,
		env: { HOME: home },
		...(sandboxed ? { wrapLaunch: mcpSandboxPort.wrapStdio } : {}),
	});
	const closed = new Promise<void>((resolve) => transport.onClose(resolve));
	await transport.start();
	await closed;
	return transport.stderr;
}

describe.runIf(sandboxHost)("a stdio MCP server that opts into the sandbox (needs macOS, or Linux with bwrap)", () => {
	it("cannot read ~/.ssh, and the same server without the opt-in can", async () => {
		const sandboxed = await readKey(true);
		expect(sandboxed).toMatch(/^refused E(PERM|ACCES|NOENT)/);
		expect(sandboxed).not.toContain(SECRET);
		expect(await readKey(false)).toBe(SECRET);
	});
});
