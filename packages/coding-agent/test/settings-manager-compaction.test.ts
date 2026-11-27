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
			// A window whose sixth holds an inline summary reserves for it (24,576, within a sixth).
			const fraction = Math.min(16384, Math.floor(contextWindow / 8));
			expect(policy.reserveTokens).toBe(
				contextWindow / 6 >= 20485 ? Math.min(24_576, Math.floor(contextWindow / 6)) : fraction,
			);
			// A tenth of the window, at least the default, within a quarter of the window.
			expect(policy.keepRecentTokens).toBe(
				Math.min(Math.max(20000, Math.floor(contextWindow / 10)), Math.floor(contextWindow / 4)),
			);
			expect(policy.reserveTokens + policy.keepRecentTokens).toBeLessThan(contextWindow);
			expect(reserveTokensFor(model)).toBe(policy.reserveTokens);
			expect(autoCompactAt(model)).toBe(Math.min(contextWindow - policy.reserveTokens, Math.ceil(0.9 * contextWindow)));
		}
	});

	it.each([
		null,
		false,
		{
			enabled: false,
			reserveTokens: 0,
			keepRecentTokens: 999999,
			modelOverrides: { "p/m": { reserveTokens: 199999 } },
		},
	])("ignores legacy customization from both settings layers: %j", async (compaction) => {
		const storage = new InMemorySettingsStorage();
		storage.withLock("global", () => JSON.stringify({ compaction }));
		storage.withLock("project", () => JSON.stringify({ compaction }));
		const manager = SettingsManager.fromStorage(storage);
		const model = { provider: "p", id: "m", contextWindow: 200000 };
		const policy = { ...defaults, reserveTokens: 24_576 };
		expect(manager.getCompactionSettings(model)).toEqual(policy);
		await manager.reload();
		expect(manager.getCompactionSettings(model)).toEqual(policy);
		expect(autoCompactAt(model)).toBe(200000 - 24_576);
	});

	it("does not publish customization or a setter", () => {
		expect(SettingsSchema.properties).not.toHaveProperty("compaction");
		expect(SettingsManager.inMemory()).not.toHaveProperty("setCompactionEnabled");
	});
});
