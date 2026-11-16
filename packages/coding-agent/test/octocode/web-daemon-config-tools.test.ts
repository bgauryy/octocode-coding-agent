import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	NATIVE_PINNABLE_TOOLS,
	ToolExposureListSchema,
	type ToolExposureList,
	type ToolPinCommand,
} from "@octocodeai/octocode-contracts/config";
import { Value } from "typebox/value";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfigAuditEntry } from "../../../db/src/api.ts";
import { projectMcpConfigPath } from "../../../mcp/src/paths.ts";
import type { McpServerToolStates } from "../../../mcp/src/tool-states.ts";
import { DEFERRABLE_NATIVE_TOOLS, nativeToolDeferred } from "../../src/octocode/permission/native-deferral.ts";
import { ConfigWriteError } from "../../src/octocode/web-daemon/config-write.ts";
import { startDaemonServer, type DaemonServer } from "../../src/octocode/web-daemon/server.ts";
import { listToolExposure, pinTool } from "../../src/octocode/web-daemon/tool-exposure.ts";
import { UsageRecorder, USAGE_FILE_NAME } from "@octocodeai/octocode-common/usage-counts";
import { trustFolder } from "./helpers.ts";
import { isolatedEnv } from "./web-daemon-fixture.ts";

let root: string;
let agentDir: string;
let cwd: string;
const cleanup: Array<() => Promise<void> | void> = [];
const audits: ConfigAuditEntry[] = [];

const writeJson = (file: string, value: unknown) => {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify(value));
};
const readJson = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"));
const globalSettings = () => path.join(agentDir, "settings.json");
const globalMcp = () => path.join(agentDir, "mcp.json");
const group = (list: ToolExposureList, name: string) => list.groups.find((entry) => entry.name === name);
const tool = (list: ToolExposureList, groupName: string, name: string) =>
	group(list, groupName)?.tools.find((entry) => entry.name === name);
const options = () => ({ agentDir, actor: "web:test", audit: (entry: ConfigAuditEntry) => audits.push(entry) });
const refusal = (promise: Promise<unknown>) =>
	promise.then(
		() => undefined,
		(error: unknown) => error,
	);
/** A running session that has `docs` connected and declares `read` deferred by recent use. */
const session: McpServerToolStates[] = [
	{
		server: "docs",
		connected: true,
		saved: true,
		tools: [
			{ name: "search", state: "direct", decidedBy: "recent" },
			{ name: "read", state: "deferred", decidedBy: "recent" },
		],
	},
	{ server: "ext", connected: true, saved: false, tools: [{ name: "run", state: "direct", decidedBy: "default" }] },
];

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "octocode-config-tools-"));
	agentDir = path.join(root, "agent");
	cwd = path.join(root, "work");
	fs.mkdirSync(agentDir);
	fs.mkdirSync(path.join(cwd, ".octocode"), { recursive: true });
	// Its own home and agent database: the suite's default one trusts the whole temp folder.
	vi.stubEnv("HOME", path.join(root, "user"));
	vi.stubEnv("OCTOCODE_HOME", path.join(root, "home"));
	writeJson(globalMcp(), { mcpServers: { docs: { command: "docs-server", toolExposure: { legacy: "hidden" } } } });
	audits.length = 0;
});
afterEach(async () => {
	vi.unstubAllEnvs();
	for (const fn of cleanup.splice(0).reverse()) await fn();
	fs.rmSync(root, { recursive: true, force: true });
});

