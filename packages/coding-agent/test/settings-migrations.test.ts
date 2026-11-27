import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { isRunnerActive } from "../src/octocode/external/runner-selection.ts";
import { RUNNERS } from "../src/octocode/external/runners.ts";

describe("settings migrations at load", () => {
	let root: string;
	let agent: string;
	let project: string;
	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "settings-migrations-"));
		agent = path.join(root, "agent");
		project = path.join(root, "project");
		fs.mkdirSync(agent);
		fs.mkdirSync(path.join(project, ".octocode"), { recursive: true });
	});
	afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

	const globalFile = () => path.join(agent, "settings.json");
	const projectFile = () => path.join(project, ".octocode", "settings.json");
	const open = (projectTrusted = false) => SettingsManager.create(project, agent, { projectTrusted });

	it("turns an explicit externalAgents: true without a selection into the runners it meant, once", () => {
		fs.writeFileSync(globalFile(), JSON.stringify({ externalAgents: true, defaultModel: "one" }));
		const settings = open();
		const written = JSON.parse(fs.readFileSync(globalFile(), "utf8"));
		expect(written).toEqual({
			externalAgents: true,
			defaultModel: "one",
			enabledExternalAgents: [...RUNNERS.map((runner) => runner.id), "octocode"],
		});
		for (const runner of RUNNERS) expect(isRunnerActive(settings, runner.id)).toBe(true);
		const after = fs.readFileSync(globalFile(), "utf8");
		const stamp = fs.statSync(globalFile()).mtimeMs;
		open();
		expect(fs.readFileSync(globalFile(), "utf8")).toBe(after);
		expect(fs.statSync(globalFile()).mtimeMs).toBe(stamp);
	});

	it("keeps the file's own ACP agents selected beside the runners, and leaves its CLI entries out", () => {
		const externalModels = [
			{ id: "my-acp", kind: "acp", command: "my-acp" },
			{ id: "my-cli", kind: "cli", command: "my-cli" },
		];
		fs.writeFileSync(globalFile(), JSON.stringify({ externalAgents: true, externalModels }));
		open();
		expect(JSON.parse(fs.readFileSync(globalFile(), "utf8"))).toEqual({
			externalAgents: true,
			externalModels,
			enabledExternalAgents: [...RUNNERS.map((runner) => runner.id), "octocode", "my-acp"],
		});
	});

	it.each([
		["off", '{"externalAgents":false}'],
		["an explicit empty selection", '{ "externalAgents": true, "enabledExternalAgents": [] }'],
		["no external keys", '{\n\t"defaultModel": "one"\n}'],
	])("leaves a file with %s byte for byte", (_name, text) => {
		fs.writeFileSync(globalFile(), text);
		const settings = open();
		expect(fs.readFileSync(globalFile(), "utf8")).toBe(text);
		if (text.includes("[]")) expect(isRunnerActive(settings, "codex")).toBe(false);
	});

	it("never rewrites a project file: untrusted it is not read, and the key is global only", () => {
		const text = JSON.stringify({ externalAgents: true });
		fs.writeFileSync(projectFile(), text);
		open(false);
		expect(fs.readFileSync(projectFile(), "utf8")).toBe(text);
		open(true);
		expect(fs.readFileSync(projectFile(), "utf8")).toBe(text);
	});

	it("treats a missing selection as no runner once the fallback is gone", () => {
		const settings = SettingsManager.inMemory({ externalAgents: false });
		settings.setExternalAgents(true);
		expect(isRunnerActive(settings, "codex")).toBe(false);
	});
});
