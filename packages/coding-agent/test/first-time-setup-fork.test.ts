import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/config.ts", async (importOriginal) => {
	const actual = await importOriginal();
	return {
		...(actual as Record<string, unknown>),
		PACKAGE_NAME: "@example/octocodecode",
	};
});

import { shouldRunFirstTimeSetup } from "../src/cli/startup-ui.ts";

describe("shouldRunFirstTimeSetup in forked distributions", () => {
	const originalExperimental = process.env.OCTOCODE_EXPERIMENTAL;
	let tempDir: string;
	let settingsPath: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "octocode-first-time-setup-fork-"));
		settingsPath = join(tempDir, "settings.json");
		process.env.OCTOCODE_EXPERIMENTAL = "1";
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
		if (originalExperimental === undefined) {
			delete process.env.OCTOCODE_EXPERIMENTAL;
		} else {
			process.env.OCTOCODE_EXPERIMENTAL = originalExperimental;
		}
	});

	it("returns false for a forked package", () => {
		expect(shouldRunFirstTimeSetup(settingsPath)).toBe(false);
	});
});