describe("tool exposure usage audit", () => {
	it("orders native rows unused first, then by rate, and reports usage as the decider with its reason and savings", async () => {
		writeJson(globalSettings(), { mcpExposure: "usage" });
		const file = path.join(agentDir, USAGE_FILE_NAME);
		const seed = (name: string, declaring: number, callers: number, refusals = 0) => {
			for (let i = 0; i < declaring; i++) {
				const recorder = new UsageRecorder(
					() => file,
					() => "main",
				);
				recorder.record("declared", [`native/${name}`]);
				if (i < callers) recorder.record("called", [`native/${name}`]);
				if (i === 0) for (let r = 0; r < refusals; r++) recorder.record("refused", [`native/${name}`]);
			}
		};
		seed("web", 25, 5);
		seed("archive", 25, 0);
		seed("models", 3, 1, 3);
		seed("backlogPlan", 25, 1);
		const list = await listToolExposure({
			agentDir,
			native: () => ({
				names: [...NATIVE_PINNABLE_TOOLS, "bash"],
				declared: new Map([
					["web", false],
					["archive", true],
					["models", false],
					["backlogPlan", true],
				]),
				saved: new Map(NATIVE_PINNABLE_TOOLS.map((name) => [name, 700])),
			}),
		});
		expect(Value.Check(ToolExposureListSchema, list)).toBe(true);
		const rows = group(list, "native")!.tools;
		expect(rows.map((row) => row.name)).toEqual(["archive", "backlogPlan", "web", "models", "bash"]);
		expect(rows.slice(0, 4).map((row) => row.decidedBy)).toEqual(["usage", "usage", "usage", "usage"]);
		expect(tool(list, "native", "archive")?.audit).toMatchObject({ reason: "unused", rate: 0, bytesSaved: 700 });
		expect(tool(list, "native", "backlogPlan")?.audit).toMatchObject({ bytesSaved: 700, called: 1 });
		expect(tool(list, "native", "backlogPlan")?.audit?.reason).toBeUndefined();
		expect(tool(list, "native", "web")?.audit).toMatchObject({ reason: "promoted", rate: 0.2, bytesSaved: 0 });
		expect(tool(list, "native", "models")?.audit).toMatchObject({ reason: "promoted", refused: 3 });
		expect(tool(list, "native", "bash")?.audit).toBeUndefined();
	});
});

describe("audit rows of the usage-only native tools", () => {
	const live = {
		names: [...NATIVE_PINNABLE_TOOLS, "memory", "wait", "bash"],
		declared: new Map([
			["memory", true],
			["wait", false],
		]),
		saved: new Map([["memory", 400]]),
	};
	const seed = (name: string, declaring: number, callers: number) => {
		for (let i = 0; i < declaring; i++) {
			const recorder = new UsageRecorder(
				() => path.join(agentDir, USAGE_FILE_NAME),
				() => "main",
			);
			recorder.record("declared", [`native/${name}`]);
			if (i < callers) recorder.record("called", [`native/${name}`]);
		}
	};

	it("shows memory and timer with their audit under usage", async () => {
		writeJson(globalSettings(), { mcpExposure: "usage" });
		seed("memory", 25, 0);
		seed("wait", 25, 10);
		const list = await listToolExposure({ agentDir, native: () => live });
		expect(Value.Check(ToolExposureListSchema, list)).toBe(true);
		expect(tool(list, "native", "memory")).toMatchObject({ state: "deferred", decidedBy: "usage" });
		expect(tool(list, "native", "memory")?.audit).toMatchObject({ reason: "unused", rate: 0, bytesSaved: 400 });
		expect(tool(list, "native", "wait")).toMatchObject({ state: "direct" });
		expect(tool(list, "native", "wait")?.audit).toMatchObject({ reason: "promoted", rate: 0.4 });
	});

	it("shows them when pinned under another setting, and lists an unpinned one as a core tool otherwise", async () => {
		writeJson(globalSettings(), { mcpExposure: "recent", nativeToolExposure: { memory: "deferred" } });
		seed("memory", 3, 1);
		const list = await listToolExposure({ agentDir, native: () => live });
		expect(tool(list, "native", "memory")).toMatchObject({ pin: "deferred", state: "deferred", decidedBy: "pin" });
		expect(tool(list, "native", "memory")?.audit).toMatchObject({ called: 1, declared: 3 });
		// Unpinned and not under usage, timer is a plain core row with no audit.
		expect(tool(list, "native", "wait")).toMatchObject({ decidedBy: "core" });
		expect(tool(list, "native", "wait")?.audit).toBeUndefined();
	});
});

