import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.ts";

const watcher = vi.hoisted(() => ({ changed: undefined as (() => void) | undefined }));
vi.mock("@octocodeai/octocode-common/watch-file", () => ({
	watchFileChanges: (_path: string, changed: () => void) => {
		watcher.changed = changed;
		return () => {};
	},
}));

let root: string;
let path: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "octocode-provider-validation-"));
	path = join(root, "settings.json");
});
afterEach(() => {
	watcher.changed = undefined;
	rmSync(root, { recursive: true, force: true });
});

describe("provider switches loaded from settings", () => {
	it.each([null, {}, true, "anthropic", ["anthropic", 42]].map((value) => ({ value })))(
		"reports an invalid disabledProviders value ($value) as a settings error",
		({ value: disabledProviders }) => {
			writeFileSync(path, JSON.stringify({ disabledProviders }));
			const settings = SettingsManager.create(root, root);
			expect(settings.getDisabledProviders()).toEqual([]);
			expect(settings.drainErrors()).toEqual([
				expect.objectContaining({
					scope: "global",
					path,
					error: expect.objectContaining({ message: expect.stringContaining("disabledProviders") }),
				}),
			]);
		},
	);

	it("ignores a project-only disabledProviders value while retaining trusted project settings", () => {
		const project = join(root, "project");
		mkdirSync(join(project, ".octocode"), { recursive: true });
		writeFileSync(path, JSON.stringify({ disabledProviders: ["anthropic"] }));
		writeFileSync(
			join(project, ".octocode", "settings.json"),
			JSON.stringify({ disabledProviders: {}, theme: "dark" }),
		);
		const settings = SettingsManager.create(project, root, { projectTrusted: true });
		expect(settings.getDisabledProviders()).toEqual(["anthropic"]);
		expect(settings.getTheme()).toBe("dark");
		expect(settings.drainErrors()).toEqual([]);
	});

	it("keeps live provider switches when an external edit has the wrong shape, then accepts a corrected edit", () => {
		writeFileSync(path, JSON.stringify({ disabledProviders: ["anthropic"] }));
		const settings = SettingsManager.create(root, root);
		const applied = vi.fn();
		const stop = settings.watchProviderToggles(applied);
		try {
			writeFileSync(path, JSON.stringify({ disabledProviders: {} }));
			expect(() => watcher.changed?.()).not.toThrow();
			expect(settings.getDisabledProviders()).toEqual(["anthropic"]);
			expect(applied).not.toHaveBeenCalled();

			writeFileSync(path, JSON.stringify({ disabledProviders: ["openai", "cerebras"] }));
			watcher.changed?.();
			expect(settings.getDisabledProviders()).toEqual(["openai", "cerebras"]);
			expect(applied).toHaveBeenCalledOnce();
		} finally {
			stop();
		}
	});
});
