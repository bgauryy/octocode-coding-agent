import { type ChildProcess, spawn } from "node:child_process";
import { realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FeatureContext } from "../../src/core/features/index.ts";
import { EventLog } from "../../src/octocode/api/events.ts";
import { confirmIdentity, ownInstance, publishOwnInstance } from "../../src/octocode/api/identity.ts";
import {
	apiDir,
	ensurePrivateDir,
	type InstanceRecord,
	instancesDir,
	removeSocket,
	socketPath,
} from "../../src/octocode/api/registry.ts";
import { ApiServer } from "../../src/octocode/api/server.ts";
import { OctocodeBackend } from "../../src/octocode/external/octocode.ts";
import { Peers } from "../../src/octocode/external/peers.ts";
import { tmp } from "./helpers.ts";

/**
 * A sender hands a ticket only to the record in its target's own file (`<id>.json`): a ticket is what lets a receiver
 * confirm the sender's claim, so a record that repeats another instance's id, name or pid must never collect one.
 */

let home: string;
const servers: { server: ApiServer; socket: string }[] = [];
const children: ChildProcess[] = [];
beforeEach(() => {
	home = tmp("octocode-peers-identity-");
	vi.stubEnv("OCTOCODE_HOME", home);
	ensurePrivateDir(apiDir());
});
afterEach(async () => {
	vi.unstubAllEnvs();
	publishOwnInstance(undefined, ownInstance());
	for (const { server, socket } of servers.splice(0)) {
		await server.close();
		removeSocket(socket);
	}
	for (const child of children.splice(0)) child.kill();
});

/** A live pid that is neither this process nor its parent. */
function livePid(): number {
	const child = spawn("sleep", ["30"], { stdio: "ignore" });
	children.push(child);
	return child.pid!;
}

/**
 * A record in `instances/<file>.json` whose socket records each `message.send` it receives; `inspect` sees each call while
 * it is in flight, with the socket it arrived on.
 */
async function listener(
	file: string,
	record: Pick<InstanceRecord, "id" | "pid"> & Partial<InstanceRecord>,
	inspect?: (params: Record<string, unknown>, socket: string) => void,
) {
	const socket = socketPath(apiDir(), `oc-${file}`);
	const received: Record<string, unknown>[] = [];
	const server = new ApiServer(
		async (method, params) => {
			if (method !== "message.send") return undefined;
			received.push(params);
			inspect?.(params, socket);
			return { queued: "accepted" };
		},
		new EventLog(),
		"token",
	);
	await server.listenUnix(socket);
	servers.push({ server, socket });
	writeFileSync(
		join(instancesDir(apiDir()), `${file}.json`),
		JSON.stringify({ cwd: "/w", startedAt: Date.now(), protocol: 1, ...record, socket }),
	);
	return received;
}

function sender(team: Array<{ id: string; pid: number }> = [], ownName?: string) {
	// This session's own record, as its API publishes it, so its claim carries an instance id and a ticket.
	const self: InstanceRecord = {
		id: "oc-self",
		pid: process.pid,
		cwd: "/w",
		startedAt: 1,
		protocol: 1,
		name: "octocode-agent-main-self",
	};
	writeFileSync(join(instancesDir(apiDir()), "oc-self.json"), JSON.stringify(self));
	publishOwnInstance(self);
	const authorize = vi.fn(async () => undefined);
	const peers = new Peers(
		{ authorize, notice: () => undefined, members: () => team, ...(ownName ? { ownName: () => ownName } : {}) },
		process.env,
	);
	const ctx = { cwd: home } as unknown as FeatureContext;
	return { peers, authorize, send: (to: string) => peers.send(to, "hello", {}, ctx) };
}

describe("a sender picks only a canonical, unambiguous record", () => {
	it("sends to the real peer, with a ticket, when no record repeats it", async () => {
		const received = await listener("oc-peer", { id: "oc-peer", pid: process.ppid, name: "octocode-agent-main-peer" });
		const { send } = sender();
		await expect(send("octocode-agent-main-peer")).resolves.toMatchObject({
			details: { to: ["octocode-agent-main-peer"] },
		});
		expect(received).toHaveLength(1);
		expect(received[0].caller).toMatchObject({ instanceId: "oc-self", ticket: expect.any(String) });
	});

	it("refuses a record that repeats the receiver's id under another name: no ticket reaches it", async () => {
		const real = await listener("oc-peer", { id: "oc-peer", pid: process.ppid, name: "octocode-agent-main-peer" });
		const forged = await listener("zz", { id: "oc-peer", pid: livePid(), name: "helper" });
		const { send, authorize } = sender();
		await expect(send("helper")).rejects.toThrow(/Nothing was sent/);
		await expect(send("octocode-agent-main-peer")).rejects.toThrow(/Nothing was sent/);
		expect(forged).toEqual([]);
		expect(real).toEqual([]);
		expect(authorize).not.toHaveBeenCalled();
	});

	it("refuses when two live records share the target's name, listing both", async () => {
		const one = await listener("oc-one", { id: "oc-one", pid: process.ppid, name: "octocode-agent-main-twin" });
		const two = await listener("oc-two", { id: "oc-two", pid: livePid(), name: "octocode-agent-main-twin" });
		const { send } = sender();
		const refused = send("octocode-agent-main-twin");
		await expect(refused).rejects.toThrow(/oc-one/);
		await expect(refused).rejects.toThrow(/oc-two/);
		expect(one).toEqual([]);
		expect(two).toEqual([]);
	});

	it("refuses when another live record shares the target's pid", async () => {
		const real = await listener("oc-peer", { id: "oc-peer", pid: process.ppid, name: "octocode-agent-main-peer" });
		const other = await listener("oc-other", { id: "oc-other", pid: process.ppid, name: "octocode-agent-main-other" });
		const { send } = sender();
		await expect(send("octocode-agent-main-peer")).rejects.toThrow(/oc-other/);
		expect(real).toEqual([]);
		expect(other).toEqual([]);
	});
});