describe("tool exposure read model", () => {
	it("lists the deferrable native tools with their pin and what a new session would declare", async () => {
		expect([...NATIVE_PINNABLE_TOOLS].sort()).toEqual([...DEFERRABLE_NATIVE_TOOLS].sort());
		// No setting: `recent`, and a working directory that called nothing defers every deferrable tool.
		const unset = await listToolExposure({ agentDir });
		expect(Value.Check(ToolExposureListSchema, unset)).toBe(true);
		expect(unset).toMatchObject({ setting: "recent", live: false });
		expect(group(unset, "native")?.tools).toEqual(
			NATIVE_PINNABLE_TOOLS.map((name) => ({ name, state: "deferred", decidedBy: "recent" })),
		);
		writeJson(globalSettings(), { mcpExposure: "direct" });
		const direct = await listToolExposure({ agentDir });
		expect(direct).toMatchObject({ setting: "direct", live: false });
		expect(group(direct, "native")?.tools).toEqual(
			NATIVE_PINNABLE_TOOLS.map((name) => ({ name, state: "direct", decidedBy: "default" })),
		);

		writeJson(globalSettings(), { mcpExposure: "recent", nativeToolExposure: { models: "direct", web: "deferred" } });
		writeJson(path.join(agentDir, "tool-use.json"), {
			[cwd]: { "native/archive": Date.now(), "native/web": Date.now() },
		});
		trustFolder(cwd);
		const recent = await listToolExposure({ agentDir, cwd });
		expect(recent.setting).toBe("recent");
		expect(group(recent, "native")?.tools).toEqual([
			{ name: "web", pin: "deferred", state: "deferred", decidedBy: "pin" },
			{ name: "archive", state: "direct", decidedBy: "recent" },
			{ name: "models", pin: "direct", state: "direct", decidedBy: "pin" },
			{ name: "backlogPlan", state: "deferred", decidedBy: "recent" },
		]);
	});

	it("predicts what the session's own rule decides", async () => {
		// The page cannot import the rule's owner, so this keeps its copy from drifting: same record, same key, same pins.
		vi.stubEnv("OCTOCODE_CODING_AGENT_DIR", agentDir);
		const here = process.cwd();
		writeJson(path.join(agentDir, "tool-use.json"), { [here]: { "native/models": Date.now() } });
		for (const settings of [
			{},
			{ mcpExposure: "recent" },
			{ mcpExposure: "recent", nativeToolExposure: { web: "direct", models: "deferred" } },
			{ mcpExposure: "deferred", nativeToolExposure: { archive: "deferred" } },
		]) {
			writeJson(globalSettings(), settings);
			const list = await listToolExposure({ agentDir, cwd: here });
			for (const name of NATIVE_PINNABLE_TOOLS)
				expect(tool(list, "native", name)?.state, `${name} ${JSON.stringify(settings)}`).toBe(
					nativeToolDeferred(name, settings, {}) ? "deferred" : "direct",
				);
		}
	});

	it("shows what the running session declared, core tools as always direct, and a pin that waits for the next session", async () => {
		writeJson(globalSettings(), { mcpExposure: "recent", nativeToolExposure: { web: "deferred" } });
		const list = await listToolExposure({
			agentDir,
			native: () => ({ names: ["bash", "web", "file", "mcp"], declared: new Map([["web", false]]) }),
			mcp: () => session,
		});
		expect(Value.Check(ToolExposureListSchema, list)).toBe(true);
		expect(list.live).toBe(true);
		// Pinned after the session registered the tool: the session still declares it in full.
		expect(tool(list, "native", "web")).toEqual({ name: "web", pin: "deferred", state: "direct", decidedBy: "recent" });
		expect(tool(list, "native", "bash")).toEqual({ name: "bash", state: "direct", decidedBy: "core" });
		expect(tool(list, "native", "mcp")).toEqual({ name: "mcp", state: "direct", decidedBy: "core" });
		expect(group(list, "native")?.tools.filter((row) => row.name === "web")).toHaveLength(1);
	});

	it("lists a server's tools from the session, its saved pins, and a server that cannot be pinned", async () => {
		const live = await listToolExposure({ agentDir, mcp: () => session });
		expect(group(live, "docs")).toEqual({
			kind: "mcp",
			name: "docs",
			pinnable: true,
			tools: [
				{ name: "search", state: "direct", decidedBy: "recent" },
				{ name: "read", state: "deferred", decidedBy: "recent" },
				{ name: "legacy", pin: "hidden", state: "hidden", decidedBy: "pin" },
			],
		});
		expect(group(live, "ext")).toMatchObject({ pinnable: false, tools: [{ name: "run" }] });
		expect(group(live, "ext")?.note).toBeTruthy();

		const cold = await listToolExposure({ agentDir });
		expect(group(cold, "docs")?.tools).toEqual([{ name: "legacy", pin: "hidden", state: "hidden", decidedBy: "pin" }]);
		expect(group(cold, "docs")?.note).toContain("No session is running");
		expect(group(cold, "ext")).toBeUndefined();

		writeJson(globalMcp(), { mcpServers: { docs: { command: "docs-server", enabled: false } } });
		expect(group(await listToolExposure({ agentDir }), "docs")).toBeUndefined();
	});
});

