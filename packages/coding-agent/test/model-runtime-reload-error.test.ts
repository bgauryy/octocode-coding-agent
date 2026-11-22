import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";

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

const provider = {
	providers: {
		"gateway-provider": {
			baseUrl: "https://gateway.example.test/v1",
			api: "openai-completions",
			apiKey: "gateway-key",
			models: [{ id: "gateway-model", name: "Gateway" }],
		},
	},
};

describe("a failed live reload is reported", () => {
	it("keeps the old providers, reports the reason once, and clears it after a good reload", async () => {
		const dir = mkdtempSync(join(tmpdir(), "octocode-reload-error-"));
		dirs.push(dir);
		const modelsPath = join(dir, "models.json");
		writeAtomic(modelsPath, JSON.stringify(provider));
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsPath,
			allowModelNetwork: false,
		});
		runtimes.push(runtime);
		expect(runtime.getModel("gateway-provider", "gateway-model")).toBeDefined();
		expect(runtime.getReloadError()).toBeUndefined();
		const listener = vi.fn();
		runtime.onReloadError(listener);

		writeAtomic(modelsPath, "{ not json");
		await expect.poll(() => runtime.getReloadError(), { timeout: 5000 }).toBeTruthy();
		expect(runtime.getModel("gateway-provider", "gateway-model")).toBeDefined();
		expect(listener).toHaveBeenCalledTimes(1);
		expect(listener.mock.calls[0]?.[0]).toBe(runtime.getReloadError());

		writeAtomic(modelsPath, JSON.stringify(provider));
		await expect.poll(() => runtime.getReloadError(), { timeout: 5000 }).toBeUndefined();
	});
});
