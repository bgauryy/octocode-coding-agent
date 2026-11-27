import { type AnyModel, createModels, createProvider, InMemoryModelsStore, type Model } from "@octocodeai/octocode-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withPersonalizedCatalog, withRemoteCatalog } from "../src/core/remote-catalog-provider.ts";

// C0/C1 controls (ESC and CSI included), line separators and bidi or zero-width formatting characters.
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/u;

function model(id: unknown, name: unknown = id): Model<"openai-completions"> {
	return {
		id,
		name,
		api: "openai-completions",
		provider: "test-provider",
		baseUrl: "https://example.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
	} as Model<"openai-completions">;
}

function builtinProvider() {
	const unused = () => {
		throw new Error("not used");
	};
	return createProvider({
		id: "test-provider",
		auth: { apiKey: { name: "Test", resolve: async () => ({ auth: {} }) } },
		models: [model("static")],
		api: { stream: unused, streamSimple: unused },
	});
}

function expectNoControls(models: readonly AnyModel[]): void {
	for (const entry of models) {
		expect(typeof entry.id).toBe("string");
		expect(typeof entry.name).toBe("string");
		expect(entry.id).not.toMatch(CONTROL);
		expect(entry.name).not.toMatch(CONTROL);
	}
}

const hostileCatalog = {
	clean: model("clean", "\u001b]0;pwned\u0007Clean\u202e \u001b[31mname\n"),
	escape: model("evil\u001b[2J"),
	bidi: model("gpt\u202e4o"),
	c1: model("model\u009b2J"),
	numeric: model(42),
	nameless: model("nameless", { text: "not a string" }),
	blank: model("blank", "\u001b[2J\u200b"),
	routed: model("openai/gpt-4o:free", "GPT-4o (free)"),
};

afterEach(() => vi.restoreAllMocks());

describe("remote catalog text from the network", () => {
	it("drops entries whose id holds a control, and strips controls from names, before the registry sees them", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json(hostileCatalog));
		const store = new InMemoryModelsStore();
		const provider = withRemoteCatalog(builtinProvider(), "https://catalog.example");
		const models = createModels({ modelsStore: store });
		models.setProvider(provider);

		const result = await models.refresh({ providers: [provider.id], force: true });

		expect([...result.errors.values()]).toEqual([]);
		const listed = models.getAllModels("test-provider");
		expect(listed.map((entry) => [entry.id, entry.name])).toEqual([
			["static", "static"],
			["clean", "Clean name"],
			["nameless", "nameless"],
			["blank", "blank"],
			["openai/gpt-4o:free", "GPT-4o (free)"],
		]);
		expectNoControls(listed);
		expectNoControls((await store.read(provider.id))?.models ?? []);
	});

	it("drops hostile entries restored from a catalog saved by an older client", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		for (const wrap of [
			() => withRemoteCatalog(builtinProvider(), "https://catalog.example"),
			() => withPersonalizedCatalog(builtinProvider(), async (catalog) => catalog, "https://catalog.example"),
		]) {
			const store = new InMemoryModelsStore();
			const provider = wrap();
			await store.write(provider.id, {
				models: Object.values(hostileCatalog),
				checkedAt: Date.now(),
				lastModified: Date.now(),
			});
			const models = createModels({ modelsStore: store });
			models.setProvider(provider);

			await models.refresh({ providers: [provider.id], allowNetwork: false });

			const listed = models.getAllModels("test-provider");
			expect(listed.map((entry) => entry.id)).toEqual(
				expect.arrayContaining(["clean", "nameless", "blank", "openai/gpt-4o:free"]),
			);
			expectNoControls(listed);
		}
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("reports an unparsable catalog without echoing the response body", async () => {
		const body = "\u001b]0;pwned\u0007 not json";
		vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(body, { status: 200 }));
		const provider = withRemoteCatalog(builtinProvider(), "https://catalog.example");
		const models = createModels({ modelsStore: new InMemoryModelsStore() });
		models.setProvider(provider);

		const result = await models.refresh({ providers: [provider.id], force: true });

		const error = result.errors.get(provider.id);
		expect(error?.message).toBe('Invalid model catalog for provider "test-provider"');
		expect(error?.message).not.toMatch(CONTROL);
	});
});
