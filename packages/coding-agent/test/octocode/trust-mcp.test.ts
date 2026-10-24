import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { loadTrustedMcpConfig, trustedMcpOptions } from "../../src/extensions/mcp-trust.ts";
import { createMcpExtension } from "../../src/extensions/mcp/index.ts";
import { saveDecision } from "../../src/octocode/shared/trust.ts";
import { createHarness, createTestUiContext } from "../suite/harness.ts";
import { tmp } from "./helpers.ts";
import { fingerprint, projectConfigFiles } from "../../src/octocode/shared/trust/files.ts";

beforeEach(() => {
	vi.stubEnv("OCTOCODE_HOME", tmp("octocode-mcp-trust-home-"));
	vi.stubEnv("OCTOCODE_CODING_AGENT_DIR", tmp("octocode-mcp-trust-agent-"));
	vi.stubEnv("OCTOCODE_SUBAGENT", undefined);
	vi.stubEnv("OCTOCODE_TRUST_ROOT", undefined);
});

const server = (name: string) => ({ [name]: { command: process.execPath, args: [`${name}.js`] } });

function project(files: Record<string, unknown>): string {
	const dir = tmp("octocode-mcp-trust-project-");
	fs.mkdirSync(path.join(dir, ".git"));
	for (const [file, value] of Object.entries(files)) write(dir, file, value);
	return dir;
}

function write(dir: string, file: string, value: unknown): void {
	fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
	fs.writeFileSync(path.join(dir, file), JSON.stringify(value));
}

const trust = (cwd: string) => saveDecision(cwd, fingerprint(projectConfigFiles(cwd)), true);
const names = (cwd: string, trusted = true) =>
	loadTrustedMcpConfig({ cwd, isProjectTrusted: () => trusted }).servers.map((entry) => entry.name);

describe("project MCP definitions and content-based trust", () => {
	it("loads the servers of exactly the files that were trusted", () => {
		const cwd = project({ ".octocode/mcp.json": { mcpServers: server("a") } });
		trust(cwd);
		expect(names(cwd)).toEqual(["a"]);
	});

	it("does not load a server added to a trusted project's mcp.json, and says to run /trust", () => {
		const cwd = project({ ".octocode/mcp.json": { mcpServers: server("a") } });
		trust(cwd);
		write(cwd, ".octocode/mcp.json", { mcpServers: { ...server("a"), ...server("b") } });
		const loaded = loadTrustedMcpConfig({ cwd, isProjectTrusted: () => true });
		expect(loaded.servers).toEqual([]);
		expect(loaded.errors.join("\n")).toContain("/trust");
	});

	it("does not load a changed command, or a project MCP file that appeared after trust", () => {
		const cwd = project({ ".octocode/mcp.json": { mcpServers: server("a") } });
		trust(cwd);
		write(cwd, ".octocode/mcp.json", { mcpServers: { a: { command: "curl", args: ["https://example.test"] } } });
		expect(names(cwd)).toEqual([]);
		write(cwd, ".octocode/mcp.json", { mcpServers: server("a") });
		expect(names(cwd)).toEqual(["a"]);
		write(cwd, ".mcp.json", { mcpServers: server("c") });
		expect(names(cwd)).toEqual([]);
	});

	it("loads the new content once /trust records it", () => {
		const cwd = project({ ".octocode/mcp.json": { mcpServers: server("a") } });
		trust(cwd);
		write(cwd, ".mcp.json", { mcpServers: server("c") });
		expect(names(cwd)).toEqual([]);
		trust(cwd);
		expect(names(cwd).sort()).toEqual(["a", "c"]);
	});

	it("loads no project server when the directory itself is untrusted", () => {
		const cwd = project({ ".octocode/mcp.json": { mcpServers: server("a") } });
		trust(cwd);
		expect(names(cwd, false)).toEqual([]);
	});

	it("keeps trust across a /mcp enable or exposure edit, but not across an untrusted state", () => {
		const cwd = project({ ".octocode/mcp.json": { mcpServers: server("a") } });
		const file = path.join(cwd, ".octocode", "mcp.json");
		const { updateConfig } = trustedMcpOptions({
			on: (_event: string, handler: (event: unknown, ctx: { cwd: string }) => void) => handler({}, { cwd }),
		} as never);
		const entry = { name: "a", source: file, scope: "project", config: {} } as never;
		trust(cwd);
		updateConfig!(entry, { enabled: false });
		expect(JSON.parse(fs.readFileSync(file, "utf8")).mcpServers.a.enabled).toBe(false);
		expect(names(cwd)).toEqual(["a"]);
		write(cwd, ".octocode/mcp.json", { mcpServers: { ...server("a"), ...server("b") } });
		updateConfig!(entry, { enabled: true });
		expect(names(cwd)).toEqual([]);
	});

	it("does not start a server added after trust", async () => {
		const cwd = project({ ".octocode/mcp.json": { mcpServers: server("a") } });
		trust(cwd);
		write(cwd, ".octocode/mcp.json", { mcpServers: { ...server("a"), ...server("b") } });
		const transports: string[] = [];
		const harness = await createHarness({
			initialActiveToolNames: [],
			extensionFactories: [
				(pi) =>
					createMcpExtension({
						...trustedMcpOptions(pi),
						loadConfig: (ctx) => loadTrustedMcpConfig({ cwd, isProjectTrusted: ctx.isProjectTrusted }),
						createTransport: (entry) => {
							transports.push(entry.name);
							throw new Error("must not start");
						},
					})(pi),
			],
		});
		harness.settingsManager.setProjectTrusted(true);
		const notices: string[] = [];
		try {
			await harness.session.bindExtensions({
				uiContext: createTestUiContext({ notify: (message) => notices.push(message) }),
			});
			await new Promise((resolve) => setTimeout(resolve, 50));
			expect(transports).toEqual([]);
			expect(notices.join("\n")).toContain("/trust");
		} finally {
			harness.cleanup();
		}
	});
});

describe("SDK settings default", () => {
	it("treats the project as untrusted unless the caller says otherwise", () => {
		const cwd = project({ ".octocode/settings.json": { sessionDir: "./.sessions" } });
		const agentDir = tmp("octocode-sdk-trust-agent-");
		expect(SettingsManager.create(cwd, agentDir).isProjectTrusted()).toBe(false);
		expect(SettingsManager.create(cwd, agentDir).getSessionDir()).toBeUndefined();
		expect(SettingsManager.inMemory().isProjectTrusted()).toBe(false);
		const trusted = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
		expect(trusted.isProjectTrusted()).toBe(true);
		expect(trusted.getSessionDir()).toBe("./.sessions");
	});
});
