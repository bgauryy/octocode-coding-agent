import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LATEST_PROTOCOL_VERSION } from "../src/client/index.ts";
import { createInMemoryTransportPair } from "../src/client/testing/index.ts";
import type { McpServerEntry } from "../src/config.ts";
import { hostPaths, installMcpHost } from "../src/host.ts";
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
const original = hostPaths();
afterEach(async () => {
	await Promise.all(hosts.splice(0).map((host) => host.close()));
	installMcpHost({ paths: original });
});

/** A host that cannot say which skill folders discovery adds: its `${researchRoots}` launches wait for discovery. */
function unannounced(): void {
	const { announcedSkillRoots: _, ...paths } = original;
	installMcpHost({ paths });
}

/** A host that names the skill folders its resource discovery adds before it runs, as Octocode names its bundled ones. */
function announcing(): string {
	const root = fs.realpathSync(tmp("bundled-skills-"));
	installMcpHost({ paths: { ...original, announcedSkillRoots: () => [root] } });
	return root;
}

const settle = async () => {
	for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
};

/** A host whose skill folders grow when resources are discovered, as extensions' `resources_discover` paths do. */
function hostWithLateSkills(discovered: () => string = () => tmp("late-skill-")) {
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
		skills.push(discovered());
	});
	return { host, launches, skills };
}

const discover = (host: ReturnType<typeof mcpHost>) =>
	host.fire("resources_discover", { type: "resources_discover", cwd: host.ctx.cwd, reason: "startup" }, host.ctx);

describe("MCP startup", () => {
	it("launches each server once: after resource discovery, with the skill folders the first prompt also computes", async () => {
		unannounced();
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

	it("starts a launch that names no discovered folder at session start, before discovery", async () => {
		unannounced();
		const plain: McpServerEntry = { name: "plain", source: "test", scope: "global", config: { command: "unused" } };
		const launched: string[] = [];
		const host = mcpHost({
			servers: [rooted, plain],
			createTransport: (entry) => {
				launched.push(entry.name);
				return workingTransport();
			},
		});
		hosts.push(host);
		host.api.resources.getSkillDirectories = () => [];
		await host.fire("session_start", {}, host.ctx);
		// The other `session_start` handlers still run: the plain launch is the same before and after discovery.
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(launched).toEqual(["plain"]);
		expect(host.state.findServer("plain")?.connection?.state).toBe("connected");
		await host.fire(
			"resources_discover",
			{ type: "resources_discover", cwd: host.ctx.cwd, reason: "startup" },
			host.ctx,
		);
		await host.prompt();
		// Each launched once: the plain server is not started again at the first prompt.
		expect(launched).toEqual(["plain", "rooted"]);
		expect(host.state.findServer("rooted")?.connection?.state).toBe("connected");
	});

	it("does not wait for discovery when the first prompt comes first", async () => {
		unannounced();
		const { host, launches } = hostWithLateSkills();
		await host.fire("session_start", {}, host.ctx);
		await host.prompt();
		expect(launches).toHaveLength(1);
		expect(host.state.findServer("rooted")?.connection?.state).toBe("connected");
	});
});

describe("MCP startup when the host announces the skill folders discovery adds", () => {
	it("launches at session start, naming each announced folder whole, and once: discovery's skills inside them change nothing", async () => {
		const root = announcing();
		let n = 0;
		const { host, launches } = hostWithLateSkills(() => path.join(root, `skill-${++n}`));
		await host.fire("session_start", {}, host.ctx);
		// Other `session_start` handlers still run: the launch does not wait for discovery.
		await settle();
		expect(launches).toHaveLength(1);
		const roots = launches[0]?.split(",");
		expect(roots).toContain(root);
		await discover(host);
		await host.prompt();
		// The skills discovery loaded from inside the announced folder are already in reach: no second launch.
		expect(launches).toHaveLength(1);
		expect(roots).not.toContain(path.join(root, "skill-1"));
		expect(host.state.findServer("rooted")?.connection?.state).toBe("connected");
	});

	it("starts again at the first prompt when discovery adds a folder outside the announced ones", async () => {
		const root = announcing();
		const { host, launches, skills } = hostWithLateSkills();
		await host.fire("session_start", {}, host.ctx);
		await settle();
		expect(launches).toHaveLength(1);
		await discover(host);
		await host.prompt();
		// A feature's own discovery folder: the launch the prompt computes names it, so the server starts with it.
		expect(launches).toHaveLength(2);
		expect(launches[1]?.split(",")).toEqual(expect.arrayContaining([root, skills[0]]));
		expect(host.state.findServer("rooted")?.connection?.state).toBe("connected");
	});
});