/** A record sorted first, with this process's pid: another process of the user can write it. */
function plantSenderPid() {
	writeFileSync(
		join(instancesDir(apiDir()), "oc-evil.json"),
		JSON.stringify({
			id: "oc-evil",
			pid: process.pid,
			cwd: "/evil",
			startedAt: 0,
			protocol: 1,
			name: "octocode-agent-main-evil",
		}),
	);
}

describe("what a sender claims", () => {
	it("comes from its own API record: a planted record with the sender's pid changes nothing", async () => {
		const received = await listener("oc-peer", { id: "oc-peer", pid: process.ppid, name: "octocode-agent-main-peer" });
		const { send } = sender();
		plantSenderPid();
		await send("octocode-agent-main-peer");
		expect(received).toHaveLength(1);
		expect(received[0].from).toBe("octocode-agent-main-self");
		expect(received[0].caller).toMatchObject({ instanceId: "oc-self", name: "octocode-agent-main-self", cwd: "/w" });
	});

	it("carries a ticket that confirms only for the endpoint the call was sent to", async () => {
		const answers: unknown[] = [];
		const confirm = (params: Record<string, unknown>, via: string) => {
			try {
				return confirmIdentity({
					nonce: "n",
					ticket: (params.caller as { ticket: string }).ticket,
					to: "oc-peer",
					via,
				});
			} catch {
				return "refused";
			}
		};
		await listener(
			"oc-peer",
			{ id: "oc-peer", pid: process.ppid, name: "octocode-agent-main-peer" },
			(params, socket) => {
				answers.push(confirm(params, socket), confirm(params, `${socket}.other`));
			},
		);
		const { send } = sender();
		await send("octocode-agent-main-peer");
		expect(answers).toEqual([{ nonce: "n" }, "refused"]);
	});

	it("over an external connection, comes from its own API record too", async () => {
		const cwd = realpathSync(home);
		const sends: Record<string, unknown>[] = [];
		const socket = socketPath(apiDir(), "oc-target");
		const server = new ApiServer(
			async (method, params) => {
				if (method === "initialize")
					return {
						protocolVersion: 1,
						instance: { id: "oc-target", pid: process.ppid, cwd },
						capabilities: { wait: true },
					};
				if (method === "status") return { state: "idle", pending: false, sessionId: "live", cwd };
				if (method === "message.send") {
					sends.push(params);
					return { id: "x1", text: "done", stopReason: "stop" };
				}
				throw new Error(`unexpected ${method}`);
			},
			new EventLog(),
			"token",
		);
		await server.listenUnix(socket);
		servers.push({ server, socket });
		writeFileSync(
			join(instancesDir(apiDir()), "oc-target.json"),
			JSON.stringify({ id: "oc-target", pid: process.ppid, cwd, startedAt: Date.now(), protocol: 1, socket }),
		);
		sender();
		plantSenderPid();
		const backend = await OctocodeBackend.connect({ instanceId: "oc-target", cwd });
		await backend.prompt("hi", { timeoutMs: 1000 });
		await backend.close();
		expect(sends).toHaveLength(1);
		expect(sends[0].caller).toMatchObject({ instanceId: "oc-self", name: "octocode-agent-main-self", cwd: "/w" });
	});
});

describe("a team name addresses the process its live member runs", () => {
	it("reaches that process, and the call carries the sender's own team name", async () => {
		const received = await listener("oc-peer", { id: "oc-peer", pid: process.ppid, name: "octocode-agent-main-peer" });
		const { send } = sender([{ id: "shy-barnacle", pid: process.ppid }], "calm-otter");
		await expect(send("shy-barnacle")).resolves.toMatchObject({ details: { to: ["octocode-agent-main-peer"] } });
		expect(received).toHaveLength(1);
		expect(received[0].caller).toMatchObject({ team: "calm-otter", name: "octocode-agent-main-self" });
	});

	it("refuses an unknown team name and sends nothing", async () => {
		const received = await listener("oc-peer", { id: "oc-peer", pid: process.ppid, name: "octocode-agent-main-peer" });
		const { send } = sender([{ id: "shy-barnacle", pid: process.ppid }]);
		await expect(send("brave-lynx")).rejects.toThrow(/No running instance matches "brave-lynx"/);
		expect(received).toHaveLength(0);
	});

	it("refuses a team name whose process has several records, naming them", async () => {
		await listener("oc-a", { id: "oc-a", pid: process.ppid, name: "octocode-agent-main-a" });
		await listener("oc-b", { id: "oc-b", pid: process.ppid, name: "octocode-agent-main-b" });
		const { send } = sender([{ id: "shy-barnacle", pid: process.ppid }]);
		await expect(send("shy-barnacle")).rejects.toThrow(/Several instances run as shy-barnacle/);
	});
});
