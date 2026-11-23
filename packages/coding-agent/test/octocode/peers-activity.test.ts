import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeSharedAgentDb, sessions } from "../../../db/src/api.ts";
import { EventLog } from "../../src/octocode/api/events.ts";
import { ownInstance, publishOwnInstance } from "../../src/octocode/api/identity.ts";
import { apiDir, ensurePrivateDir, instancesDir, removeSocket, socketPath } from "../../src/octocode/api/registry.ts";
import { ApiServer } from "../../src/octocode/api/server.ts";
import { Peers } from "../../src/octocode/external/peers.ts";
import { sharedAgentDb } from "../../src/storage/database.ts";
import { tmp } from "./helpers.ts";

/**
 * `coordinate list` says what each other live session is doing with the light its own process wrote to the agent
 * database (RFC 2026-11-23-app-state, T4), not only whether its API answered busy or idle.
 */

let home: string;
const servers: { server: ApiServer; socket: string }[] = [];
beforeEach(() => {
	home = tmp("octocode-peers-activity-");
	vi.stubEnv("OCTOCODE_HOME", home);
	vi.stubEnv("OCTOCODE_AGENT_DB", join(home, "workspaces.db"));
	ensurePrivateDir(apiDir());
});
afterEach(async () => {
	publishOwnInstance(undefined, ownInstance());
	for (const { server, socket } of servers.splice(0)) {
		await server.close();
		removeSocket(socket);
	}
	closeSharedAgentDb();
	vi.unstubAllEnvs();
});

/** Another session's API record and socket; its status answers idle, as a session between turns does. */
async function peer(session: string) {
	const socket = socketPath(apiDir(), "oc-peer");
	const server = new ApiServer(
		async (method) => (method === "status" ? { state: "idle", pending: false } : undefined),
		new EventLog(),
		"token",
	);
	await server.listenUnix(socket);
	servers.push({ server, socket });
	const record = { id: "oc-peer", pid: process.ppid, name: "octocode-agent-main-peer", session };
	writeFileSync(
		join(instancesDir(apiDir()), "oc-peer.json"),
		JSON.stringify({ cwd: "/w", startedAt: Date.now(), protocol: 1, ...record, socket }),
	);
}

const peers = () => new Peers({ authorize: async () => undefined, notice: () => undefined }, process.env);

describe("coordinate list", () => {
	it("names another live session's light from its database row, while that process owns the row", async () => {
		await peer("peer-session");
		const db = sharedAgentDb().db;
		sessions.start(db, "peer-session", process.ppid, null, null);
		sessions.setActivity(db, "peer-session", process.ppid, "waiting");
		expect(await peers().list(home)).toContain("octocode-agent-main-peer · needs you · /w");
		sessions.setActivity(db, "peer-session", process.ppid, "error");
		expect(await peers().list(home)).toContain("octocode-agent-main-peer · failed · /w");
		// The row belongs to another process now (the session was resumed elsewhere): its light says nothing of this one.
		sessions.start(db, "peer-session", process.pid, null, null);
		sessions.setActivity(db, "peer-session", process.pid, "working");
		expect(await peers().list(home)).toContain("octocode-agent-main-peer · idle · /w");
	});
});
