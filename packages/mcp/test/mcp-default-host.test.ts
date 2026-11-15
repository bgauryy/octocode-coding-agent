import { approveFixtureMcp } from "../../coding-agent/test/octocode/guard-helpers.ts";
import { planningRefusal } from "../../coding-agent/src/octocode/plan/gate.ts";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadMcpConfig } from "../src/config.ts";
import { type McpServerPreset, presetEntries } from "../src/preset.ts";
import { recommendedPresets } from "../src/recommended/index.ts";
import { defaultPreset } from "./mcp-default-preset.ts";
import { saveConfig, setExposure } from "../src/persistence.ts";
import { reconnect } from "../src/connections.ts";
import { getMcpSessionStatus } from "../src/status.ts";
import { mcpHost } from "./mcp-host-fixture.ts";
import { tmp } from "../../coding-agent/test/octocode/helpers.ts";

const echo = join(import.meta.dirname, "../../coding-agent/test/octocode/fixtures/echo-mcp.mjs");
const progress = join(import.meta.dirname, "../../coding-agent/test/octocode/fixtures/progress-mcp.mjs");
const defaults = () => presetEntries([defaultPreset({})]);
const hosts: ReturnType<typeof mcpHost>[] = [];
const host = (options: Parameters<typeof mcpHost>[0] = {}) => {
	const result = mcpHost({
		prepareLaunch: (entry) => ({ ...entry, config: { ...entry.config, command: process.execPath, args: [echo] } }),
		...options,
	});
	hosts.push(result);
	return result;
};
afterEach(async () => {
	await Promise.all(hosts.splice(0).map((host) => host.close()));
	vi.unstubAllEnvs();
});

