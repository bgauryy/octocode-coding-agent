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

	it("is off by default and with no settings file", () => {
		expect(SETTINGS_DEFAULTS.externalAgents).toBe(false);
		expect(externalAgentsEnabled(dir)).toBe(false);
		write({});
		expect(externalAgentsEnabled(dir)).toBe(false);
	});

	it("is on only when the global settings say true", () => {
		write({ externalAgents: true });
		expect(externalAgentsEnabled(dir)).toBe(true);
		write({ externalAgents: "yes" });
		expect(externalAgentsEnabled(dir)).toBe(false);
	});
});
