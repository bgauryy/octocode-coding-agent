import { describe, expect, it } from "vitest";
import { InMemorySettingsStorage, SettingsManager } from "../src/core/settings-manager.ts";
import { SettingsSchema } from "../src/core/settings-schema.ts";
import { autoCompactAt, reserveTokensFor } from "../src/octocode/shared/tokens.ts";

const defaults = { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 };

describe("built-in compaction policy", () => {
	it("uses the same policy for the session and native context management", () => {
		const manager = SettingsManager.inMemory();
		expect(manager.getCompactionSettings()).toEqual(defaults);
		for (const contextWindow of [4096, 32768, 128000, 200000, 1000000]) {
			const model = { provider: "p", id: "m", contextWindow };
			const policy = manager.getCompactionSettings(model);
			expect(policy.enabled).toBe(true);
			expect(policy.reserveTokens).toBe(Math.min(16384, Math.floor(contextWindow / 8)));
			expect(policy.keepRecentTokens).toBe(Math.min(20000, Math.floor(contextWindow / 4)));
			expect(policy.reserveTokens + policy.keepRecentTokens).toBeLessThan(contextWindow);
			expect(reserveTokensFor(model)).toBe(policy.reserveTokens);
			expect(autoCompactAt(model)).toBe(contextWindow - policy.reserveTokens);
		}
	});

	it.each([null, false, { enabled: false, reserveTokens: 0, keepRecentTokens: 999999, modelOverrides: { "p/m": { reserveTokens: 199999 } } }])(
		"ignores legacy customization from both settings layers: %j", async (compaction) => {
			const storage = new InMemorySettingsStorage();
			storage.withLock("global", () => JSON.stringify({ compaction }));
			storage.withLock("project", () => JSON.stringify({ compaction }));
			const manager = SettingsManager.fromStorage(storage);
			const model = { provider: "p", id: "m", contextWindow: 200000 };
			expect(manager.getCompactionSettings(model)).toEqual(defaults);
			await manager.reload();
			expect(manager.getCompactionSettings(model)).toEqual(defaults);
			expect(autoCompactAt(model)).toBe(200000 - 16384);
		});

	it("does not publish customization or a setter", () => {
		expect(SettingsSchema.properties).not.toHaveProperty("compaction");
		expect(SettingsManager.inMemory()).not.toHaveProperty("setCompactionEnabled");
	});
});