describe("tool pins", () => {
	it("pins and unpins a native tool in the settings file and keeps the other keys", async () => {
		writeJson(globalSettings(), { theme: "dark", nativeToolExposure: { archive: "direct" } });
		const pinned = await pinTool({ kind: "native", tool: "web", pin: "deferred", scope: "global" }, options());
		expect(readJson(globalSettings())).toEqual({
			theme: "dark",
			nativeToolExposure: { archive: "direct", web: "deferred" },
		});
		expect(tool(pinned, "native", "web")).toMatchObject({ pin: "deferred", state: "deferred", decidedBy: "pin" });
		expect(pinned.message).toContain("next session");

		await pinTool({ kind: "native", tool: "web", pin: null, scope: "global" }, options());
		const cleared = await pinTool({ kind: "native", tool: "archive", pin: null, scope: "global" }, options());
		expect(readJson(globalSettings())).toEqual({ theme: "dark" });
		// Unpinned, the default `mcpExposure` (`recent`) decides: never called here, so deferred.
		expect(tool(cleared, "native", "web")).toEqual({ name: "web", state: "deferred", decidedBy: "recent" });
		expect(audits.map((entry) => [entry.action, entry.target, entry.afterKind, entry.outcome])).toEqual([
			["tool.pin", "native:web", "deferred", "ok"],
			["tool.pin", "native:web", "unpinned", "ok"],
			["tool.pin", "native:archive", "unpinned", "ok"],
		]);
	});

	it("pins and unpins an MCP tool in the server's file and leaves the running session's state alone", async () => {
		const live = { ...options(), mcp: () => session };
		const pinned = await pinTool({ kind: "mcp", server: "docs", tool: "read", pin: "direct", scope: "global" }, live);
		expect(readJson(globalMcp()).mcpServers.docs).toEqual({
			command: "docs-server",
			toolExposure: { legacy: "hidden", read: "direct" },
		});
		// The session declared it deferred and keeps that; the pin is what the next session reads.
		expect(tool(pinned, "docs", "read")).toEqual({
			name: "read",
			pin: "direct",
			state: "deferred",
			decidedBy: "recent",
		});

		await pinTool({ kind: "mcp", server: "docs", tool: "read", pin: null, scope: "global" }, live);
		await pinTool({ kind: "mcp", server: "docs", tool: "legacy", pin: null, scope: "global" }, live);
		expect(readJson(globalMcp()).mcpServers.docs).toEqual({ command: "docs-server" });
	});

	it("writes a workspace pin as an override that keeps the pins of the server it overrides", async () => {
		trustFolder(cwd);
		const command: ToolPinCommand = { kind: "mcp", server: "docs", tool: "read", pin: "deferred", scope: "workspace" };
		const list = await pinTool(command, { ...options(), cwd });
		expect(readJson(projectMcpConfigPath(cwd)).mcpServers.docs).toEqual({
			toolExposure: { legacy: "hidden", read: "deferred" },
		});
		expect(readJson(globalMcp()).mcpServers.docs.toolExposure).toEqual({ legacy: "hidden" });
		expect(group(list, "docs")?.tools.map((row) => [row.name, row.pin])).toEqual([
			["legacy", "hidden"],
			["read", "deferred"],
		]);
	});

	it("refuses a workspace pin without a trusted workspace, an unknown server and an invalid settings file", async () => {
		const native: ToolPinCommand = { kind: "native", tool: "web", pin: "deferred", scope: "workspace" };
		expect(await refusal(pinTool(native, options()))).toMatchObject({ status: 400 });
		const untrusted = await refusal(pinTool(native, { ...options(), cwd }));
		expect(untrusted).toBeInstanceOf(ConfigWriteError);
		expect(untrusted).toMatchObject({ status: 403 });
		expect(
			await refusal(
				pinTool(
					{ kind: "mcp", server: "docs", tool: "read", pin: "direct", scope: "workspace" },
					{ ...options(), cwd },
				),
			),
		).toMatchObject({ status: 403 });
		expect(
			await refusal(pinTool({ kind: "mcp", server: "nope", tool: "read", pin: "direct", scope: "global" }, options())),
		).toMatchObject({ status: 404 });
		fs.writeFileSync(globalSettings(), "{ not json");
		expect(await refusal(pinTool({ ...native, scope: "global" }, options()))).toMatchObject({ status: 409 });
		expect(fs.readFileSync(globalSettings(), "utf8")).toBe("{ not json");
		expect(fs.existsSync(path.join(cwd, ".octocode", "settings.json"))).toBe(false);
		expect(fs.existsSync(projectMcpConfigPath(cwd))).toBe(false);
		expect(audits).toHaveLength(5);
		expect(audits.every((entry) => entry.outcome === "refused")).toBe(true);
	});
});

