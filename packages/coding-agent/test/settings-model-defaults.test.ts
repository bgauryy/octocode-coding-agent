import { describe, expect, it } from "vitest";
import { SettingsManager, type SettingsStorage } from "../src/core/settings-manager.ts";
import { deferSettingsWrites } from "../src/core/settings-manager/storage-deferred.ts";

class Storage implements SettingsStorage {
	content = JSON.stringify({ defaultProvider: "previous", defaultModel: "old-model", theme: "dark" });
	writes = 0;
	failures = 0;
	withLock(
		_scope: "global" | "project",
		change: (current: string | undefined) => string | undefined,
		_options?: { readOnly?: boolean },
	): void {
		const next = change(this.content);
		if (next === undefined) return;
		this.writes++;
		if (this.failures-- > 0) throw new Error("fixture write failed");
		this.content = next;
	}
}

describe("saving a default model", () => {
	it("writes the model, provider, optional thinking and enabled scope in one transaction and survives reload", async () => {
		const storage = new Storage();
		storage.content = JSON.stringify({
			theme: "dark",
			modelThinkingLevels: { "previous/old-model": "low" },
		});
		const settings = SettingsManager.fromStorage(storage);
		await settings.saveDefaultModelSelection("ollama", "qwen3:latest", {
			thinkingLevel: "high",
			enabledModels: ["ollama/qwen3:latest"],
		});
		expect(storage.writes).toBe(1);
		const restarted = SettingsManager.fromStorage(storage);
		expect(restarted.getDefaultProvider()).toBe("ollama");
		expect(restarted.getDefaultModel()).toBe("qwen3:latest");
		expect(restarted.getEnabledModels()).toEqual(["ollama/qwen3:latest"]);
		expect(restarted.getAllModelThinkingLevels()).toEqual({
			"previous/old-model": "low",
			"ollama/qwen3:latest": "high",
		});
		expect(restarted.getTheme()).toBe("dark");
	});

	it("leaves thinking preferences untouched unless the caller supplies them", async () => {
		const storage = new Storage();
		const settings = SettingsManager.fromStorage(storage);
		await settings.saveDefaultModelSelection("claude-code", "sonnet");
		expect(JSON.parse(storage.content)).not.toHaveProperty("modelThinkingLevels");
	});

	it("rejects failed storage, restores the attempted settings, preserves diagnostics and permits a later retry", async () => {
		const storage = new Storage();
		storage.failures = 1;
		const original = storage.content;
		const settings = SettingsManager.fromStorage(storage);
		await expect(
			settings.saveDefaultModelSelection("ollama", "qwen3:latest", {
				thinkingLevel: "high",
				enabledModels: ["ollama/qwen3:latest"],
			}),
		).rejects.toThrow("fixture write failed");
		expect(storage.content).toBe(original);
		expect(settings.getDefaultProvider()).toBe("previous");
		expect(settings.getDefaultModel()).toBe("old-model");
		expect(settings.getEnabledModels()).toBeUndefined();
		expect(settings.getAllModelThinkingLevels()).toEqual({});
		await expect(settings.flush()).resolves.toBeUndefined();
		await settings.saveDefaultModelSelection("claude-code", "sonnet");
		expect(settings.getDefaultModel()).toBe("sonnet");
		expect(settings.drainErrors()).toEqual([
			expect.objectContaining({ scope: "global", error: expect.objectContaining({ message: "fixture write failed" }) }),
		]);
	});

	it("does not roll back a newer successful choice when an earlier identical choice fails", async () => {
		const storage = new Storage();
		storage.failures = 1;
		const settings = SettingsManager.fromStorage(storage);
		const first = settings.saveDefaultModelSelection("claude-code", "sonnet");
		const second = settings.saveDefaultModelSelection("claude-code", "sonnet");
		await expect(first).rejects.toThrow("fixture write failed");
		await second;
		expect(settings.getDefaultProvider()).toBe("claude-code");
		expect(settings.getDefaultModel()).toBe("sonnet");
		expect(JSON.parse(storage.content).defaultModel).toBe("sonnet");
	});

	it("refuses an invalid settings file before changing the default", async () => {
		const storage = new Storage();
		storage.content = "{ invalid json";
		const settings = SettingsManager.fromStorage(storage);
		await expect(settings.saveDefaultModelSelection("claude-code", "sonnet")).rejects.toThrow();
		expect(settings.getDefaultProvider()).toBeUndefined();
		expect(settings.getDefaultModel()).toBeUndefined();
		expect(storage.writes).toBe(0);
		expect(storage.content).toBe("{ invalid json");
		expect(settings.drainErrors()).toHaveLength(1);
	});

	it("restores the committed default when overlapping choices both fail", async () => {
		const storage = new Storage();
		storage.failures = 2;
		const settings = SettingsManager.fromStorage(storage);
		await Promise.allSettled([
			settings.saveDefaultModelSelection("ollama", "qwen3:latest"),
			settings.saveDefaultModelSelection("claude-code", "sonnet"),
		]);
		expect(settings.getDefaultProvider()).toBe("previous");
		expect(settings.getDefaultModel()).toBe("old-model");
	});

	it("keeps the existing nonthrow synchronous-setter and flush contract on storage failure", async () => {
		const storage = new Storage();
		storage.failures = 1;
		const settings = SettingsManager.fromStorage(storage);
		settings.setDefaultModelAndProvider("claude-code", "sonnet");
		await expect(settings.flush()).resolves.toBeUndefined();
		expect(settings.drainErrors()).toHaveLength(1);
	});

	it("waits for a deferred commit and rejects its exact failure", async () => {
		deferSettingsWrites();
		const storage = new Storage();
		let fail!: (error: Error) => void;
		let notifyStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			notifyStarted = resolve;
		});
		const deferred: SettingsStorage = {
			withLock: storage.withLock.bind(storage),
			withLockDeferred: () =>
				new Promise<void>((_resolve, reject) => {
					fail = reject;
					notifyStarted();
				}),
		};
		const settings = SettingsManager.fromStorage(deferred);
		let settled = false;
		const saving = settings.saveDefaultModelSelection("ollama", "qwen3:latest");
		const checked = saving.finally(() => {
			settled = true;
		});
		await started;
		expect(settled).toBe(false);
		fail(new Error("deferred fixture failed"));
		await expect(checked).rejects.toThrow("deferred fixture failed");
		expect(settings.getDefaultProvider()).toBe("previous");
		expect(settings.drainErrors()).toHaveLength(1);
	});
});
