import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { loadSettledConfig } from "../src/core/model-runtime/settled-config.ts";

const dirs: string[] = [];
const runtimes: ModelRuntime[] = [];
afterEach(() => {
	for (const runtime of runtimes.splice(0)) runtime.dispose();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function writeAtomic(path: string, text: string): void {
	writeFileSync(`${path}.tmp`, text);
	renameSync(`${path}.tmp`, path);
}

const valid = JSON.stringify({
	providers: {
		"anthropic-custom": {
			baseUrl: "https://gateway.example.test/v1",
			api: "openai-completions",
			apiKey: "gateway-key",
			models: [{ id: "custom-model", name: "Custom" }],
		},
	},
});

async function start(text: string) {
	const dir = mkdtempSync(join(tmpdir(), "octocode-reload-pin-"));
	dirs.push(dir);
	const modelsPath = join(dir, "models.json");
	writeAtomic(modelsPath, text);
	const runtime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory(),
		modelsPath,
		allowModelNetwork: false,
	});
	runtimes.push(runtime);
	return { runtime, modelsPath };
}

describe("a models.json reload never fails a running turn", () => {
	it("completes a turn and a compaction on a model whose provider the reload removed, and says so once", async () => {
		const { runtime, modelsPath } = await start(valid);
		const model = runtime.getModel("anthropic-custom", "custom-model");
		expect(model).toBeDefined();
		const removed = vi.fn();
		runtime.onProvidersRemoved(removed);

		writeAtomic(modelsPath, JSON.stringify({ providers: {} }));
		await expect.poll(() => runtime.getModel("anthropic-custom", "custom-model"), { timeout: 5000 }).toBeUndefined();

		const signal = AbortSignal.abort();
		const context = { messages: [{ role: "user" as const, content: "hi", timestamp: 0 }] };
		// Provider and auth resolve (the request then fails on the aborted signal, never on "Unknown provider").
		for (const run of [
			() => runtime.completeSimple(model!, context, { signal }),
			() => runtime.completeSimple(model!, { ...context, systemPrompt: "Summarize." }, { signal }),
		]) {
			const result = await run().catch((error: unknown) => error);
			const text = result instanceof Error ? result.message : JSON.stringify(result);
			expect(text).not.toContain("Unknown provider");
			expect(text).not.toContain("not configured");
		}
		expect(removed).toHaveBeenCalledTimes(1);
		expect(removed).toHaveBeenCalledWith(["anthropic-custom"]);
	});

	it("applies only the valid file after a truncated or invalid one", async () => {
		const { runtime, modelsPath } = await start(valid);
		const removed = vi.fn();
		runtime.onProvidersRemoved(removed);

		writeAtomic(modelsPath, valid.slice(0, 40));
		await expect.poll(() => runtime.getReloadError(), { timeout: 5000 }).toBeTruthy();
		expect(runtime.getModel("anthropic-custom", "custom-model")).toBeDefined();
		writeAtomic(modelsPath, "{ not json");
		writeAtomic(modelsPath, valid);
		await expect.poll(() => runtime.getReloadError(), { timeout: 5000 }).toBeUndefined();
		expect(runtime.getModel("anthropic-custom", "custom-model")).toBeDefined();
		expect(removed).not.toHaveBeenCalled();
	});

	it("does not trust a read until the file stays unchanged across the settle", async () => {
		const { modelsPath } = await start(valid);
		const pending = loadSettledConfig(modelsPath, 120);
		setTimeout(() => writeAtomic(modelsPath, "{ half"), 30);
		setTimeout(() => writeAtomic(modelsPath, valid), 200);
		const config = await pending;
		expect(config.isUnreadable()).toBe(false);
		expect(config.getProviderIds()).toContain("anthropic-custom");
	});
});
