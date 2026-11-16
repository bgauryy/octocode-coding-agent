import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { reapOrphanGroups } from "@octocodeai/octocode-common/process-group-records";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StdioTransport } from "../../src/client/index.ts";
import { installMcpHost } from "../../src/host.ts";
import type { McpHostPorts } from "../../src/host.ts";

const owner = fileURLToPath(new URL("./fixtures/group-owner.mjs", import.meta.url));
const posix = process.platform !== "win32";

const alive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};
const groupAlive = (pid: number): boolean => {
	try {
		process.kill(-pid, 0);
		return true;
	} catch {
		return false;
	}
};
const until = async (check: () => boolean, ms = 5000): Promise<void> => {
	const end = Date.now() + ms;
	while (!check() && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 25));
};

/** An owner process with a recorded server group; resolves to the owner and the group's pid. */
async function startOwner(dir: string): Promise<{ owner: ChildProcess; group: number }> {
	const child = spawn(process.execPath, [owner, dir], { stdio: ["ignore", "pipe", "inherit"] });
	const group = await new Promise<number>((resolve, reject) => {
		child.once("error", reject);
		child.stdout.once("data", (chunk: Buffer) => resolve(Number(chunk.toString().trim())));
	});
	return { owner: child, group };
}

describe.skipIf(!posix)("stdio server owner records", () => {
	let dir: string;
	const started: ChildProcess[] = [];
	const groups: number[] = [];
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-owner-"));
	});
	afterEach(() => {
		for (const child of started.splice(0)) child.kill("SIGKILL");
		for (const group of groups.splice(0)) {
			try {
				process.kill(-group, "SIGKILL");
			} catch {
				// Already stopped by the test.
			}
		}
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("stops the group of a SIGKILLed owner and leaves a live owner's group alone", async () => {
		const dead = await startOwner(dir);
		const live = await startOwner(dir);
		started.push(dead.owner, live.owner);
		groups.push(dead.group, live.group);
		expect(fs.readdirSync(dir)).toHaveLength(2);

		const exited = new Promise((resolve) => dead.owner.once("exit", resolve));
		dead.owner.kill("SIGKILL");
		await exited;
		expect(groupAlive(dead.group)).toBe(true);

		const reaped = await reapOrphanGroups(dir);
		expect(reaped).toEqual([{ pid: dead.group, label: "fake server", stopped: true }]);
		await until(() => !groupAlive(dead.group));
		expect(groupAlive(dead.group)).toBe(false);
		expect(groupAlive(live.group)).toBe(true);
		expect(fs.readdirSync(dir)).toEqual([`${live.group}.group.json`]);
	});

	it("removes the record without a signal when the group's leader is gone", async () => {
		const dead = await startOwner(dir);
		started.push(dead.owner);
		groups.push(dead.group);
		process.kill(dead.group, "SIGKILL");
		await until(() => !alive(dead.group));
		dead.owner.kill("SIGKILL");
		await new Promise((resolve) => dead.owner.once("exit", resolve));
		expect(await reapOrphanGroups(dir)).toEqual([]);
		expect(fs.readdirSync(dir)).toEqual([]);
	});

	it("records a running stdio server's group and removes the record on close", async () => {
		const ports = { paths: { serverRecordsDir: () => dir } } as unknown as Partial<McpHostPorts>;
		installMcpHost(ports);
		try {
			const transport = new StdioTransport({ command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"] });
			await transport.start();
			const pid = transport.pid!;
			await until(() => fs.existsSync(path.join(dir, `${pid}.group.json`)));
			const record = JSON.parse(fs.readFileSync(path.join(dir, `${pid}.group.json`), "utf8"));
			expect(record).toMatchObject({ pid, owner: { pid: process.pid } });
			expect(record.started).toMatch(/^\d+$/);
			await transport.close();
			await until(() => !fs.existsSync(path.join(dir, `${pid}.group.json`)));
			expect(fs.readdirSync(dir)).toEqual([]);
		} finally {
			installMcpHost({ paths: undefined });
		}
	});
});