describe("/api/admin/config/tools", () => {
	async function daemon() {
		const { env } = isolatedEnv();
		const server: DaemonServer = await startDaemonServer({
			env,
			onActivity: () => {},
			config: async () => ({}),
			tools: () => listToolExposure({ agentDir }),
			writeTools: (command) => pinTool(command, options()),
			onDrain: () => {},
		});
		cleanup.push(() => server.close());
		const call = (token: string, body?: unknown) =>
			fetch(`http://127.0.0.1:${server.port}/api/admin/config/tools`, {
				method: body === undefined ? "GET" : "POST",
				headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			});
		return { server, call };
	}

	it("lists and pins for the launch token only, and writes nothing for a refused link", async () => {
		const { server, call } = await daemon();
		const pin = { kind: "native", tool: "web", pin: "deferred", scope: "global" };
		for (const token of [server.remoteToken, server.viewToken, "wrong"]) {
			expect([401, 403]).toContain((await call(token)).status);
			expect([401, 403]).toContain((await call(token, pin)).status);
		}
		expect((await call(server.remoteToken, pin)).status).toBe(403);
		expect(fs.existsSync(globalSettings())).toBe(false);
		expect(audits).toHaveLength(0);

		const listed = await call(server.token);
		expect(listed.status).toBe(200);
		expect(Value.Check(ToolExposureListSchema, await listed.json())).toBe(true);
		const pinned = await call(server.token, pin);
		expect(pinned.status).toBe(200);
		expect(tool((await pinned.json()) as ToolExposureList, "native", "web")?.pin).toBe("deferred");
		expect(readJson(globalSettings())).toEqual({ nativeToolExposure: { web: "deferred" } });
	});

	it("refuses a body that is not one pin", async () => {
		const { server, call } = await daemon();
		for (const bad of [
			{ kind: "native", tool: "bash", pin: "deferred", scope: "global" },
			{ kind: "native", tool: "web", pin: "hidden", scope: "global" },
			{ kind: "mcp", server: "docs", tool: "*", pin: "hidden", scope: "global" },
			{ kind: "mcp", server: "docs", tool: "read", pin: "direct", scope: "global", file: "/etc/passwd" },
			{ kind: "native", tool: "web", pin: "direct", scope: "workspace", repoId: "../x" },
		])
			expect((await call(server.token, bad)).status).toBe(400);
		expect(
			(await call(server.token, { kind: "native", tool: "web", pin: "direct", scope: "workspace", repoId: "nope" }))
				.status,
		).toBe(404);
		expect(fs.existsSync(globalSettings())).toBe(false);
	});
});
