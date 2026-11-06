import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadMcpConfig } from "../src/config.ts";
import { presetEntries } from "../src/preset.ts";
import { octocodePreset } from "../src/presets/octocode/index.ts";
import { browserPreset } from "../src/presets/browser/index.ts";
import { browserLaunch, browserMcpEntry } from "../src/presets/browser/launch.ts";
import { BROWSER_SERVER } from "../../common/src/mcp-names.ts";
import { withStructuredText } from "../src/presets/browser/tools.ts";
import { getMcpSessionStatus } from "../src/status.ts";
import { createMcpToolName } from "../src/tool-names.ts";
import { mcpHost } from "./mcp-host-fixture.ts";
import { tmp } from "../../coding-agent/test/octocode/helpers.ts";

const hosts: ReturnType<typeof mcpHost>[] = [];
afterEach(async () => {
	await Promise.all(hosts.splice(0).map((host) => host.close()));
});

const textOf = (result: { content: Array<{ type: string; text?: string }> }) =>
	result.content.flatMap((part) => (part.type === "text" && part.text ? [part.text] : [])).join("\n");

describe("browser MCP preset", () => {
	it("launches the installed package bin under this Node in the workspace", () => {
		const cwd = tmp();
		const launch = browserLaunch(cwd);
		expect(launch.command).toBe(process.execPath);
		expect(launch.cwd).toBe(cwd);
		expect(launch.args).toEqual([browserMcpEntry()]);
		expect(existsSync(launch.args[0])).toBe(true);
	});

	it("refuses to start when the package is missing instead of fetching it", () => {
		expect(() => browserLaunch(tmp(), "")).toThrow(/not installed next to Octocode/);
	});

	it("supplies the launch only for its own default entry", () => {
		const preset = browserPreset();
		const [entry] = presetEntries([preset]);
		expect(entry).toMatchObject({ name: BROWSER_SERVER, scope: "default", config: { defaultActive: false } });
		expect(entry.config.exposure).toBeUndefined();
		expect(preset.prepareLaunch!(entry, "/work", true).config).toMatchObject({
			args: [browserMcpEntry()],
			cwd: "/work",
		});
		const user = { ...entry, scope: "global" as const, config: { command: "my-chrome" } };
		expect(preset.prepareLaunch!(user, "/work", true)).toBe(user);
	});

	it("is not enabled when OCTOCODE_MCP_BROWSER=0, and leaves the Octocode preset and a user server alone", () => {
		const env = { OCTOCODE_MCP_BROWSER: "0" };
		expect(presetEntries([browserPreset({})])[0].config.enabled).toBe(true);
		const defaults = presetEntries([octocodePreset(() => [], env), browserPreset(env)]);
		expect(defaults.map(({ name, config }) => [name, config.enabled])).toEqual([
			["octocode", true],
			[BROWSER_SERVER, false],
		]);
		const agentDir = tmp(),
			cwd = tmp();
		mkdirSync(join(agentDir), { recursive: true });
		writeFileSync(
			join(agentDir, "mcp.json"),
			JSON.stringify({ mcpServers: { browser: { command: "my-chrome" }, other: { command: "x" } } }),
		);
		const loaded = loadMcpConfig({ agentDir, cwd, projectTrusted: false, defaults });
		expect(loaded.errors).toEqual([]);
		const byName = Object.fromEntries(loaded.servers.map((server) => [server.name, server]));
		// The replacement keeps the preset's purpose, which the prompt shows; nothing else of the preset.
		expect(byName.browser.config).toEqual({
			command: "my-chrome",
			description: defaults.find((entry) => entry.name === BROWSER_SERVER)!.config.description,
		});
		expect(byName.other.config).toEqual({ command: "x" });
		expect(byName.octocode.config.enabled).toBe(true);
	});

	it("shows structured evidence after the server's short acknowledgement", () => {
		const structuredContent = { ok: true, flow: { steps: [{ op: "goto", status: "complete" }] } };
		const shown = withStructuredText({ content: [{ type: "text", text: "OK" }], structuredContent });
		expect(textOf(shown)).toBe(`OK\n${JSON.stringify(structuredContent)}`);
		const envelope = JSON.stringify(structuredContent);
		const error = { content: [{ type: "text" as const, text: envelope }], structuredContent, isError: true };
		expect(withStructuredText(error)).toBe(error);
		const plain = { content: [{ type: "text" as const, text: "plain" }] };
		expect(withStructuredText(plain)).toBe(plain);
	});

	it("is not started where no tool selection names it, and says so", async () => {
		const host = mcpHost({ presets: [browserPreset()], cwd: tmp() });
		hosts.push(host);
		// The main agent's selection: tools active by default only.
		host.api.selectsTools = (_prefix: string, activeByDefault: boolean) => activeByDefault;
		await host.start();
		const server = host.state.findServer(BROWSER_SERVER)!;
		expect(server.unselected).toBe(true);
		expect(server.connection).toBeUndefined();
		expect(host.transports).toHaveLength(0);
		expect(getMcpSessionStatus(host.api.events)).toMatchObject([{ name: BROWSER_SERVER, state: "unselected" }]);
		const sections = await host.prompt();
		expect(Object.keys(sections).filter((name) => name.startsWith("mcp_"))).toEqual([]);
	});

	it("lists the real server's tools and returns schema evidence the model can read", async () => {
		const host = mcpHost({ presets: [browserPreset()], cwd: tmp(), presentation: "compact" });
		hosts.push(host);
		// The browser subagent's selection names mcp__browser__*, which activates the tools that are off by default.
		host.api.getActiveTools = () =>
			[...host.tools.values()].filter((tool) => tool.exposure !== "hidden").map((tool) => tool.name);
		await host.start();
		const sections = await host.prompt();
		const server = host.state.findServer(BROWSER_SERVER)!;
		expect(server.connection?.state).toBe("connected");
		expect(server.connection?.tools.map((tool) => tool.name)).toEqual(
			expect.arrayContaining(["open", "run", "snapshot", "screenshot", "query", "artifact", "cleanup"]),
		);
		// The preset's compact overrides (`presets/browser/compact-overrides.json`) replace the server's own text.
		const prompt = Object.values(sections).join("\n");
		expect(prompt).toContain("A run plan stops at its first failure");
		expect(prompt).not.toContain("Batch known transitions with run");
		const result = await host.call(createMcpToolName(BROWSER_SERVER, "schema"), {
			command: "run",
			operation: "extract",
		});
		const text = textOf(result);
		expect(text.startsWith("OK\n")).toBe(true);
		expect(JSON.parse(text.slice(3))).toMatchObject({ ok: true, data: { plan: expect.any(Object) } });
	}, 60_000);
});
