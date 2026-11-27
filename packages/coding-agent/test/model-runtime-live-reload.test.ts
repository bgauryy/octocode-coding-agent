import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";

const dirs: string[] = [];
const runtimes: ModelRuntime[] = [];
afterEach(() => {
	for (const runtime of runtimes.splice(0)) runtime.dispose();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Atomic write, as an editor or another Octocode process would do it. */
function writeAtomic(path: string, content: unknown): void {
	const temp = `${path}.tmp`;
	writeFileSync(temp, JSON.stringify(content));
	renameSync(temp, path);
}

const providerOverride = {
	"gateway-provider": {
		baseUrl: "https://gateway.example.test/v1",
		api: "openai-completions",
		apiKey: "gateway-key",
		models: [{ id: "gateway-model", name: "Gateway" }],
	},
};

describe("ModelRuntime follows models.json while running", () => {
	it("loads the new definition when models.json and auth.json change together", async () => {
		const dir = mkdtempSync(join(tmpdir(), "octocode-models-watch-"));
		dirs.push(dir);
		const authPath = join(dir, "auth.json");
		const modelsPath = join(dir, "models.json");
		writeAtomic(authPath, { openai: { type: "api_key", key: "stored-key" } });
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.create(authPath),
			modelsPath,
			allowModelNetwork: false,
		});
		runtimes.push(runtime);
		expect(runtime.getAvailableSnapshot().some((entry) => entry.provider === "openai")).toBe(true);
		expect(runtime.getModel("gateway-provider", "gateway-model")).toBeUndefined();

		writeAtomic(modelsPath, { providers: providerOverride });
		writeAtomic(authPath, {});

		await expect
			.poll(() => runtime.getModel("gateway-provider", "gateway-model")?.baseUrl, { timeout: 5000 })
			.toBe("https://gateway.example.test/v1");
		await expect
			.poll(() => runtime.getAvailableSnapshot().map((entry) => `${entry.provider}/${entry.id}`), { timeout: 5000 })
			.toContain("gateway-provider/gateway-model");
	});

	it("stops watching once disposed", async () => {
		const dir = mkdtempSync(join(tmpdir(), "octocode-models-watch-"));
		dirs.push(dir);
		const modelsPath = join(dir, "models.json");
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsPath,
			allowModelNetwork: false,
		});
		runtime.dispose();
		writeAtomic(modelsPath, { providers: providerOverride });
		await new Promise((resolve) => setTimeout(resolve, 700));
		expect(runtime.getModel("gateway-provider", "gateway-model")).toBeUndefined();
	});
});
