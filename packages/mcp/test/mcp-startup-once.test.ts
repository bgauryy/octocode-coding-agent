import { afterEach, describe, expect, it } from "vitest";
import { LATEST_PROTOCOL_VERSION } from "../src/client/index.ts";
import { createInMemoryTransportPair } from "../src/client/testing/index.ts";
import type { McpServerEntry } from "../src/config.ts";
import { mcpHost } from "./mcp-host-fixture.ts";
import { tmp } from "../../coding-agent/test/octocode/helpers.ts";

/** An in-memory server that answers `initialize` and an empty tool list. */
function workingTransport() {
	const pair = createInMemoryTransportPair();
	pair.server.onMessage((message) => {
		if (!("id" in message) || !("method" in message)) return;
		const result =
			message.method === "initialize"
				? {
						protocolVersion: LATEST_PROTOCOL_VERSION,
						capabilities: { tools: {} },
						serverInfo: { name: "fake", version: "1" },
					}
				: { tools: [] };
		void pair.server.send({ jsonrpc: "2.0", id: message.id, result });
	});
	void pair.server.start();
	return pair.client;
}

/** A server whose launch names the session's skill folders, which the host completes only at resource discovery. */
const rooted: McpServerEntry = {
	name: "rooted",
	source: "test",
	scope: "global",
	config: { command: "unused", env: { ALLOWED_PATHS: "${researchRoots}" } },
};

const hosts: ReturnType<typeof mcpHost>[] = [];
afterEach(async () => {
	await Promise.all(hosts.splice(0).map((host) => host.close()));
});

/** A host whose skill folders grow when resources are discovered, as extensions' `resources_discover` paths do. */
function hostWithLateSkills() {
	const launches: Array<string | undefined> = [];
	const skills: string[] = [];
	const host = mcpHost({
		servers: [rooted],
		createTransport: (entry) => {
			launches.push("command" in entry.config ? entry.config.env?.ALLOWED_PATHS : undefined);
			return workingTransport();
		},
	});
	hosts.push(host);
	host.api.resources.getSkillDirectories = () => [...skills];
	host.api.bus.on("resources_discover", () => {
		skills.push(tmp("late-skill-"));
	});
	return { host, launches, skills };
}

describe("MCP startup", () => {
	it("launches each server once: after resource discovery, with the skill folders the first prompt also computes", async () => {
		const { host, launches, skills } = hostWithLateSkills();
		await host.fire("session_start", {}, host.ctx);
		// Other extensions' `session_start` handlers take a while (I/O) before the host discovers resources.
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(launches).toEqual([]);
		await host.fire(
			"resources_discover",
			{ type: "resources_discover", cwd: host.ctx.cwd, reason: "startup" },
			host.ctx,
		);
		await host.prompt();
		expect(launches).toHaveLength(1);
		expect(launches[0]).toContain(skills[0]);
		expect(host.state.findServer("rooted")?.connection?.state).toBe("connected");
	});

	it("does not wait for discovery when the first prompt comes first", async () => {
		const { host, launches } = hostWithLateSkills();
		await host.fire("session_start", {}, host.ctx);
		await host.prompt();
		expect(launches).toHaveLength(1);
		expect(host.state.findServer("rooted")?.connection?.state).toBe("connected");
	});
});
