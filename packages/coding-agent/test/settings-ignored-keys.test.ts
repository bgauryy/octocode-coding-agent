import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectSettingsDiagnostics, deduplicateDiagnostics } from "../src/core/settings-diagnostics.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

let root: string;
let cwd: string;
let agentDir: string;
let globalPath: string;
let projectPath: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "octocode-ignored-keys-"));
	cwd = join(root, "project");
	agentDir = join(root, "agent");
	mkdirSync(join(cwd, ".octocode"), { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	globalPath = join(agentDir, "settings.json");
	projectPath = join(cwd, ".octocode", "settings.json");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("settings keys Octocode ignores", () => {
	it("reports a key no setting reads, with the command that removes it", () => {
		writeFileSync(
			globalPath,
			JSON.stringify({
				theme: "dark",
				compaction: { reserveTokens: 40000, keepRecentTokens: 30000, modelOverrides: { "a/b": { reserveTokens: 1 } } },
			}),
		);

		const manager = SettingsManager.createForStartup(cwd, agentDir);
		const diagnostics = collectSettingsDiagnostics(manager);

		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0]?.type).toBe("warning");
		expect(diagnostics[0]?.message).toBe(`${globalPath}: 1 ignored key (compaction): /settings unset compaction`);
		// Loading stays permissive: the known keys still apply and the unknown one is kept in the file.
		expect(manager.getTheme()).toBe("dark");
		expect(manager.getCompactionReserveTokens()).toBeGreaterThan(0);
		expect(manager.getCompactionReserveTokens()).not.toBe(40000);
	});

	it("loads a file that still has the removed extensions key and warns once", () => {
		writeFileSync(globalPath, JSON.stringify({ theme: "dark", extensions: ["-builtin:mcp", "./ext.ts"] }));

		const manager = SettingsManager.createForStartup(cwd, agentDir);
		const messages = collectSettingsDiagnostics(manager).map((d) => d.message);

		expect(messages.filter((message) => message.includes('Setting "extensions" is ignored'))).toHaveLength(1);
		expect(manager.getTheme()).toBe("dark");
	});

	it("names a misspelled key without claiming a replacement", () => {
		writeFileSync(globalPath, JSON.stringify({ defaultModle: "x", theme: "dark" }));

		const [warning] = collectSettingsDiagnostics(SettingsManager.create(cwd, agentDir));

		expect(warning?.message).toBe(`${globalPath}: 1 ignored key (defaultModle): /settings unset defaultModle`);
	});

	it("warns about an unknown key inside a known object setting, by dotted path", () => {
		writeFileSync(globalPath, JSON.stringify({ thinkingBudgets: { high: 1, xhigh: 2 }, bash: { nope: 1 } }));

		const messages = collectSettingsDiagnostics(SettingsManager.create(cwd, agentDir)).map((d) => d.message);

		// One line per file names every ignored key.
		expect(messages).toEqual([
			`${globalPath}: 2 ignored keys (thinkingBudgets.xhigh, bash.nope): /settings unset thinkingBudgets.xhigh bash.nope`,
		]);
		expect(messages.join("\n")).not.toContain("thinkingBudgets.high ");
	});

	it("does not treat an inherited property name as a removed key", () => {
		writeFileSync(globalPath, JSON.stringify({ constructor: 1 }));

		const [warning] = collectSettingsDiagnostics(SettingsManager.create(cwd, agentDir));

		expect(warning?.message).toContain("(constructor)");
	});

	it("reports the removed codemode keys as unknown keys", () => {
		writeFileSync(globalPath, JSON.stringify({ codemode: { mode: "on" }, autoEnableCodemode: true }));

		const messages = collectSettingsDiagnostics(SettingsManager.create(cwd, agentDir)).map((d) => d.message);

		expect(messages).toEqual([
			`${globalPath}: 2 ignored keys (codemode, autoEnableCodemode): /settings unset codemode autoEnableCodemode`,
		]);
	});

	it("does not warn about the names in a defaultTools list, including removed or renamed tools", () => {
		writeFileSync(globalPath, JSON.stringify({ defaultTools: ["+browser", "+debug", "-browser", "task", "-task"] }));

		expect(collectSettingsDiagnostics(SettingsManager.create(cwd, agentDir))).toEqual([]);
	});

	it("stays silent for known keys and names keys of earlier versions like any other unknown key", () => {
		writeFileSync(globalPath, JSON.stringify({ $schema: "x", theme: "dark", retry: { enabled: false } }));
		expect(collectSettingsDiagnostics(SettingsManager.create(cwd, agentDir))).toEqual([]);

		writeFileSync(globalPath, JSON.stringify({ queueMode: "all", websockets: true }));
		expect(collectSettingsDiagnostics(SettingsManager.create(cwd, agentDir)).map((item) => item.message)).toEqual([
			`${globalPath}: 2 ignored keys (queueMode, websockets): /settings unset queueMode websockets`,
		]);
	});

	it("reports each load once: not again when drained, again after a reload", async () => {
		writeFileSync(globalPath, JSON.stringify({ compaction: {} }));
		const manager = SettingsManager.create(cwd, agentDir);

		expect(collectSettingsDiagnostics(manager)).toHaveLength(1);
		expect(collectSettingsDiagnostics(manager)).toEqual([]);

		writeFileSync(globalPath, JSON.stringify({ compaction: {}, typo: 1 }));
		await manager.reload();
		const reloaded = collectSettingsDiagnostics(manager).map((d) => d.message);
		expect(reloaded).toEqual([`${globalPath}: 2 ignored keys (compaction, typo): /settings unset compaction typo`]);

		writeFileSync(globalPath, JSON.stringify({ theme: "dark" }));
		await manager.reload();
		expect(collectSettingsDiagnostics(manager)).toEqual([]);
	});

	it("collapses the startup and runtime managers' identical warnings", () => {
		writeFileSync(globalPath, JSON.stringify({ compaction: {} }));

		const both = [
			...collectSettingsDiagnostics(SettingsManager.createForStartup(cwd, agentDir)),
			...collectSettingsDiagnostics(SettingsManager.create(cwd, agentDir)),
		];

		expect(both).toHaveLength(2);
		expect(deduplicateDiagnostics(both)).toHaveLength(1);
	});

	it("reads project settings only once the project is trusted, then reports their ignored keys", () => {
		writeFileSync(projectPath, JSON.stringify({ compaction: { reserveTokens: 1 } }));

		const untrusted = SettingsManager.createForStartup(cwd, agentDir);
		expect(collectSettingsDiagnostics(untrusted)).toEqual([]);

		untrusted.setProjectTrusted(true);
		const [warning] = collectSettingsDiagnostics(untrusted);
		expect(warning?.message).toBe(`${projectPath}: 1 ignored key (compaction): /settings unset compaction --local`);

		expect(collectSettingsDiagnostics(SettingsManager.createForStartup(cwd, agentDir, true))).toHaveLength(1);
	});

	it("does not touch the file: the unknown key survives a settings save", async () => {
		writeFileSync(globalPath, JSON.stringify({ compaction: { reserveTokens: 40000 } }));
		const manager = SettingsManager.create(cwd, agentDir);

		manager.setTheme("light");
		await manager.flush();

		const saved = JSON.parse(readFileSync(globalPath, "utf-8"));
		expect(saved).toEqual({ compaction: { reserveTokens: 40000 }, theme: "light" });
	});
});
