import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectSettingsDiagnostics, deduplicateDiagnostics } from "../src/core/settings-diagnostics.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { ProjectTrustStore } from "../src/core/trust-manager.ts";

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
	it("tells the user a removed compaction block has no effect and what replaced it", () => {
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
		expect(diagnostics[0]?.message).toContain(`Settings file ${globalPath}:`);
		expect(diagnostics[0]?.message).toBe(
			`Settings file ${globalPath}: Setting "compaction" is no longer used: the whole block (enabled, reserveTokens, keepRecentTokens, modelOverrides) does nothing, because Octocode now decides when to compact from each model's context window. To compact earlier, set a smaller "contextBudget" (or use /context size for one session). Delete "compaction" from the file to hide this warning.`,
		);
		// Loading stays permissive: the known keys still apply and the unknown one is kept in the file.
		expect(manager.getTheme()).toBe("dark");
		expect(manager.getCompactionReserveTokens()).toBeGreaterThan(0);
		expect(manager.getCompactionReserveTokens()).not.toBe(40000);
	});

	it("names a misspelled key without claiming a replacement", () => {
		writeFileSync(globalPath, JSON.stringify({ defaultModle: "x", theme: "dark" }));

		const [warning] = collectSettingsDiagnostics(SettingsManager.create(cwd, agentDir));

		expect(warning?.message).toContain('Setting "defaultModle" is not a known setting, so it does nothing.');
	});

	it("explains the removed codemode keys", () => {
		writeFileSync(globalPath, JSON.stringify({ codemode: { mode: "on" }, autoEnableCodemode: true }));

		const messages = collectSettingsDiagnostics(SettingsManager.create(cwd, agentDir)).map((d) => d.message);

		expect(messages).toHaveLength(2);
		expect(messages.join("\n")).toContain('Setting "codemode" is no longer used: codemode was removed');
		expect(messages.join("\n")).toContain('Setting "autoEnableCodemode" is no longer used: codemode was removed');
	});

	it("explains a defaultTools entry for the removed native browser tool, with or without a modifier", () => {
		writeFileSync(globalPath, JSON.stringify({ defaultTools: ["+browser", "+debug", "-browser"] }));

		const messages = collectSettingsDiagnostics(SettingsManager.create(cwd, agentDir)).map((d) => d.message);

		expect(messages).toHaveLength(2);
		expect(messages[0]).toContain(`Settings file ${globalPath}:`);
		expect(messages[0]).toContain('"defaultTools" entry "+browser" has no effect');
		expect(messages[0]).toContain("mcp__browser__*");
		expect(messages[1]).toContain('entry "-browser"');
	});

	it("stays silent for known keys, including legacy ones that migrate", () => {
		writeFileSync(
			globalPath,
			JSON.stringify({ $schema: "x", theme: "dark", queueMode: "all", websockets: true, retry: { enabled: false } }),
		);

		expect(collectSettingsDiagnostics(SettingsManager.create(cwd, agentDir))).toEqual([]);
	});

	it("reports each load once: not again when drained, again after a reload", async () => {
		writeFileSync(globalPath, JSON.stringify({ compaction: {} }));
		const manager = SettingsManager.create(cwd, agentDir);

		expect(collectSettingsDiagnostics(manager)).toHaveLength(1);
		expect(collectSettingsDiagnostics(manager)).toEqual([]);

		writeFileSync(globalPath, JSON.stringify({ compaction: {}, typo: 1 }));
		await manager.reload();
		const reloaded = collectSettingsDiagnostics(manager).map((d) => d.message);
		expect(reloaded).toHaveLength(2);

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
		expect(warning?.message).toContain(`Settings file ${projectPath}:`);
		expect(warning?.message).toContain('Setting "compaction" is no longer used');

		new ProjectTrustStore(agentDir).set(cwd, true);
		expect(collectSettingsDiagnostics(SettingsManager.createForStartup(cwd, agentDir))).toHaveLength(1);
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
