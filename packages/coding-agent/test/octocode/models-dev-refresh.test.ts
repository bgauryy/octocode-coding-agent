import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { indexCatalog } from "../../src/core/model-catalog/index-shape.ts";
import type * as CatalogModule from "../../src/core/model-catalog/index-store.ts";
import type * as StatusModule from "../../src/core/model-catalog/status.ts";
// The catalog is fresh for a day.
import { DAY_MS as CATALOG_TTL_MS } from "../../src/octocode/shared/util.ts";
import { tmp } from "./helpers.ts";

const api = {
	anthropic: {
		models: { "claude-small-1": { tool_call: true, canonical_model_id: "anthropic/claude-small-1" } },
	},
};

// The module keeps per-process state (a request in flight, an hour's pause after a failed fetch): a test that ran
// earlier in this worker with the network blocked must not decide whether these tests fetch.
let catalog: typeof CatalogModule;
let catalogStatus: typeof StatusModule.catalogStatus;
beforeEach(async () => {
	vi.resetModules();
	catalog = await import("../../src/core/model-catalog/index-store.ts");
	({ catalogStatus } = await import("../../src/core/model-catalog/status.ts"));
});

afterEach(() => {
	vi.restoreAllMocks();
});

// "earlier": an index saved before per-provider listings were recorded (by an earlier Octocode), still fresh.
type Saved = "missing" | "fresh" | "stale" | "reordered" | "truncated" | "earlier";

/** A home whose saved index is in state `saved`; the file and the env that names it. */
async function home(saved: Saved): Promise<{ env: NodeJS.ProcessEnv; file: string }> {
	const env = { OCTOCODE_HOME: tmp(), OCTOCODE_MODELS_DEV: "1" };
	const file = catalog.catalogFile(env);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const fetchedAt = Date.now() - (saved === "stale" ? CATALOG_TTL_MS + 1000 : 1000);
	const index = indexCatalog(api, fetchedAt);
	if (saved === "missing") return { env, file };
	// A current index comes with its built-in listings file, as a fetch saves them.
	await catalog.saveCatalog(file, index);
	const text =
		saved === "reordered"
			? JSON.stringify({
					models: index.models,
					listings: index.listings,
					providers: index.providers,
					version: index.version,
					fetchedAt,
				})
			: saved === "earlier"
				? JSON.stringify({ fetchedAt, models: { "claude-small-1": { toolCall: true } }, providers: ["anthropic"] })
				: JSON.stringify(index);
	fs.writeFileSync(file, saved === "truncated" ? text.slice(0, -5) : text);
	return { env, file };
}

/** What starting a session's refresh did: whether it fetched, and whether it read the saved file whole. */
async function observe(start: (env: NodeJS.ProcessEnv) => unknown, saved: Saved) {
	const { env, file } = await home(saved);
	const fetched = vi
		.spyOn(globalThis, "fetch")
		.mockImplementation(async () => new Response(JSON.stringify(api), { status: 200 }));
	const reads = vi.spyOn(fs, "readFileSync");
	start(env);
	const readWhole = reads.mock.calls.some(([name]) => name === file);
	const didFetch = fetched.mock.calls.length > 0;
	// Let a started refresh finish, so the next case starts with none in flight.
	if (didFetch) {
		// The rename can become visible before the write's directory flush and request cleanup finish.
		await catalog.loadCatalog({ file });
		await vi.waitFor(() => expect(catalog.readCatalog(file)?.fetchedAt).toBeGreaterThan(Date.now() - 60_000));
	}
	vi.restoreAllMocks();
	return { didFetch, readWhole, after: catalog.readCatalog(file) };
}

