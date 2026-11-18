import { afterEach, describe, expect, it, vi } from "vitest";
import { LATEST_PROTOCOL_VERSION } from "../src/client/index.ts";
import { createInMemoryTransportPair } from "../src/client/testing/index.ts";
import type { McpServerEntry } from "../src/config.ts";
import { SKILL_SNAPSHOT_FILE_ENV, SUBAGENT_ENV } from "../../common/src/env.ts";
import { mcpHost } from "./mcp-host-fixture.ts";
import { tmp } from "../../coding-agent/test/octocode/helpers.ts";

function workingTransport() {
	const pair = createInMemoryTransportPair();
	pair.server.onMessage((message) => {
		if (!("id" in message) || !("method" in message)) return;
		const result =
			message.method === "initialize"
				? {
						protocolVersion: LATEST_PROTOCOL_VERSION,
						capabilities: { tools: {} },
						serverInfo: { name: "f", version: "1" },
					}
				: { tools: [] };
		void pair.server.send({ jsonrpc: "2.0", id: message.id, result });
	});
	void pair.server.start();
	return pair.client;
}

/** A server whose launch names the session's skill folders. */
const rooted: McpServerEntry = {
	name: "rooted",
	source: "test",
	scope: "global",
	config: { command: "unused", env: { ALLOWED_PATHS: "${researchRoots}" } },
};

const hosts: ReturnType<typeof mcpHost>[] = [];
afterEach(async () => {
	vi.unstubAllEnvs();
	await Promise.all(hosts.splice(0).map((host) => host.close()));
});

/** A host whose skill folders are fixed before discovery, as a subagent's skill snapshot fixes them. */
function snapshotHost() {
	const launches: Array<string | undefined> = [];
	const skills = [tmp("snapshot-skill-")];
	const host = mcpHost({
		servers: [rooted],
		hasUI: false,
		createTransport: (entry) => {
			launches.push("command" in entry.config ? entry.config.env?.ALLOWED_PATHS : undefined);
			return workingTransport();
		},
	});
	hosts.push(host);
	host.api.resources.getSkillDirectories = () => [...skills];
	return { host, launches, skills };
}

const settle = async () => {
	for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
};

describe("MCP startup of a subagent on its coordinator's skill snapshot", () => {
	it("launches at session start, before discovery, once, with the snapshot's skill folders", async () => {
		vi.stubEnv(SUBAGENT_ENV, "1");
		vi.stubEnv(SKILL_SNAPSHOT_FILE_ENV, tmp("snapshot-file-"));
		const { host, launches, skills } = snapshotHost();
		await host.fire("session_start", {}, host.ctx);
		await settle();
		expect(launches).toHaveLength(1);
		expect(launches[0]).toContain(skills[0]);
		await host.fire(
			"resources_discover",
			{ type: "resources_discover", cwd: host.ctx.cwd, reason: "startup" },
			host.ctx,
		);
		await host.prompt();
		expect(launches).toHaveLength(1);
		expect(host.state.findServer("rooted")?.connection?.state).toBe("connected");
	});

	it("waits for discovery without a snapshot, as every other session does", async () => {
		vi.stubEnv(SUBAGENT_ENV, "1");
		vi.stubEnv(SKILL_SNAPSHOT_FILE_ENV, "");
		const { host, launches } = snapshotHost();
		await host.fire("session_start", {}, host.ctx);
		await settle();
		expect(launches).toEqual([]);
		await host.prompt();
		expect(launches).toHaveLength(1);
	});
});
