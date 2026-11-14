import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { externalAgentsEnabled } from "../../src/octocode/external/enabled.ts";
import { SETTINGS_DEFAULTS } from "../../src/core/settings-defaults.ts";

describe("externalAgents setting", () => {
	let dir: string;
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "external-agents-setting-"));
	});
	afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

	const write = (settings: unknown) => fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify(settings));

	it("is on by default and with no settings file", () => {
		expect(SETTINGS_DEFAULTS.externalAgents).toBe(true);
		expect(externalAgentsEnabled(dir)).toBe(true);
		write({});
		expect(externalAgentsEnabled(dir)).toBe(true);
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
		expect(externalAgentsEnabled(dir)).toBe(true);
	});
});
