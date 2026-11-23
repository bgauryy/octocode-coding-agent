import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { tmp } from "../../coding-agent/test/octocode/helpers.ts";
import type { McpServerEntry } from "../src/config.ts";
import { deferRolesFromEnv } from "../src/deferral.ts";
import { mcpHost } from "./mcp-host-fixture.ts";

/**
 * A child whose profile sets `mcpDefer: readOnly` defers the open tools its server config lists under `roles.readOnly`:
 * they are declared thin, listed by name in the server's block, and stay callable. Other tools are declared in full.
 */
const echo = join(import.meta.dirname, "../../coding-agent/test/octocode/fixtures/echo-mcp.mjs");
const hosts: ReturnType<typeof mcpHost>[] = [];
afterEach(async () => {
	await Promise.all(hosts.splice(0).map((h) => h.close()));
	vi.unstubAllEnvs();
});

const entry = (config: Partial<McpServerEntry["config"]> = {}): McpServerEntry => ({
	name: "docs",
	config: {
		command: "echo",
		description: "docs purpose line",
		roles: { readOnly: ["shout", "pick"], reader: ["localFetch"] },
		...config,
	} as McpServerEntry["config"],
	source: "test",
});

function host(server: McpServerEntry, options: Parameters<typeof mcpHost>[0] = {}) {
	vi.stubEnv("OCTOCODE_CODING_AGENT_DIR", tmp());
	const h = mcpHost({
		servers: [server],
		prepareLaunch: (launched) => ({
			...launched,
			config: { ...launched.config, command: process.execPath, args: [echo] },
		}),
		presentation: "compact",
		// Roles defer from a direct baseline; the default (`recent`) would defer every unused tool.
		exposure: "direct",
		...options,
	});
	h.api.tools.getActive = () =>
		[...h.tools.values()].filter((tool) => tool.exposure !== "hidden").map((tool) => tool.name);
	hosts.push(h);
	return h;
}

const text = (result: { content: Array<{ type: string; text?: string }> }) =>
	result.content.map((part) => part.text ?? "").join("");
const declaredBytes = (h: ReturnType<typeof mcpHost>) =>
	JSON.stringify(
		[...h.tools.values()]
			.filter((tool) => tool.name.startsWith("mcp__docs__"))
			.map(({ name, description, parameters }) => ({ name, description, parameters })),
	).length;

async function sessionOf(server: McpServerEntry, options: Parameters<typeof mcpHost>[0] = {}) {
	const h = host(server, options);
	await h.start();
	const sections = await h.prompt();
	return { h, mcps: sections.mcps ?? "", bytes: declaredBytes(h) };
}

describe("mcpDefer roles", () => {
	it("defers the tools listed under the role: fewer MCP bytes, still callable", async () => {
		const plain = await sessionOf(entry());
		const deferred = await sessionOf(entry(), { deferRoles: ["readOnly"] });
		expect(deferred.mcps).toContain("\n- shout: Uppercase the given text\n");
		expect(deferred.mcps).toContain("\n- pick:");
		expect(plain.mcps).not.toContain("\n- shout:");
		// reader tools stay direct: only the readOnly list is deferred
		expect(deferred.mcps).not.toContain("\n- localFetch:");
		// the full text of a deferred tool (generated declaration) leaves the prompt
		expect(plain.mcps).toContain("function shout(");
		expect(deferred.mcps).not.toContain("function shout(");
		expect(deferred.mcps).toContain("function localFetch(");
		// Deferral shrinks the server's block. The section's guidance for deferred tools is one line per prompt whatever
		// their number (`sections/mcps.md`, lengthened on purpose), more than this fixture's two small schemas save.
		const block = (mcps: string) => mcps.slice(mcps.indexOf('<mcp name="docs"'));
		expect(block(deferred.mcps).length).toBeLessThan(block(plain.mcps).length);
		const shout = deferred.h.tools.get("mcp__docs__shout");
		expect(shout.description).toBe("Uppercase the given text");
		expect(text(await deferred.h.call("mcp__docs__shout", { text: "hi" }))).toContain("HI");
		const loaded = text(await deferred.h.call("mcp", { intent: "tools", server: "docs", tool: "shout" }));
		expect(loaded).toContain("shout [deferred]");
	});

	it("defers a judge tool with the readOnly role, as when it was listed there", async () => {
		const { mcps } = await sessionOf(
			entry({ roles: { reader: ["localFetch"], judge: ["shout"], readOnly: ["pick"] } }),
			{
				deferRoles: ["readOnly"],
			},
		);
		expect(mcps).toContain("\n- shout:");
		expect(mcps).toContain("\n- pick:");
		expect(mcps).toContain("function localFetch(");
	});

	it("leaves a tool with its own direct exposure declared in full", async () => {
		const { mcps } = await sessionOf(entry({ toolExposure: { shout: "direct" } }), { deferRoles: ["readOnly"] });
		expect(mcps).not.toContain("\n- shout:");
		expect(mcps).toContain("\n- pick:");
	});

	it("defers the role's tools even when the server's own exposure is direct", async () => {
		const { mcps } = await sessionOf(entry({ exposure: "direct" }), { deferRoles: ["readOnly"] });
		expect(mcps).toContain("\n- shout:");
		expect(mcps).not.toContain("function shout(");
		expect(mcps).toContain("function localFetch(");
	});

	it("reads the roles a subagent's profile put in its environment", async () => {
		expect(deferRolesFromEnv({ OCTOCODE_MCP_DEFER_ROLES: "readOnly" })).toEqual(["readOnly"]);
		expect(deferRolesFromEnv({ OCTOCODE_MCP_DEFER_ROLES: "bogus" })).toEqual([]);
		vi.stubEnv("OCTOCODE_SUBAGENT", "1");
		vi.stubEnv("OCTOCODE_MCP_DEFER_ROLES", "readOnly");
		const { mcps } = await sessionOf(entry());
		expect(mcps).toContain("\n- shout:");
	});
});
