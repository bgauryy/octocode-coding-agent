import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventLog } from "../../src/octocode/api/events.ts";
import { probeInstances } from "../../src/octocode/api/probe.ts";
import {
	apiDir,
	ensurePrivateDir,
	type InstanceRecord,
	instancesDir,
	listInstances,
	removeSocket,
	socketPath,
} from "../../src/octocode/api/registry.ts";
import { ApiServer } from "../../src/octocode/api/server.ts";
import { tmp } from "./helpers.ts";

/**
 * A probe that finds nothing behind a record's socket drops that record. Any process of the user can write a record, so
 * one that repeats a live instance's id with a dead socket must cost only its own file, never the instance's `<id>.json`.
 */

let home: string;
const servers: { server: ApiServer; socket: string }[] = [];
beforeEach(() => {
	home = tmp("octocode-probe-integrity-");
	vi.stubEnv("OCTOCODE_HOME", home);
	ensurePrivateDir(apiDir());
});
afterEach(async () => {
	vi.unstubAllEnvs();
	for (const { server, socket } of servers.splice(0)) {
		await server.close();
		removeSocket(socket);
	}
});

const file = (name: string) => join(instancesDir(apiDir()), `${name}.json`);

function write(name: string, record: Pick<InstanceRecord, "id" | "socket"> & Partial<InstanceRecord>): void {
	writeFileSync(
		file(name),
		JSON.stringify({ pid: process.ppid, cwd: "/w", startedAt: Date.now(), protocol: 1, ...record }),
	);
}

/** A live instance: its own file, and a socket that answers `status`. */
async function live(id: string): Promise<string> {
	const socket = socketPath(apiDir(), id);
	const server = new ApiServer(
		async (method) => (method === "status" ? { state: "idle", pending: false } : undefined),
		new EventLog(),
		"token",
	);
	await server.listenUnix(socket);
	servers.push({ server, socket });
	write(id, { id, socket });
	return socket;
}

describe("a refused probe", () => {
	it("removes a forged duplicate's own file, never the real instance's record", async () => {
		const socket = await live("oc-real");
		write("zz", { id: "oc-real", socket: socketPath(apiDir(), "oc-dead"), startedAt: 0 });
		const probed = await probeInstances(listInstances(apiDir()));
		expect(probed.map(({ instance }) => instance.socket)).toEqual([socket]);
		expect(existsSync(file("oc-real"))).toBe(true);
		expect(existsSync(file("zz"))).toBe(false);
	});

	it("removes an instance's own record when nothing listens on its socket", async () => {
		write("oc-gone", { id: "oc-gone", socket: socketPath(apiDir(), "oc-gone") });
		await expect(probeInstances(listInstances(apiDir()))).resolves.toEqual([]);
		expect(existsSync(file("oc-gone"))).toBe(false);
	});
});
