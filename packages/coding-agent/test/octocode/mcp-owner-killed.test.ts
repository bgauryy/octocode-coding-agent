// The research MCP server (the octocode-mcp launcher and its native child, in their own process group) must not
// outlive a SIGKILLed owner. Nothing in the owner runs after SIGKILL, so the servers have to end on stdin EOF.
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { tmp } from "./helpers.ts";

const pkg = path.resolve(import.meta.dirname, "../..");
const transport = path.resolve(pkg, "../mcp/src/client/transports/stdio.ts");
const resolver = pathToFileURL(path.join(pkg, "scripts", "source-resolver.ts")).href;

/** The octocode-mcp launcher this checkout runs (the preset's `node <bin>` form), if it is built. */
function serverEntry(): string | undefined {
	try {
		const manifest = createRequire(path.resolve(pkg, "../mcp/package.json")).resolve("octocode-mcp/package.json");
		const { bin } = JSON.parse(fs.readFileSync(manifest, "utf8")) as { bin: string | Record<string, string> };
		const file = path.join(path.dirname(manifest), typeof bin === "string" ? bin : (Object.values(bin)[0] ?? ""));
		return fs.existsSync(file) ? file : undefined;
	} catch {
		return undefined;
	}
}

/** Whether any process of group `pgid` still runs (signal 0 to the group: ESRCH once every member is gone). */
const groupAlive = (pgid: number): boolean => alive(-pgid);

/** Whether process `pid` (or group `-pid`) still runs. */
function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** The pids in process group `pgid` (`pgrep` exits 1 when there are none). */
function groupMembers(pgid: number): number[] {
	const found = spawnSync("pgrep", ["-g", String(pgid)], { encoding: "utf8" });
	if (found.error) throw found.error;
	return found.stdout.split(/\s+/).filter(Boolean).map(Number);
}

const owners: ChildProcess[] = [];
const groups: number[] = [];
afterEach(() => {
	for (const owner of owners.splice(0)) owner.kill("SIGKILL");
	for (const pgid of groups.splice(0)) {
		try {
			process.kill(-pgid, "SIGKILL");
		} catch {
			// Already gone, as expected.
		}
	}
});

const entry = serverEntry();

describe.skipIf(process.platform === "win32" || !entry)("a SIGKILLed owner of the research MCP server", () => {
	it("leaves no server process behind", async () => {
		const cwd = tmp();
		const script = path.join(tmp(), "owner.mts");
		fs.writeFileSync(
			script,
			[
				`import { StdioTransport } from ${JSON.stringify(pathToFileURL(transport).href)};`,
				`const server = new StdioTransport({ command: process.execPath, args: [${JSON.stringify(entry)}], cwd: ${JSON.stringify(cwd)}, env: { WORKSPACE_ROOT: ${JSON.stringify(cwd)} } });`,
				// The launcher only forwards its stdio to the native server, so an answer to `initialize` means the native
				// child runs; the owner reports the group id only then.
				"server.onMessage((message) => { if ('id' in message && message.id === 1) process.stdout.write(`${server.pid}\\n`); });",
				"await server.start();",
				`await server.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "owner-killed-test", version: "0" } } });`,
				"setInterval(() => {}, 1000);",
			].join("\n"),
		);
		const owner = spawn(process.execPath, ["--import", resolver, script], { stdio: ["ignore", "pipe", "inherit"] });
		owners.push(owner);
		const pgid = await new Promise<number>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("the native server never answered initialize")), 20_000);
			owner.stdout.once("data", (chunk: Buffer) => {
				clearTimeout(timer);
				resolve(Number(String(chunk).trim()));
			});
			owner.once("exit", (code) => {
				clearTimeout(timer);
				reject(new Error(`owner exited early: ${code}`));
			});
		});
		groups.push(pgid);
		// The launcher and its native child (which inherits the launcher's stdio and group) both run.
		const members = groupMembers(pgid);
		expect(members).toContain(pgid);
		expect(members.length).toBeGreaterThanOrEqual(2);

		owner.kill("SIGKILL");
		for (let waited = 0; groupAlive(pgid) && waited < 10_000; waited += 100)
			await new Promise((resolve) => setTimeout(resolve, 100));
		// No member of the group (the launcher, the native server or anything they started) survives.
		expect(groupAlive(pgid)).toBe(false);
		expect(groupMembers(pgid)).toEqual([]);
		expect(members.filter(alive)).toEqual([]);
	}, 30_000);
});
