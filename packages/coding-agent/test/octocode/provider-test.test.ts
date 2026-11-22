import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { describeUnserved, servedModelReport } from "../../src/octocode/subagents/provider-served.ts";
import { testAll, testProvider } from "../../src/octocode/subagents/provider-test.ts";
import { ProviderHealth } from "../../src/octocode/subagents/provider-health.ts";

const answers = vi.hoisted(() => ({ error: undefined as string | undefined, calls: 0 }));
vi.mock("../../src/octocode/subagents/provider-health.ts", async (original) => ({
	...(await original<Record<string, unknown>>()),
	checkProviders: vi.fn(
		async (_registry: unknown, entries: readonly { provider: string }[][], health: ProviderHealth) => {
			answers.calls++;
			health.noteCheck(entries[0][0].provider, answers.error);
		},
	),
}));
vi.mock("../../src/core/model-registry.ts", () => ({
	ModelRegistry: class {
		private readonly runtime: { models: { provider: string; id: string }[] };
		constructor(runtime: { models: { provider: string; id: string }[] }) {
			this.runtime = runtime;
		}
		getAvailable() {
			return this.runtime.models;
		}
		streamSimple() {}
	},
}));
vi.mock("../../src/octocode/external/runner-status.ts", () => ({
	checkRunners: vi.fn(async () => []),
	isConnected: () => false,
}));

const SECRET = "sk-live-abcdefghijklmnopqrstuvwxyz0123456789";
function runtime(models: string[], provider = "mantle") {
	const configured = models.map((id) => ({ provider, id, api: "openai-completions" }));
	return {
		models: configured,
		getProviders: () => [{ id: provider, name: "Mantle" }],
		getProvider: () => ({
			id: provider,
			name: "Mantle",
			baseUrl: "https://mantle.test/v1",
			getModels: () => configured,
		}),
		getModels: () => configured,
		getAuth: vi.fn(async () => ({ auth: { apiKey: SECRET }, source: "stored" })),
		hasConfiguredAuth: () => true,
		isProviderDisabled: () => false,
	} as never;
}
const listing = (ids: string[], status = 200) =>
	vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
		status === 200
			? new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), { status })
			: new Response("not found", { status, statusText: "Not Found" }),
	) as unknown as typeof fetch & ReturnType<typeof vi.fn>;

let home: string;
beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "octocode-provider-test-"));
	vi.stubEnv("OCTOCODE_HOME", home);
	answers.error = undefined;
	answers.calls = 0;
});
afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(home, { recursive: true, force: true });
});

describe("served model report", () => {
	it("flags a configured id the host does not serve and suggests the nearest served ids", async () => {
		const fetchList = listing(["qwen.qwen3-235b", "zai.glm-4.7", "zai.glm-4.6"]);
		const report = await servedModelReport(runtime(["moonshotai.kimi-k3.1", "zai.glm-4.7"]), "mantle", {
			fetch: fetchList,
		});
		expect(report).toMatchObject({ kind: "listed", served: 3 });
		if (report?.kind !== "listed") throw new Error("not listed");
		expect(report.unserved.map((entry) => entry.id)).toEqual(["moonshotai.kimi-k3.1"]);
		expect(describeUnserved(report)).toContain("moonshotai.kimi-k3.1");
		expect(String(fetchList.mock.calls[0]?.[0])).toBe("https://mantle.test/v1/models");
	});

	it("reports a failed list by status and never shows the key", async () => {
		const report = await servedModelReport(runtime(["a"]), "mantle", { fetch: listing([], 404) });
		expect(report).toMatchObject({ kind: "failed" });
		expect(JSON.stringify(report)).not.toContain(SECRET);
	});

	it("has nothing to list for a provider with no list route", async () => {
		const none = {
			...(runtime(["a"]) as object),
			getModels: () => [{ provider: "x", id: "a", api: "bedrock-converse-stream" }],
		} as never;
		expect(await servedModelReport(none, "x", { fetch: listing([]) })).toBeUndefined();
	});
});

describe("testProvider and testAll", () => {
	it("tests on press: one request, the unserved ids named, no key in the result", async () => {
		const fetchList = listing(["zai.glm-4.7"]);
		const result = await testProvider(
			{ runtime: runtime(["moonshotai.kimi-k3.1"]), fetch: fetchList, health: new ProviderHealth() },
			"mantle",
			"Mantle",
		);
		expect(answers.calls).toBe(1);
		expect(result).toMatchObject({ id: "mantle", status: "ok", served: 1 });
		expect(result.message).toContain("moonshotai.kimi-k3.1");
		expect(result.message).toContain("zai.glm-4.7");
		expect(JSON.stringify(result)).not.toContain(SECRET);
	});

	it("shows the provider's error text with the key redacted", async () => {
		answers.error = `401 invalid api key ${SECRET}`;
		const result = await testProvider(
			{ runtime: runtime(["a"]), fetch: listing(["a"]), health: new ProviderHealth() },
			"mantle",
			"Mantle",
		);
		expect(result.status).toBe("failed");
		expect(result.message).toContain("401");
		expect(result.message).not.toContain(SECRET);
	});

	it("skips a provider whose models are all hidden", async () => {
		const result = await testProvider({ runtime: runtime([]), health: new ProviderHealth() }, "mantle", "Mantle");
		expect(result).toMatchObject({ status: "skipped", via: "none" });
		expect(answers.calls).toBe(0);
	});

	it("Test all gives one result per connected provider", async () => {
		const seen: string[] = [];
		const results = await testAll(
			{ runtime: runtime(["a"]), fetch: listing(["a"]), health: new ProviderHealth() },
			{ onResult: (result) => seen.push(result.id) },
		);
		expect(results.map((result) => result.id)).toEqual(["mantle"]);
		expect(seen).toEqual(["mantle"]);
	});
});
