import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { externalAgentSelection, externalAgentsEnabled } from "../../src/octocode/external/enabled.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { SETTINGS_DEFAULTS } from "../../src/core/settings-defaults.ts";

describe("externalAgents setting", () => {
	let dir: string;
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "external-agents-setting-"));
	});
	afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

	const write = (settings: unknown) => fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify(settings));

	it("requires opt-in by default and with no settings file", () => {
		expect(SETTINGS_DEFAULTS.externalAgents).toBe(false);
		expect(externalAgentsEnabled(dir)).toBe(false);
		write({});
		expect(externalAgentsEnabled(dir)).toBe(false);
	});

	it("honors global disable and fails closed for invalid settings", () => {
		write({ externalAgents: true });
		expect(externalAgentsEnabled(dir)).toBe(true);
		write({ externalAgents: false });
		expect(externalAgentsEnabled(dir)).toBe(false);
		write({ externalAgents: "yes" });
		expect(externalAgentsEnabled(dir)).toBe(false);
		fs.writeFileSync(path.join(dir, "settings.json"), "{broken");
		expect(externalAgentsEnabled(dir)).toBe(false);
	});

	it("does not let project settings override the global choice", () => {
		const project = path.join(dir, ".octocode");
		fs.mkdirSync(project);
		fs.writeFileSync(path.join(project, "settings.json"), JSON.stringify({ externalAgents: true }));
		write({ externalAgents: false });
		expect(externalAgentsEnabled(dir)).toBe(false);
		fs.writeFileSync(path.join(project, "settings.json"), JSON.stringify({ externalAgents: false }));
		write({});
		expect(externalAgentsEnabled(dir)).toBe(false);
	});
});

describe("external runner selection persistence", () => {
	it("normalizes explicit choices and preserves default model settings", async () => {
		const settings = SettingsManager.inMemory({ defaultProvider: "fixture", defaultModel: "one" });
		expect(settings.getEnabledExternalAgents()).toBeUndefined();
		settings.setEnabledExternalAgents([" codex ", "codex", "", "custom"]);
		settings.setExternalAgents(true);
		await settings.flush();
		expect(settings.getEnabledExternalAgents()).toEqual(["codex", "custom"]);
		expect(settings.getGlobalSettings()).toMatchObject({
			defaultProvider: "fixture",
			defaultModel: "one",
			externalAgents: true,
		});
		settings.setEnabledExternalAgents([]);
		await settings.flush();
		expect(settings.getEnabledExternalAgents()).toEqual([]);
	});

	it("ignores trusted project opt-in and persists only the global selection", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "external-global-choice-"));
		try {
			const agent = path.join(root, "agent");
			const project = path.join(root, "project");
			fs.mkdirSync(path.join(project, ".octocode"), { recursive: true });
			fs.mkdirSync(agent);
			fs.writeFileSync(
				path.join(project, ".octocode", "settings.json"),
				JSON.stringify({ externalAgents: true, enabledExternalAgents: ["codex"] }),
			);
			const settings = SettingsManager.create(project, agent, { projectTrusted: true });
			expect(settings.getExternalAgents()).toBe(false);
			expect(settings.getEnabledExternalAgents()).toBeUndefined();
			settings.setEnabledExternalAgents(["claude-code"]);
			settings.setExternalAgents(true);
			await settings.flush();
			expect(externalAgentSelection(agent)).toEqual({ enabled: true, runners: ["claude-code"] });
			expect(JSON.parse(fs.readFileSync(path.join(project, ".octocode", "settings.json"), "utf8"))).toEqual({
				externalAgents: true,
				enabledExternalAgents: ["codex"],
			});
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it.each(["codex", [""], [3], null])("fails closed for malformed selections: %j", (enabledExternalAgents) => {
		const settings = SettingsManager.inMemory({ externalAgents: true, enabledExternalAgents } as never);
		expect(settings.getEnabledExternalAgents()).toEqual([]);
	});
});
