import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { recordProcessGroup } from "@octocodeai/octocode-common/process-group-records";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as stdioOwner from "../src/client/transports/stdio-owner.ts";
import { installMcpHost } from "../src/host.ts";
import { installMcpServer, resetMcpInstallFailures } from "../src/install.ts";
import { takeLaunchWarnings } from "../src/warnings.ts";

const alive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};
const until = async (done: () => boolean): Promise<void> => {
	for (let i = 0; i < 100 && !done(); i++) await new Promise((resolve) => setTimeout(resolve, 50));
	expect(done()).toBe(true);
};

const spec = { npm: "@scope/server", version: "1.2.3" };
let root: string;
let records: string;
let savedPath: string | undefined;

/** Installs a sleeping npm stub in this test's PATH. */
function stubNpm(): void {
	const bin = path.join(root, "bin");
	fs.mkdirSync(bin);
	fs.writeFileSync(path.join(bin, "npm"), "#!/bin/sh\nsleep 300\n", { mode: 0o755 });
	process.env.PATH = `${bin}${path.delimiter}${savedPath}`;
}

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-install-npm-"));
	records = path.join(root, "records");
	savedPath = process.env.PATH;
	resetMcpInstallFailures();
	takeLaunchWarnings();
	installMcpHost({ paths: { serverRecordsDir: () => records } } as never);
});
afterEach(() => {
	process.env.PATH = savedPath;
	installMcpHost({ paths: undefined });
	fs.rmSync(root, { recursive: true, force: true });
});

describe.skipIf(process.platform === "win32")("default npm runner", () => {
	it("kills the npm group at the deadline, removes its record and reports the failure", async () => {
		using recorded = vi.spyOn(stdioOwner, "recordStdioGroup");
		stubNpm();
		const agentDir = path.join(root, "agent");
		await expect(installMcpServer("srv", spec, { agentDir, npmTimeoutMs: 2000 })).rejects.toThrow(
			/did not finish within/,
		);
		// The parent records the group as soon as it spawns. A deadline can fire before the shell runs its first command.
		expect(recorded).toHaveBeenCalledTimes(1);
		const [pid] = recorded.mock.calls[0];
		await until(() => !alive(pid));
		expect(fs.readdirSync(records)).toEqual([]);
		expect(takeLaunchWarnings().join("\n")).toMatch(/left out/);
	}, 15_000);

	it("reaps a group recorded by a dead owner before the next install runs", async () => {
		const sleeper = spawn("sleep", ["300"], { detached: true, stdio: "ignore" });
		sleeper.unref();
		const pid = sleeper.pid!;
		await recordProcessGroup(records, pid, "npm install");
		const file = path.join(records, `${pid}.group.json`);
		const record = JSON.parse(fs.readFileSync(file, "utf8"));
		const dead = spawn("true");
		await new Promise((resolve) => dead.once("exit", resolve));
		record.owner = { pid: dead.pid };
		fs.writeFileSync(file, JSON.stringify(record));
		stubNpm();
		await expect(
			installMcpServer("srv", spec, { agentDir: path.join(root, "agent"), npmTimeoutMs: 300 }),
		).rejects.toThrow();
		await until(() => !alive(pid));
		expect(fs.existsSync(file)).toBe(false);
	}, 15_000);
});
