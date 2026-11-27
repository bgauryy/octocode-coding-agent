import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryModelsStore, type MutableModels } from "@octocodeai/octocode-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelConfig } from "../src/core/model-config.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { REFRESH_REUSE_MS } from "../src/core/model-runtime/refresh-reuse.ts";

const dirs: string[] = [];
const runtimes: ModelRuntime[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const runtime of runtimes.splice(0)) runtime.dispose();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A models.json with one provider; with a key it is configured, without one it waits for a credential. */
function modelsJson(id: string, apiKey?: string): string {
	const provider = { baseUrl: "https://example.test/v1", api: "openai-completions", models: [{ id: `${id}-model` }] };
	return JSON.stringify({ providers: { [id]: apiKey ? { ...provider, apiKey } : provider } });
}

async function setup(json: string) {
	const dir = mkdtempSync(join(tmpdir(), "octocode-refresh-reuse-"));
	dirs.push(dir);
	const modelsPath = join(dir, "models.json");
	writeFileSync(modelsPath, json);
	const credentials = AuthStorage.inMemory();
	const runtime = await ModelRuntime.create({
		credentials,
		modelsPath,
		modelsStore: new InMemoryModelsStore(),
		allowModelNetwork: false,
	});
	runtimes.push(runtime);
	// The first interactive refresh is a full one and is remembered.
	await runtime.refresh({ reuse: true });
	const load = vi.spyOn(ModelConfig, "load");
	const catalogs = vi.spyOn((runtime as unknown as { models: MutableModels }).models, "refresh");
	return { runtime, modelsPath, credentials, load, catalogs };
}

const availableIds = (runtime: ModelRuntime) => runtime.getAvailableSnapshot().map((model) => model.id);

describe("an interactive refresh (an open of /model) reuses a recent full refresh", () => {
	it("skips the models.json reload and the catalog refresh while nothing they read changed", async () => {
		const { runtime, load, catalogs } = await setup(modelsJson("keyed", "key"));

		const result = await runtime.refresh({ reuse: true });

		expect(result).toEqual({ aborted: false, errors: new Map() });
		expect(load).not.toHaveBeenCalled();
		expect(catalogs).not.toHaveBeenCalled();
		expect(availableIds(runtime)).toContain("keyed-model");
	});

	it("reloads a models.json changed since, before its watcher reloads it", async () => {
		const { runtime, modelsPath, load } = await setup(modelsJson("keyed", "key"));
		writeFileSync(modelsPath, modelsJson("replaced", "key"));

		await runtime.refresh({ reuse: true });

		expect(load).toHaveBeenCalledOnce();
		expect(runtime.getModel("replaced", "replaced-model")).toBeDefined();
		expect(runtime.getModel("keyed", "keyed-model")).toBeUndefined();
	});

	it("re-checks credentials: a provider signed in since shows its models and gets its catalog refreshed", async () => {
		const { runtime, credentials, catalogs } = await setup(modelsJson("bare"));
		expect(availableIds(runtime)).not.toContain("bare-model");
		// Outside the runtime's refresh path, like a credential another tool wrote.
		await credentials.modify("bare", async () => ({ type: "api_key", key: "key" }));

		await runtime.refresh({ reuse: true });

		expect(availableIds(runtime)).toContain("bare-model");
		expect(catalogs).toHaveBeenCalledOnce();
		expect(catalogs).toHaveBeenCalledWith(expect.objectContaining({ providers: ["bare"] }));
	});

	it("refreshes fully when asked without reuse, once the window passed, or after a partial refresh", async () => {
		const { runtime, load } = await setup(modelsJson("keyed", "key"));

		await runtime.refresh();
		expect(load).toHaveBeenCalledTimes(1);
		// The explicit refresh was full: it is remembered like any other.
		await runtime.refresh({ reuse: true });
		expect(load).toHaveBeenCalledTimes(1);

		const now = Date.now();
		vi.spyOn(Date, "now").mockReturnValue(now + REFRESH_REUSE_MS + 1);
		await runtime.refresh({ reuse: true });
		expect(load).toHaveBeenCalledTimes(2);

		await runtime.refresh({ providers: ["keyed"] });
		expect(load).toHaveBeenCalledTimes(3);
		await runtime.refresh({ reuse: true });
		expect(load).toHaveBeenCalledTimes(4);
	});
});