describe("refreshCatalog", () => {
	it.each<Saved>(["missing", "fresh", "stale", "reordered", "truncated", "earlier"])(
		"starts the same refresh as currentCatalog (%s index)",
		async (saved) => {
			const today = await observe((env) => catalog.currentCatalog(env), saved);
			const now = await observe((env) => catalog.refreshCatalog(env), saved);
			expect(now.didFetch).toBe(today.didFetch);
			expect(now.after?.providers).toEqual(today.after?.providers);
			expect(Object.keys(now.after?.models ?? {})).toEqual(Object.keys(today.after?.models ?? {}));
		},
	);

	it("fetches only a missing, stale, unreadable or earlier index", async () => {
		// One at a time: a process runs one refresh, which a concurrent call joins.
		const fetched: Array<[Saved, boolean]> = [];
		for (const saved of ["missing", "fresh", "stale", "reordered", "truncated", "earlier"] as const)
			fetched.push([saved, (await observe((env) => catalog.refreshCatalog(env), saved)).didFetch]);
		expect(Object.fromEntries(fetched)).toEqual({
			missing: true,
			fresh: false,
			stale: true,
			reordered: false,
			truncated: true,
			// N11: an index without per-provider listings left catalog updates inert for a day; it is refetched now.
			earlier: true,
		});
	});

	it("does not parse a fresh saved index; its first reader still gets it", async () => {
		const fresh = await observe((env) => catalog.refreshCatalog(env), "fresh");
		expect(fresh.readWhole).toBe(false);
		expect(fresh.after?.models["claude-small-1"]).toEqual({ toolCall: true, lab: "anthropic" });
		// A file it cannot vouch for from its first bytes is read whole, as before.
		expect((await observe((env) => catalog.refreshCatalog(env), "reordered")).readWhole).toBe(true);
	});

	it("currentCatalog answers routing from a fresh index without parsing it whole", async () => {
		const fresh = await observe((env) => catalog.currentCatalog(env), "fresh");
		expect(fresh.didFetch).toBe(false);
		expect(fresh.readWhole).toBe(false);
		expect(fresh.after?.models["claude-small-1"]).toEqual({ toolCall: true, lab: "anthropic" });
	});

	it("does nothing with models.dev off or offline", async () => {
		const { env, file } = await home("missing");
		const fetched = vi.spyOn(globalThis, "fetch");
		catalog.refreshCatalog({ ...env, OCTOCODE_MODELS_DEV: "0" });
		// N11: `--offline` sets OCTOCODE_OFFLINE; no path fetches the index then.
		const offline = { ...env, OCTOCODE_OFFLINE: "1" };
		catalog.refreshCatalog(offline);
		expect(catalog.currentCatalog(offline)).toBeUndefined();
		expect(await catalog.loadCatalog({ file, env: offline })).toBeUndefined();
		expect(fetched).not.toHaveBeenCalled();
		expect(fs.existsSync(file)).toBe(false);
		expect(catalogStatus(offline)).toMatchObject({ stale: true, problem: "offline: the index is not refreshed" });
		expect(catalogStatus(offline).inert).toMatch(/offline/);
	});
});

describe("an index that cannot be saved", () => {
	it("is kept in memory and not fetched again on every call (N11)", async () => {
		const env = { OCTOCODE_HOME: tmp(), OCTOCODE_MODELS_DEV: "1" };
		const file = catalog.catalogFile(env);
		// The state folder's path is taken by a file, as on a read-only or foreign-owned home.
		fs.mkdirSync(path.dirname(path.dirname(file)), { recursive: true });
		fs.writeFileSync(path.dirname(file), "not a folder");
		const fetched = vi
			.spyOn(globalThis, "fetch")
			.mockImplementation(async () => new Response(JSON.stringify(api), { status: 200 }));
		for (let call = 0; call < 3; call++) {
			catalog.currentCatalog(env);
			expect((await catalog.loadCatalog({ file, env }))?.models["claude-small-1"]).toBeDefined();
		}
		expect(fetched).toHaveBeenCalledTimes(1);
		expect(catalog.currentCatalog(env)?.models["claude-small-1"]).toBeDefined();
		expect(catalog.readListings(["anthropic"], file)?.("anthropic")?.["claude-small-1"]).toBeDefined();
		expect(catalogStatus(env)).toMatchObject({ source: "live", stale: false });
		expect(catalogStatus(env).problem).toMatch(/index not saved/);
	});
});

describe("catalogStatus", () => {
	it("says why catalog updates are inert", async () => {
		const missing = await home("missing");
		expect(catalogStatus({ ...missing.env, OCTOCODE_MODELS_DEV: "0" })).toMatchObject({
			source: "off",
			inert: expect.stringMatching(/OCTOCODE_MODELS_DEV=0/),
		});
		expect(catalogStatus(missing.env).inert).toMatch(/no models\.dev index yet/);
		const earlier = await home("earlier");
		expect(catalogStatus(earlier.env).inert).toMatch(/predates per-provider listings/);
		// The bundled catalog in this checkout carries no models.dev sources until it is hydrated again.
		const fresh = await home("fresh");
		const status = catalogStatus(fresh.env);
		expect(status.stale).toBe(false);
		if (status.inert) expect(status.inert).toMatch(/does not record its models\.dev sources/);
	});
});

describe("loadCatalog overlapping refreshes", () => {
	it("keeps one request per index file and never hands one file's index to another", async () => {
		const first = await home("missing");
		const second = await home("missing");
		let release: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => (release = resolve));
		const fetched = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
			await gate;
			return new Response(JSON.stringify(api), { status: 200 });
		});
		const calls = [
			catalog.loadCatalog({ file: first.file }),
			catalog.loadCatalog({ file: first.file }),
			catalog.loadCatalog({ file: second.file }),
		];
		release();
		await Promise.all(calls);
		expect(fetched.mock.calls.length).toBe(2);
		expect(catalog.readCatalog(first.file)).toBeDefined();
		expect(catalog.readCatalog(second.file)).toBeDefined();
	});

	it("does not overwrite an index a newer fetch already saved", async () => {
		const { file } = await home("missing");
		vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
			// A current index: one saved by an earlier Octocode is replaced (see "earlier" above).
			const newer = indexCatalog({ x: { models: { newer: { tool_call: true } } } }, Date.now() + 60_000);
			fs.writeFileSync(file, JSON.stringify(newer));
			return new Response(JSON.stringify(api), { status: 200 });
		});
		const result = await catalog.loadCatalog({ file });
		expect(result?.models).toHaveProperty("newer");
		expect(catalog.readCatalog(file)?.models).toHaveProperty("newer");
	});
});
