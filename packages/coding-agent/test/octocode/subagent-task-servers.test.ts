import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createEventBus } from "@octocodeai/octocode-agent-core";
import type { FeatureSetup } from "../../src/core/features/types.ts";
import { MCP_SESSION_SERVERS_FILE_ENV } from "@octocodeai/octocode-common/env";
import { McpFeatureState } from "../../../mcp/src/state.ts";
import {
	parseMcpSessionServers,
	registerInheritedMcpServers,
	registerMcpAddedServers,
	serializeMcpSessionServers,
} from "../../../mcp/src/session-servers.ts";
import { getToolListError } from "../../src/core/settings-manager.ts";
import { isDefaultActive } from "../../../mcp/src/exposure.ts";
import { agentToolSpec } from "../../src/octocode/native/tools/agent/spec.ts";
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
	return McpFeatureState.prototype.leavesOut.call(state, name);
}

describe("T6: per-task MCP servers (agent task `mcp`)", () => {
	it("declares an optional mcp list on the task", () => {
		const properties = agentToolSpec().parameters.properties;
		expect(properties.mcp).toBeDefined();
		expect(agentToolSpec().parameters.required).not.toContain("mcp");
	});

	it("a named server reaches the child; an unnamed one does not", () => {
		const events = session(["alpha", "beta", "gamma"], { alpha: stdio, beta: stdio });
		const plan = resolveTaskServers(events, ["alpha"], undefined)!;
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
		expect(() => resolveTaskServers(events, ["nope"], undefined)).toThrow(
			'Unknown or disabled MCP server "nope"; configured servers: alpha, beta.',
		);
		expect(() => resolveTaskServers(session([]), ["nope"], undefined)).toThrow("configured servers: none.");
	});

	it("plans no servers for a lean profile and refuses a list for one", () => {
		const events = session(["alpha"]);
		const lean = { name: "l", description: "", prompt: "", lean: true as const };
		expect(resolveTaskServers(events, undefined, lean)).toBeUndefined();
		expect(() => resolveTaskServers(events, ["alpha"], lean)).toThrow("lean");
	});

	it("without a task list, gives a child only the servers its tools name; the session's others stay with the parent", () => {
		const events = session(["octocode", "freellama", "mine"], { mine: stdio });
		const plan = resolveTaskServers(events, undefined, undefined)!;
		expect(plan.only).not.toContain("freellama");
		expect(plan.only).not.toContain("mine");
		// The parent's added servers are left out of the handoff file too.
		expect(plan.servers).toEqual({});
		expect(childLeavesOut(plan.only, "mine")).toBe(true);
		const profile = (tools: string) => ({ name: "p", description: "", prompt: "", tools });
		expect(resolveTaskServers(events, undefined, profile("bash,file,mcp__freellama__*"))!.only).toContain("freellama");
		expect(resolveTaskServers(events, ["freellama"], undefined)!.only).toContain("freellama");
		// A broad mcp__* entry names no server.
		expect(resolveTaskServers(events, undefined, profile("bash,file,mcp__*"))!.only).not.toContain("freellama");
	});

	it("keeps the servers the profile names explicitly", () => {
		const events = session(["alpha", "browser"]);
		const profile = { name: "b", description: "", prompt: "", tools: "mcp__browser__*" };
		expect(resolveTaskServers(events, ["alpha"], profile)!.only).toEqual(["alpha", "browser"]);
		// A wildcard over every server names none of them.
		expect(resolveTaskServers(events, [], { ...profile, tools: "mcp__*" })!.only).toEqual([]);
	});

	it("activates every tool only of a server the task named; an exact profile entry keeps its one tool", () => {
		const events = session(["alpha", "beta"]);
		const profile = { name: "e", description: "", prompt: "", tools: "+mcp__beta__echo" };
		const plan = resolveTaskServers(events, ["alpha"], profile)!;
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
		const api = { registerMcpServer: vi.fn() } as unknown as FeatureSetup;
		expect(registerInheritedMcpServers(api, { OCTOCODE_SUBAGENT: "1", [MCP_SESSION_SERVERS_FILE_ENV]: file })).toEqual({
			stopped: [],
			only: [],
			named: [],
		});
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("a handoff file without a list leaves nothing out, and the args do not change", () => {
		expect(serializeMcpSessionServers({})).toBeUndefined();
		expect(childLeavesOut(undefined, "anything")).toBe(false);
		const args = buildAgentArgs(undefined, undefined, SESSION, []);
		expect(args).toEqual(buildAgentArgs(undefined, undefined, SESSION, [], undefined, []));
		expect(args[args.indexOf("--tools") + 1]).not.toContain("mcp__alpha");
	});
});
