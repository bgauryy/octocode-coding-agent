import { realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FeatureContext } from "../../src/core/features/index.ts";
import { EventLog } from "../../src/octocode/api/events.ts";
import { ownInstance, publishOwnInstance } from "../../src/octocode/api/identity.ts";
import { apiDir, ensurePrivateDir, instancesDir, removeSocket, socketPath } from "../../src/octocode/api/registry.ts";
import { ApiServer } from "../../src/octocode/api/server.ts";
import { Peers } from "../../src/octocode/external/peers.ts";
import { tmp } from "./helpers.ts";

let home: string;
let closing: Array<() => Promise<void>> = [];
beforeEach(() => {
	home = tmp("octocode-peers-label-");
	vi.stubEnv("OCTOCODE_HOME", home);
	ensurePrivateDir(apiDir());
});
afterEach(async () => {
	vi.unstubAllEnvs();
	publishOwnInstance(undefined, ownInstance());
	for (const close of closing.splice(0)) await close();
	closing = [];
});

const PROCESS = "octocode-agent-main-608ca23d";

async function peer() {
	const socket = socketPath(apiDir(), "oc-peer");
	const server = new ApiServer(
		async (method) => (method === "message.send" ? { queued: "accepted" } : undefined),
		new EventLog(),
		"token",
	);
	await server.listenUnix(socket);
	closing.push(async () => {
		await server.close();
		removeSocket(socket);
	});
	writeFileSync(
		join(instancesDir(apiDir()), "oc-peer.json"),
		JSON.stringify({ id: "oc-peer", pid: process.ppid, cwd: "/w", startedAt: 1, protocol: 1, name: PROCESS, socket }),
	);
}

function sender() {
	const self = {
		id: "oc-self",
		pid: process.pid,
		cwd: "/w",
		startedAt: 1,
		protocol: 1,
		name: "octocode-agent-main-self",
	};
	writeFileSync(join(instancesDir(apiDir()), "oc-self.json"), JSON.stringify(self));
	publishOwnInstance(self);
	const peers = new Peers(
		{
			authorize: async () => undefined,
			notice: () => undefined,
			members: () => [{ id: "perky-lagoon", pid: process.ppid }],
		},
		process.env,
	);
	const ctx = { cwd: realpathSync(home) } as unknown as FeatureContext;
	return (to: string) => peers.send(to, "hello", {}, ctx);
}

describe("a peer's label", () => {
	it("names the team member and its process when sent by agent name", async () => {
		await peer();
		const sent = await sender()("perky-lagoon");
		expect(sent.text).toContain(`perky-lagoon (process ${PROCESS})`);
		expect(sent.details).toMatchObject({ member: "perky-lagoon", process: PROCESS });
	});

	it("names the process alone when sent by process name", async () => {
		await peer();
		const sent = await sender()(PROCESS);
		expect(sent.text).toContain(PROCESS);
		expect(sent.text).not.toContain("perky-lagoon");
		expect(sent.details).toMatchObject({ process: PROCESS });
		expect(sent.details).not.toHaveProperty("member");
	});
});
