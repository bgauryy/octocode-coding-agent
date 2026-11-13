import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClassifierModel, ImageModel, Model } from "@octocodeai/octocode-ai";
import lockfile from "proper-lockfile";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FileModelsStore } from "../src/core/models-store.ts";

const sharedTempDir = join(
	tmpdir(),
	`octocode-models-store-shared-${Date.now()}-${Math.random().toString(36).slice(2)}`,
);
const sharedModelsPath = join(sharedTempDir, "models-store.json");
const sharedModelsStore = new FileModelsStore(sharedModelsPath);

beforeAll(() => {
	mkdirSync(sharedTempDir, { recursive: true });
});

afterAll(() => {
	if (existsSync(sharedTempDir)) rmSync(sharedTempDir, { recursive: true });
});

afterEach(() => {
	vi.restoreAllMocks();
});

function model(provider: string, id: string): Model<"openai-completions"> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider,
		baseUrl: "https://example.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
	};
}

describe("FileModelsStore", () => {
	it.each(["null", "[]", '"not an object"', "{"])("repopulates an invalid cache root: %s", async (content) => {
		const file = join(sharedTempDir, `invalid-${Math.random().toString(36).slice(2)}.json`);
		writeFileSync(file, content);
		const store = new FileModelsStore(file);
		await expect(store.read("one")).resolves.toBeUndefined();
		await store.write("one", { models: [model("one", "restored")], checkedAt: 100 });
		await expect(store.read("one")).resolves.toMatchObject({ models: [{ id: "restored" }] });
	});

	it("isolates malformed provider entries while preserving healthy catalogs", async () => {
		const file = join(sharedTempDir, "invalid-entries.json");
		const valid = { models: [model("one", "healthy")], checkedAt: 100 };
		writeFileSync(
			file,
			JSON.stringify({
				one: valid,
				null: null,
				list: [],
				missing: {},
				models: { models: [null] },
				fields: { models: [{}] },
				timestamp: { models: [], checkedAt: "invalid" },
				etag: { models: [], etag: {} },
			}),
		);
		const store = new FileModelsStore(file);
		for (const provider of ["null", "list", "missing", "models", "fields", "timestamp", "etag"]) {
			await expect(store.read(provider), provider).resolves.toBeUndefined();
		}
		await store.write("two", { models: [model("two", "new")], checkedAt: 200 });
		expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
			one: valid,
			two: { models: [model("two", "new")], checkedAt: 200 },
		});
	});

	it.each(["input", "cost", "reasoning", "contextWindow", "maxTokens"])(
		"ignores cached chat models missing required %s metadata",
		async (field) => {
			const file = join(sharedTempDir, `missing-${field}.json`);
			const incomplete: Record<string, unknown> = { ...model("one", "incomplete") };
			delete incomplete[field];
			writeFileSync(file, JSON.stringify({ one: { models: [incomplete] } }));
			await expect(new FileModelsStore(file).read("one")).resolves.toBeUndefined();
		},
	);

	it("preserves complete image and classifier models without requiring chat-only metadata", async () => {
		const file = join(sharedTempDir, "non-chat-models.json");
		const base = {
			id: "specialized",
			name: "Specialized",
			provider: "one",
			baseUrl: "https://example.test/v1",
			input: ["text"] as ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		};
		const image: ImageModel<"openrouter-images"> = {
			...base,
			type: "image",
			api: "openrouter-images",
			output: ["image"],
		};
		const classifier: ClassifierModel<"openai-decisions"> = {
			...base,
			type: "classifier",
			api: "openai-decisions",
			contextWindow: 4096,
		};
		const store = new FileModelsStore(file);
		await store.write("one", { models: [image, classifier] });
		await expect(new FileModelsStore(file).read("one")).resolves.toEqual({ models: [image, classifier] });
	});

	it("retains future model types for the runtime's existing version filter", async () => {
		const file = join(sharedTempDir, "future-model-type.json");
		const future = { ...model("one", "future"), type: "future" };
		writeFileSync(file, JSON.stringify({ one: { models: [future] } }));
		await expect(new FileModelsStore(file).read("one")).resolves.toEqual({ models: [future] });
	});

	it("still reports storage failures instead of treating them as disposable cache corruption", async () => {
		const store = new FileModelsStore(join(sharedTempDir, "io-failure.json"));
		vi.spyOn(lockfile, "lock").mockRejectedValue(new Error("Storage unavailable"));
		await expect(store.read("one")).rejects.toThrow("Storage unavailable");
		await expect(store.write("one", { models: [] })).rejects.toThrow("Storage unavailable");
	});

	it("treats provider ids as own keys even when they name Object prototype properties", async () => {
		const file = join(sharedTempDir, "prototype-ids.json");
		const store = new FileModelsStore(file);
		for (const provider of ["constructor", "__proto__", "toString"]) {
			await expect(store.read(provider)).resolves.toBeUndefined();
			await store.write(provider, { models: [model(provider, "saved")] });
		}
		const reloaded = new FileModelsStore(file);
		for (const provider of ["constructor", "__proto__", "toString"]) {
			await expect(reloaded.read(provider)).resolves.toMatchObject({ models: [{ id: "saved" }] });
			await reloaded.delete(provider);
			await expect(reloaded.read(provider)).resolves.toBeUndefined();
		}
	});

	it("persists provider catalogs without replacing unrelated providers", async () => {
		const store = sharedModelsStore;

		await store.write("one", { models: [model("one", "m1")], checkedAt: 100 });
		await store.write("two", { models: [model("two", "m2")], checkedAt: 200 });

		const reloaded = new FileModelsStore(sharedModelsPath);
		expect((await reloaded.read("one"))?.models.map((entry) => entry.id)).toEqual(["m1"]);
		expect((await reloaded.read("one"))?.checkedAt).toBe(100);
		expect((await reloaded.read("two"))?.models.map((entry) => entry.id)).toEqual(["m2"]);

		await reloaded.delete("one");
		expect(await reloaded.read("one")).toBeUndefined();
		expect((await reloaded.read("two"))?.models.map((entry) => entry.id)).toEqual(["m2"]);
	});

	it.skipIf(process.platform === "win32")("preserves the mode of an existing models file", async () => {
		const managedModelsPath = join(sharedTempDir, "managed-mode.json");
		writeFileSync(managedModelsPath, "{}");
		chmodSync(managedModelsPath, 0o660);
		const store = new FileModelsStore(managedModelsPath);

		await store.write("one", { models: [model("one", "m1")], checkedAt: 100 });

		expect(statSync(managedModelsPath).mode & 0o777).toBe(0o660);
	});

	it("coalesces file reloads across concurrent readers and interleaved storage instances", async () => {
		writeFileSync(
			sharedModelsPath,
			JSON.stringify({
				one: { models: [model("one", "old")] },
				two: { models: [model("two", "m2")] },
			}),
		);
		const first = new FileModelsStore(sharedModelsPath);
		const second = new FileModelsStore(sharedModelsPath);
		const lockSpy = vi.spyOn(lockfile, "lock");

		const [one, two, missing] = await Promise.all([
			first.read("one", { signal: new AbortController().signal }),
			second.read("two", { signal: new AbortController().signal }),
			first.read("missing", { signal: new AbortController().signal }),
		]);
		expect(one?.models.map((entry) => entry.id)).toEqual(["old"]);
		expect(two?.models.map((entry) => entry.id)).toEqual(["m2"]);
		expect(missing).toBeUndefined();
		expect(lockSpy).toHaveBeenCalledTimes(1);

		await expect(second.read("one")).resolves.toMatchObject({ models: [{ id: "old" }] });
		expect(lockSpy).toHaveBeenCalledTimes(1);

		const otherPath = join(sharedTempDir, "other-models-store.json");
		writeFileSync(otherPath, "{}");
		const other = new FileModelsStore(otherPath);
		await expect(other.read("one")).resolves.toBeUndefined();
		await expect(other.read("one")).resolves.toBeUndefined();
		const third = new FileModelsStore(sharedModelsPath);
		writeFileSync(sharedModelsPath, JSON.stringify({ one: { models: [model("one", "newest-model")] } }));
		const [firstReload, thirdReload] = await Promise.all([first.read("one"), third.read("one")]);
		expect(firstReload).toMatchObject({ models: [{ id: "newest-model" }] });
		expect(thirdReload).toMatchObject({ models: [{ id: "newest-model" }] });
		expect(lockSpy).toHaveBeenCalledTimes(3);
	});

	it("keeps a coalesced reload alive while another reader is still waiting", async () => {
		writeFileSync(sharedModelsPath, JSON.stringify({ one: { models: [model("one", "stored")] } }));
		const store = new FileModelsStore(sharedModelsPath);
		let grantLock: (() => void) | undefined;
		const lockGranted = new Promise<void>((resolve) => {
			grantLock = resolve;
		});
		const release = vi.fn(async () => {});
		const lockSpy = vi.spyOn(lockfile, "lock").mockImplementation(async () => {
			await lockGranted;
			return release;
		});
		const firstController = new AbortController();
		const secondController = new AbortController();
		const first = store.read("one", { signal: firstController.signal });
		const second = store.read("one", { signal: secondController.signal });

		firstController.abort();
		await expect(first).rejects.toMatchObject({ name: "AbortError" });
		grantLock?.();
		await expect(second).resolves.toMatchObject({ models: [{ id: "stored" }] });
		expect(lockSpy).toHaveBeenCalledTimes(1);
		expect(release).toHaveBeenCalledTimes(1);
	});

	it("cancels a catalog write waiting for a held file lock without writing later", async () => {
		writeFileSync(sharedModelsPath, JSON.stringify({ one: { models: [model("one", "existing")] } }));
		const store = new FileModelsStore(sharedModelsPath);
		const release = await lockfile.lock(sharedModelsPath, { realpath: false });
		const controller = new AbortController();
		const pending = store.write("two", { models: [model("two", "cancelled")] }, { signal: controller.signal });

		await new Promise((resolve) => setTimeout(resolve, 10));
		controller.abort();
		await expect(pending).rejects.toMatchObject({ name: "AbortError" });
		await release();
		await new Promise((resolve) => setTimeout(resolve, 150));

		const stored = JSON.parse(readFileSync(sharedModelsPath, "utf8")) as Record<string, unknown>;
		expect(stored.one).toBeDefined();
		expect(stored.two).toBeUndefined();
	});
});