describe("default MCP in the shared host", () => {
	it("loads the preset only as the lowest-priority configuration and persists controls without a transport", () => {
		const agentDir = tmp(),
			cwd = tmp();
		const options = { agentDir, cwd, projectTrusted: true, defaults: defaults() };
		expect(loadMcpConfig(options).servers).toEqual(defaults());
		writeFileSync(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { octocode: { enabled: false } } }));
		const loaded = loadMcpConfig(options);
		expect(loaded.errors).toEqual([]);
		expect(loaded.servers).toMatchObject([{ scope: "default", config: { command: "octocode-mcp", enabled: false } }]);
		mkdirSync(join(cwd, ".octocode"));
		writeFileSync(
			join(cwd, ".octocode/mcp.json"),
			JSON.stringify({ mcpServers: { octocode: { command: "replacement" } } }),
		);
		// The replacement keeps the preset's purpose (shown in the prompt), roles and launch env templates; not its command.
		const { description, env, roles } = defaults()[0].config as { description: string; env: object; roles: object };
		expect(loadMcpConfig(options).servers[0].config).toEqual({ command: "replacement", description, env, roles });
		expect(loadMcpConfig({ ...options, projectTrusted: false }).servers[0].config.enabled).toBe(false);
	});
	it("saves default enablement as a canonical global or trusted project override", async () => {
		const agentDir = tmp(),
			cwd = tmp();
		const h = host({
			cwd,
			loadConfig: () => loadMcpConfig({ agentDir, cwd, projectTrusted: true, defaults: defaults() }),
		});
		await h.start();
		await h.prompt();
		const server = h.state.findServer("octocode")!;
		expect(saveConfig(h.state, server, { enabled: false })).toBeUndefined();
		expect(JSON.parse(readFileSync(join(agentDir, "mcp.json"), "utf8"))).toEqual({
			mcpServers: { octocode: { enabled: false } },
		});
		expect(saveConfig(h.state, server, { enabled: true }, true)).toBeUndefined();
		expect(JSON.parse(readFileSync(join(cwd, ".octocode/mcp.json"), "utf8"))).toEqual({
			mcpServers: { octocode: { enabled: true } },
		});
	});

	it("allows extension registrations to replace a default and restores it when they unregister", async () => {
		const h = host({
			presets: [{ name: "note-kit", config: { command: process.execPath, args: [echo] } }],
			prepareLaunch: (entry) => entry,
		});
		let registered: ReturnType<typeof h.api.getMcpServers> = [
			{
				name: "note_kit",
				extensionPath: "extension",
				config: { command: process.execPath, args: [echo], env: { ECHO_INSTRUCTIONS: "EXTENSION" } },
			},
		];
		h.api.getMcpServers = () => registered;
		await h.start();
		await h.prompt();
		expect(h.state.servers).toHaveLength(1);
		expect(h.state.servers[0].entry.scope).toBe("extension");
		expect(h.state.servers[0].connection?.instructions).toBe("EXTENSION");
		registered = [];
		await h.fire("mcp_servers_change", {}, h.ctx);
		expect(h.state.servers).toHaveLength(1);
		expect(h.state.servers[0].entry.scope).toBe("default");
		expect(h.state.servers[0].connection?.instructions).toBe("Echo test server.");
		registered = [
			{
				name: "note_kit",
				extensionPath: "extension",
				config: { command: process.execPath, args: [echo], env: { ECHO_INSTRUCTIONS: "NEW" } },
			},
		];
		await h.fire("mcp_servers_change", {}, h.ctx);
		expect(h.state.servers).toHaveLength(1);
		expect(h.state.servers[0].connection?.instructions).toBe("NEW");
		expect(h.transports).toHaveLength(3);
	});
	it("runs one connection and registers its complete catalog, including the default in the shared prompt", async () => {
		const h = host();
		await h.start();
		const sections = await h.prompt();
		expect(h.state.servers).toHaveLength(1);
		expect(h.transports).toHaveLength(1);
		expect(h.state.findServer("octocode")?.connection?.tools).toHaveLength(9);
		expect(sections.mcps).not.toContain("state=");
		// `declared` (the default): the block carries the instructions; each tool carries its own description and schema.
		expect(sections.mcps).toContain("Echo test server.");
		expect(sections.mcps).not.toContain("localFetch");
		expect(h.tools.get("mcp__octocode__localFetch")?.parameters).toMatchObject({ type: "object" });
		expect(sections.octocode_mcp).toBeUndefined();
		expect(await h.call("mcp__octocode__shout", { text: "hello" })).toMatchObject({ content: [{ text: "HELLO" }] });
		expect(await h.call("mcp__octocode__roots")).toMatchObject({
			content: [{ text: expect.stringContaining(h.ctx.cwd) }],
		});
	});
	it("allows the default local reader in planning, and a same-named replacement only while it keeps the default's roles", async () => {
		// The default entry as runtime registers it (`default.ts`): its `roles` declare localFetch read-only. `prepareLaunch`
		// runs the echo fixture instead, so its npm `install` is left out (installing is `mcp-install.test.ts`'s subject).
		const presets: McpServerPreset[] = recommendedPresets({}).map((preset) => {
			if (!preset.config || !("command" in preset.config)) return preset;
			const { install: _install, ...config } = preset.config;
			return { ...preset, config };
		});
		const h = host({ presets });
		await h.start();
		await h.prompt();
		const name = "mcp__octocode__localFetch";
		const definition = { ...h.tools.get(name), sourceInfo: { path: "builtin:mcp", owner: "builtin" as const } };
		const status = getMcpSessionStatus(h.api.events);
		expect(planningRefusal({ toolName: name, input: {} }, definition, status)).toBeUndefined();
		expect(
			planningRefusal(
				{ toolName: name, input: {} },
				{ ...definition, sourceInfo: { path: "extension" } } as never,
				status,
			),
		).toContain("blocks");
		// A user entry named like a default entry, without its own `roles`, keeps
		// the default's roles; `"roles": {}` clears them, and its tools are no longer read-only.
		for (const roles of [undefined, {}]) {
			const agentDir = tmp(),
				cwd = tmp();
			const entry = { command: process.execPath, args: [echo], ...(roles ? { roles } : {}) };
			writeFileSync(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { octocode: entry } }));
			// The user approved the replacement in the security review; an unapproved one stays off.
			approveFixtureMcp(cwd, agentDir, presetEntries(presets));
			const configured = host({
				cwd,
				presets,
				loadConfig: (_ctx, defaults) => loadMcpConfig({ agentDir, cwd, projectTrusted: true, defaults }),
			});
			await configured.start();
			await configured.prompt();
			const refusal = planningRefusal(
				{ toolName: name, input: {} },
				definition,
				getMcpSessionStatus(configured.api.events),
			);
			if (roles) expect(refusal).toContain("blocks");
			else expect(refusal).toBeUndefined();
		}
		await h.call("mcp", { intent: "stop", server: "octocode" });
		expect(planningRefusal({ toolName: name, input: {} }, definition, getMcpSessionStatus(h.api.events))).toContain(
			"blocks",
		);
	});
	it("uses the host environment for the default and sanitizes instructions", async () => {
		vi.stubEnv("ECHO_INSTRUCTIONS", "fixture\u001b[31m instructions");
		const h = host();
		await h.start();
		const sections = await h.prompt();
		expect(sections.mcps).toContain("fixture");
		expect(sections.mcps).not.toContain("\u001b");
	});
	it("returns tool errors and honors cancellation and progress through the common executor", async () => {
		const h = host();
		await h.start();
		await h.prompt();
		expect(await h.call("mcp__octocode__fail")).toMatchObject({ isError: true, content: [{ text: "boom" }] });
		await expect(h.call("mcp__octocode__shout", { text: "hi" }, AbortSignal.abort())).rejects.toThrow();
		const p = host({
			prepareLaunch: (entry) => ({
				...entry,
				config: { ...entry.config, command: process.execPath, args: [progress] },
			}),
		});
		await p.start();
		await p.prompt();
		const updates: unknown[] = [];
		const tool = p.state.findServer("octocode")!.connection!.tools[0].name;
		await p.call(`mcp__octocode__${tool}`, {}, undefined, (update) => updates.push(update));
		expect(updates.length).toBeGreaterThan(0);
	});
	it("refreshes catalog additions and withdrawals, preserving unchanged tool definitions across reconnect", async () => {
		const h = host();
		await h.start();
		await h.prompt();
		const original = h.tools.get("mcp__octocode__shout");
		await h.call("mcp__octocode__grow");
		await vi.waitFor(() => expect(h.tools.get("mcp__octocode__late")?.exposure).toBe("direct"));
		expect(await h.call("mcp__octocode__late")).toMatchObject({ content: [{ text: "late tool works" }] });
		await h.call("mcp__octocode__shrink");
		await vi.waitFor(() => expect(h.tools.get("mcp__octocode__late")?.exposure).toBe("hidden"));
		expect(await reconnect(h.state.findServer("octocode")!)).toBeUndefined();
		expect(h.tools.get("mcp__octocode__shout")).toBe(original);
	});
	it("stops and restarts the default through the same management tool and slash command", async () => {
		const h = host();
		await h.start();
		await h.prompt();
		expect(await h.call("mcp", { intent: "stop", server: "octocode" })).not.toMatchObject({ isError: true });
		expect(getMcpSessionStatus(h.api.events)).toMatchObject([{ name: "octocode", state: "stopped" }]);
		const stopped = await h.prompt();
		// The block keeps its contract; the stop goes to the status section only.
		expect(stopped.mcps).toContain('<mcp name="octocode" tools="mcp__octocode__*">');
		expect(stopped.mcps).toContain("Echo test server.");
		expect(stopped.mcp_status).toContain("- octocode: stopped");
		expect(h.transports).toHaveLength(1);
		expect(h.tools.get("mcp__octocode__shout").exposure).toBe("hidden");
		await h.commands.get("mcp").handler("reconnect octocode", h.ctx);
		expect(h.transports).toHaveLength(2);
		expect(await h.call("mcp__octocode__shout", { text: "again" })).toMatchObject({ content: [{ text: "AGAIN" }] });
	});
	it("honors explicit exposure over the preset's local-tool default", async () => {
		const h = host({ updateConfig: () => {} });
		await h.start();
		await h.prompt();
		const server = h.state.findServer("octocode")!;
		expect(h.tools.get("mcp__octocode__localFetch").exposure).toBe("direct");
		expect(setExposure(h.state, server, "hidden")).toBeUndefined();
		expect(h.tools.get("mcp__octocode__localFetch").exposure).toBe("hidden");
		await expect(h.call("mcp__octocode__localFetch", { queries: [] })).rejects.toThrow(/no longer available/);
	});
	it("does not launch a disabled preset", async () => {
		const h = host({ presets: [defaultPreset({ OCTOCODE_MCP: "0" })] });
		await h.start();
		await h.prompt();
		expect(h.transports).toHaveLength(0);
		expect(h.tools.has("mcp__octocode__localFetch")).toBe(false);
		expect(getMcpSessionStatus(h.api.events)).toMatchObject([{ name: "octocode", enabled: false, state: "disabled" }]);
	});
	it("names only switched-on servers the review holds back as awaiting approval in mcp_status", async () => {
		const entry = (name: string, enabled: boolean) => ({
			name,
			config: { command: "never-launch", enabled },
			source: "/mcp.json",
			scope: "global" as const,
			withheld: true as const,
		});
		const createTransport = vi.fn();
		const h = host({
			servers: [entry("pending-review", true), entry("switched-off", false)],
			presets: [],
			createTransport,
		});
		await h.start();
		const sections = await h.prompt();
		expect(sections.mcp_status).toContain("- pending-review");
		// The user switched this one off: telling the model it awaits approval would be wrong and cost every request.
		expect(sections.mcp_status).not.toContain("switched-off");
		expect(createTransport).not.toHaveBeenCalled();
	});
	it("leaves mcp_status out when the only withheld server is switched off", async () => {
		const h = host({
			servers: [
				{
					name: "unused",
					config: { command: "never-launch", enabled: false },
					source: "/mcp.json",
					scope: "global",
					withheld: true,
				},
			],
			presets: [],
		});
		await h.start();
		expect((await h.prompt()).mcp_status).toBeUndefined();
	});
	it("bounds startup, cancels a prompt wait, and cleans up a connecting process on shutdown", async () => {
		const h = host({
			startupWaitMs: 10_000,
			prepareLaunch: (entry) => ({
				...entry,
				config: { command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"] },
			}),
		});
		await h.start();
		const controller = new AbortController();
		const waiting = h.prompt({ ...h.ctx, signal: controller.signal });
		await vi.waitFor(() => expect(h.transports).toHaveLength(1));
		controller.abort();
		await waiting;
		expect(h.state.findServer("octocode")?.connection?.state).toBe("connecting");
		const pid = h.transports[0].pid!;
		await h.close();
		await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow());
	});
	it("keeps the tools declared after a server exits during a call, fails calls while it is down and recovers", async () => {
		const h = host();
		await h.start();
		await h.prompt();
		await expect(h.call("mcp__octocode__crash")).rejects.toThrow();
		await vi.waitFor(() => expect(h.state.findServer("octocode")?.connection?.state).toBe("disconnected"));
		expect(h.tools.get("mcp__octocode__shout").exposure).toBe("direct");
		await expect(h.call("mcp__octocode__shout", { text: "back" })).rejects.toThrow(/is disconnected.*reconnecting/s);
		await vi.waitFor(() => expect(h.state.findServer("octocode")?.connection?.state).toBe("connected"));
		expect(await h.call("mcp__octocode__shout", { text: "back" })).toMatchObject({ content: [{ text: "BACK" }] });
	});
});
