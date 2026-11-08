import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createEventBus } from "@octocodeai/octocode-agent-core";
import type { ExtensionAPI } from "../../src/core/features/types.ts";
import { MCP_SESSION_SERVERS_FILE_ENV } from "../../../common/src/env.ts";
import { McpExtensionState } from "../../../mcp/src/state.ts";
import {
	parseMcpSessionServers,
	registerInheritedMcpServers,
	registerMcpAddedServers,
	serializeMcpSessionServers,
} from "../../../mcp/src/session-servers.ts";
import { getToolListError } from "../../src/core/settings-manager.ts";
import { isDefaultActive } from "../../../mcp/src/exposure.ts";
import { agentToolSpec } from "../../src/octocode/subagents/agent-tool.ts";
import { buildAgentArgs } from "../../src/octocode/subagents/process/session.ts";
import { resolveTaskServers } from "../../src/octocode/subagents/task-servers.ts";

const stdio = { command: "node", args: ["server.js"] };
const SESSION = { dir: "/s", id: "a" };

function session(available: string[], servers: Record<string, typeof stdio> = {}) {
	const events = createEventBus();
	registerMcpAddedServers(events, () => ({ servers, stopped: [], available }));
	return events;
}

/** The child's decision for a configured server, with its handoff file as the parent wrote it. */
function childLeavesOut(only: readonly string[] | undefined, name: string): boolean {
	const text = serializeMcpSessionServers({}, [], only);
	const parsed = text ? parseMcpSessionServers(text) : { stopped: [] as string[], only: undefined };
	const state = {
		parentStopped: new Set(parsed.stopped),
		taskServers: parsed.only ? new Set(parsed.only) : undefined,
		api: {},
	};
	return McpExtensionState.prototype.leavesOut.call(state, name);
}

describe("T6: per-task MCP servers (agent task `mcp`)", () => {
	it("declares an optional mcp list on the task", () => {
		const properties = agentToolSpec().parameters.properties;
		expect(properties.mcp).toBeDefined();
		expect(agentToolSpec().parameters.required).not.toContain("mcp");
	});

	it("a named server reaches the child; an unnamed one does not", () => {
		const events = session(["alpha", "beta", "gamma"], { alpha: stdio, beta: stdio });
		const plan = resolveTaskServers(events, ["alpha"], undefined, false);
		expect(plan.only).toEqual(["alpha"]);
		expect(plan.named).toEqual(["alpha"]);
		// The parent's added servers are narrowed before they are written.
		expect(Object.keys(plan.servers)).toEqual(["alpha"]);
		const file = parseMcpSessionServers(serializeMcpSessionServers(plan.servers, [], plan.only)!);
		expect(file.only).toEqual(["alpha"]);
		expect(childLeavesOut(plan.only, "alpha")).toBe(false);
		expect(childLeavesOut(plan.only, "beta")).toBe(true);
		expect(childLeavesOut(plan.only, "gamma")).toBe(true);
	});

	it("adds no pattern to a +name child list, which its parser refuses: the child's MCP host selects the server", () => {
		const args = buildAgentArgs(undefined, undefined, SESSION, [], undefined, ["alpha"]);
		const tools = args[args.indexOf("--tools") + 1];
		expect(tools).not.toContain("mcp__alpha");
		expect(getToolListError(tools.split(","))).toBeUndefined();
	});

	it("adds the named servers' pattern to a profile's allowlist", () => {
		const profile = { name: "r", description: "", prompt: "", tools: "read,grep" };
		const args = buildAgentArgs(profile, undefined, SESSION, [], undefined, ["alpha"]);
		const tools = args[args.indexOf("--tools") + 1];
		expect(tools.split(",")).toContain("mcp__alpha__*");
		expect(getToolListError(tools.split(","))).toBeUndefined();
	});

	it("refuses a tool list the child could not parse, before the child starts", () => {
		const profile = { name: "bad", description: "", prompt: "", tools: "+mcp__alpha__*" };
		expect(() => buildAgentArgs(profile, undefined, SESSION, [], undefined, ["alpha"])).toThrow(
			"not patterns: +mcp__alpha__*",
		);
	});

	it("refuses an unknown or disabled name with one line naming the configured servers", () => {
		const events = session(["alpha", "beta"]);
		expect(() => resolveTaskServers(events, ["nope"], undefined, false)).toThrow(
			'Unknown or disabled MCP server "nope"; configured servers: alpha, beta.',
		);
		expect(() => resolveTaskServers(session([]), ["nope"], undefined, false)).toThrow("configured servers: none.");
	});

	it("refuses a lean profile and a resumed child", () => {
		const events = session(["alpha"]);
		expect(() =>
			resolveTaskServers(events, ["alpha"], { name: "l", description: "", prompt: "", lean: true }, false),
		).toThrow("lean");
		expect(() => resolveTaskServers(events, ["alpha"], undefined, true)).toThrow("resume");
	});

	it("keeps the servers the profile names explicitly", () => {
		const events = session(["alpha", "browser"]);
		const profile = { name: "b", description: "", prompt: "", tools: "mcp__browser__*" };
		expect(resolveTaskServers(events, ["alpha"], profile, false).only).toEqual(["alpha", "browser"]);
		// A wildcard over every server names none of them.
		expect(resolveTaskServers(events, [], { ...profile, tools: "mcp__*" }, false).only).toEqual([]);
	});

	it("activates every tool only of a server the task named; an exact profile entry keeps its one tool", () => {
		const events = session(["alpha", "beta"]);
		const profile = { name: "e", description: "", prompt: "", tools: "+mcp__beta__echo" };
		const plan = resolveTaskServers(events, ["alpha"], profile, false);
		// Both servers run in the child: the task named alpha, the profile's own entry names beta.
		expect(plan.only).toEqual(["alpha", "beta"]);
		expect(plan.named).toEqual(["alpha"]);
		const file = parseMcpSessionServers(serializeMcpSessionServers(plan.servers, [], plan.only, plan.named)!);
		const taskNamed = new Set(file.named);
		const optIn = (name: string) => ({ name, source: "test", config: { command: "unused", defaultActive: false } });
		expect(isDefaultActive(optIn("alpha"), taskNamed)).toBe(true);
		expect(isDefaultActive(optIn("beta"), taskNamed)).toBe(false);
	});

	it("reads the list from the child's handoff file", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-task-servers-"));
		const file = path.join(dir, "servers.json");
		fs.writeFileSync(file, serializeMcpSessionServers({}, [], [])!);
		const api = { registerMcpServer: vi.fn() } as unknown as ExtensionAPI;
		expect(registerInheritedMcpServers(api, { OCTOCODE_SUBAGENT: "1", [MCP_SESSION_SERVERS_FILE_ENV]: file })).toEqual({
			stopped: [],
			only: [],
			named: [],
		});
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("without the field nothing changes", () => {
		expect(serializeMcpSessionServers({})).toBeUndefined();
		expect(childLeavesOut(undefined, "anything")).toBe(false);
		const args = buildAgentArgs(undefined, undefined, SESSION, []);
		expect(args).toEqual(buildAgentArgs(undefined, undefined, SESSION, [], undefined, []));
		expect(args[args.indexOf("--tools") + 1]).not.toContain("mcp__alpha");
	});
});
