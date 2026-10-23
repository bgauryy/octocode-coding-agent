import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { ProjectTrustStore } from "../src/core/trust-manager.ts";
import { getAgentDir } from "../src/config.ts";
import { updateMcpServerConfig } from "../src/extensions/mcp/config.ts";

let root: string;
let home: string;
let agentDir: string;
let cwd: string;

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "octocode-config-atomic-"));
	home = path.join(root, "home");
	agentDir = path.join(home, "agent");
	cwd = path.join(root, "project");
	fs.mkdirSync(agentDir, { recursive: true });
	fs.mkdirSync(cwd);
	vi.stubEnv("HOME", home);
	vi.stubEnv("USERPROFILE", home);
	vi.stubEnv("OCTOCODE_HOME", agentDir);
	vi.stubEnv("OCTOCODE_CODING_AGENT_DIR", "");
});

afterEach(() => {
	vi.unstubAllEnvs();
	fs.rmSync(root, { recursive: true, force: true });
});

function expectOldReaderKeptWholeFile(
	file: string,
	oldText: string,
	mutate: () => void | Promise<void>,
): Promise<void> {
	const fd = fs.openSync(file, "r");
	return Promise.resolve()
		.then(mutate)
		.then(() => {
			const oldReader = Buffer.alloc(Buffer.byteLength(oldText));
			const read = fs.readSync(fd, oldReader, 0, oldReader.length, 0);
			expect(oldReader.subarray(0, read).toString()).toBe(oldText);
		})
		.finally(() => fs.closeSync(fd));
}

it("replaces global settings without changing an already-open reader's document", async () => {
	const file = path.join(agentDir, "settings.json");
	const oldText = JSON.stringify({ theme: "dark", packages: ["npm:old"] });
	fs.writeFileSync(file, oldText);
	const manager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
	await expectOldReaderKeptWholeFile(file, oldText, async () => {
		manager.setTheme("light");
		await manager.flush();
	});
	expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ theme: "light", packages: ["npm:old"] });
});

it("writes through a dangling settings symlink without replacing it", async () => {
	const file = path.join(agentDir, "settings.json");
	const target = path.join(agentDir, "new-settings.json");
	const middle = path.join(agentDir, "settings-target.json");
	fs.symlinkSync("new-settings.json", middle);
	fs.symlinkSync("settings-target.json", file);
	const manager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
	manager.setTheme("dark");
	await manager.flush();
	expect(fs.lstatSync(file).isSymbolicLink()).toBe(true);
	expect(fs.lstatSync(middle).isSymbolicLink()).toBe(true);
	expect(JSON.parse(fs.readFileSync(target, "utf8"))).toMatchObject({ theme: "dark" });
});

it("replaces an MCP config without changing an already-open reader's document", async () => {
	const file = path.join(agentDir, "mcp.json");
	const oldText = JSON.stringify({ mcpServers: { docs: { command: "docs" } } });
	fs.writeFileSync(file, oldText);
	await expectOldReaderKeptWholeFile(file, oldText, () => updateMcpServerConfig(file, "docs", { enabled: false }));
	expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({
		mcpServers: { docs: { command: "docs", enabled: false } },
	});
});

it("reports an array settings document and retains the previous configuration on reload", async () => {
	const file = path.join(agentDir, "settings.json");
	fs.writeFileSync(file, JSON.stringify({ theme: "dark" }));
	const manager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
	fs.writeFileSync(file, "[]");
	await manager.reload();
	expect(manager.getTheme()).toBe("dark");
	expect(manager.drainErrors()).toMatchObject([{ scope: "global", path: file }]);
});

it("does not mask an invalid native settings document with valid Pi fallback values", () => {
	vi.stubEnv("OCTOCODE_HOME", "");
	const nativeAgentDir = getAgentDir();
	fs.mkdirSync(nativeAgentDir, { recursive: true });
	fs.mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
	fs.writeFileSync(path.join(home, ".pi", "agent", "settings.json"), JSON.stringify({ theme: "fallback" }));
	const file = path.join(nativeAgentDir, "settings.json");
	fs.writeFileSync(file, "[]");
	const manager = SettingsManager.create(cwd, nativeAgentDir, { projectTrusted: false });
	expect(manager.getTheme()).toBeUndefined();
	expect(manager.drainErrors()).toMatchObject([{ scope: "global", path: file }]);
});

it("reports an empty native settings document even when Pi fallback is valid", () => {
	vi.stubEnv("OCTOCODE_HOME", "");
	const nativeAgentDir = getAgentDir();
	fs.mkdirSync(nativeAgentDir, { recursive: true });
	fs.mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
	fs.writeFileSync(path.join(home, ".pi", "agent", "settings.json"), JSON.stringify({ theme: "fallback" }));
	const file = path.join(nativeAgentDir, "settings.json");
	fs.writeFileSync(file, "");
	const manager = SettingsManager.create(cwd, nativeAgentDir, { projectTrusted: false });
	expect(manager.getTheme()).toBeUndefined();
	expect(manager.drainErrors()).toMatchObject([{ scope: "global", path: file }]);
});

it("replaces project trust decisions without changing an already-open reader's document", async () => {
	const file = path.join(agentDir, "trust.json");
	const oldText = JSON.stringify({ [cwd]: false });
	fs.writeFileSync(file, oldText);
	await expectOldReaderKeptWholeFile(file, oldText, () => new ProjectTrustStore(agentDir).set(cwd, true));
	expect(new ProjectTrustStore(agentDir).get(cwd)).toBe(true);
});
