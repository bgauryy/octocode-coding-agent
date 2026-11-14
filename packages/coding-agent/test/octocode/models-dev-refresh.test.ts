import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as CatalogModule from "../../src/octocode/subagents/catalog.ts";
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
beforeEach(async () => {
	vi.resetModules();
	catalog = await import("../../src/octocode/subagents/catalog.ts");
});

afterEach(() => {
	vi.restoreAllMocks();
});

type Saved = "missing" | "fresh" | "stale" | "reordered" | "truncated";

/** A home whose saved index is in state `saved`; the file and the env that names it. */
function home(saved: Saved): { env: NodeJS.ProcessEnv; file: string } {
	const env = { OCTOCODE_HOME: tmp(), OCTOCODE_MODELS_DEV: "1" };
	const file = catalog.catalogFile(env);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const fetchedAt = Date.now() - (saved === "stale" ? CATALOG_TTL_MS + 1000 : 1000);
	const index = { fetchedAt, models: { "claude-small-1": { toolCall: true } }, providers: ["anthropic"] };
	const text =
		saved === "reordered"
			? JSON.stringify({ models: index.models, providers: index.providers, fetchedAt })
			: JSON.stringify(index);
	if (saved !== "missing") fs.writeFileSync(file, saved === "truncated" ? text.slice(0, -5) : text);
	return { env, file };
}

/** What starting a session's refresh did: whether it fetched, and whether it read the saved file whole. */
async function observe(start: (env: NodeJS.ProcessEnv) => unknown, saved: Saved) {
	const { env, file } = home(saved);
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
	it.each<Saved>(["missing", "fresh", "stale", "reordered", "truncated"])(
		"starts the same refresh as currentCatalog (%s index)",
		async (saved) => {
			const today = await observe((env) => catalog.currentCatalog(env), saved);
			const now = await observe((env) => catalog.refreshCatalog(env), saved);
			expect(now.didFetch).toBe(today.didFetch);
			expect(now.after?.providers).toEqual(today.after?.providers);
			expect(Object.keys(now.after?.models ?? {})).toEqual(Object.keys(today.after?.models ?? {}));
		},
	);

	it("fetches only a missing, stale or unreadable index", async () => {
		// One at a time: a process runs one refresh, which a concurrent call joins.
		const fetched: Array<[Saved, boolean]> = [];
		for (const saved of ["missing", "fresh", "stale", "reordered", "truncated"] as const)
			fetched.push([saved, (await observe((env) => catalog.refreshCatalog(env), saved)).didFetch]);
		expect(Object.fromEntries(fetched)).toEqual({
			missing: true,
			fresh: false,
			stale: true,
			reordered: false,
			truncated: true,
		});
	});

	it("does not parse a fresh saved index; its first reader still gets it", async () => {
		const fresh = await observe((env) => catalog.refreshCatalog(env), "fresh");
		expect(fresh.readWhole).toBe(false);
		expect(fresh.after?.models["claude-small-1"]).toEqual({ toolCall: true });
		// A file it cannot vouch for from its first bytes is read whole, as before.
		expect((await observe((env) => catalog.refreshCatalog(env), "reordered")).readWhole).toBe(true);
	});

	it("does nothing with models.dev off", async () => {
		const { env, file } = home("missing");
		const fetched = vi.spyOn(globalThis, "fetch");
		catalog.refreshCatalog({ ...env, OCTOCODE_MODELS_DEV: "0" });
		expect(fetched).not.toHaveBeenCalled();
		expect(fs.existsSync(file)).toBe(false);
	});
});
