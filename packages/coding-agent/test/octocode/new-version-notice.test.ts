import { afterEach, describe, expect, it, vi } from "vitest";
import { formatNewVersionHint } from "../../src/modes/interactive/interactive-mode/startup-checks.ts";
import { checkForNewOctocodeVersion } from "../../src/utils/version-check.ts";

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

describe("new version notice text", () => {
	it("names the exact upgrade command when self-update works", () => {
		expect(formatNewVersionHint("9.9.9", { appName: "octocode", canSelfUpdate: true, unavailable: "x" })).toEqual({
			message: "New version 9.9.9 is available. Run ",
			command: "octocode update",
		});
	});

	it("explains how to update when self-update is unavailable instead of naming a failing command", () => {
		const hint = formatNewVersionHint("9.9.9", {
			appName: "octocode",
			canSelfUpdate: false,
			unavailable: "Update it yourself with: npm install -g pkg",
		});
		expect(hint.command).toBeUndefined();
		expect(hint.message).toContain("New version 9.9.9 is available.");
		expect(hint.message).toContain("npm install -g pkg");
	});
});

describe("version check respects disabling", () => {
	it.each([
		["OCTOCODE_OFFLINE", "1"],
		["OCTOCODE_SKIP_VERSION_CHECK", "1"],
	])("makes no request when %s is set", async (name, value) => {
		const fetchMock = vi.fn(async () => Response.json({ version: "99.0.0" }));
		vi.stubGlobal("fetch", fetchMock);
		vi.stubEnv(name, value);
		await expect(checkForNewOctocodeVersion("1.0.0")).resolves.toBeUndefined();
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
