import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	isModelHidden,
	normalizeHiddenModels,
	setProviderHiddenModels,
	setProviderTickedModels,
	tickedModelIds,
	visibleModels,
} from "../src/core/provider-models.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "octocode-provider-models-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("per-provider hidden models", () => {
	it("shows everything for a provider with no saved choice", () => {
		const models = [
			{ provider: "a", id: "m1" },
			{ provider: "b", id: "m1" },
		];
		expect(visibleModels(models, {})).toEqual(models);
		expect(visibleModels(models, { a: ["m1"] })).toEqual([{ provider: "b", id: "m1" }]);
		expect(isModelHidden({ a: ["m1"] }, "b", "m1")).toBe(false);
		expect(isModelHidden({}, "constructor", "m1")).toBe(false);
		expect(tickedModelIds({ a: ["m2"] }, "a", ["m1", "m2"])).toEqual(["m1"]);
	});

	it("drops malformed entries instead of failing", () => {
		expect(normalizeHiddenModels({ a: ["x", "x", 3, ""], b: [], c: "no" })).toEqual({ a: ["x"] });
		expect(normalizeHiddenModels([1])).toEqual({});
	});

	it("saves through settings, keeps ids the page did not list hidden, and clears with an empty list", async () => {
		const settings = SettingsManager.create(root, root);
		setProviderTickedModels(settings, "a", ["m1", "m2"], ["m1"]);
		expect(settings.getHiddenModels()).toEqual({ a: ["m2"] });
		setProviderTickedModels(settings, "a", ["m1"], ["m1"]);
		expect(settings.getHiddenModels()).toEqual({ a: ["m2"] });
		await settings.flush();
		expect(JSON.parse(readFileSync(join(root, "settings.json"), "utf8")).hiddenModels).toEqual({ a: ["m2"] });
		setProviderHiddenModels(settings, "a", []);
		await settings.flush();
		expect(settings.getHiddenModels()).toEqual({});
		expect(JSON.parse(readFileSync(join(root, "settings.json"), "utf8")).hiddenModels).toBeUndefined();
	});
});
