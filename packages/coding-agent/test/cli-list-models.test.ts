import { afterEach, describe, expect, it, vi } from "vitest";
import { listModels } from "../src/cli/list-models.ts";
import type { ModelRuntime } from "../src/core/model-runtime.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const model = (provider: string, id: string) => ({
	provider,
	id,
	name: id,
	api: "openai-completions",
	baseUrl: "http://127.0.0.1:1/v1",
	reasoning: false,
	input: ["text"],
	contextWindow: 128_000,
	maxTokens: 4096,
	cost: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 },
});

/** A runtime with `faux` connected and `anthropic` known but without credentials. */
const runtime = {
	getError: () => undefined,
	getAvailable: async () => [model("faux", "faux-1")],
	getProviders: () => [{ id: "faux" }, { id: "anthropic" }],
	getDefinedProviderIds: () => ["faux"],
	getProviderDefinitionFile: (id: string) => (id === "faux" ? "/home/u/.octocode/models.json" : undefined),
	getModelsDiagnostics: () => ({
		describeFile: () => ({ scope: "global", product: "Octocode" }),
		untrustedHint: () => undefined,
	}),
} as unknown as ModelRuntime;

const output = () => {
	const log = vi.spyOn(console, "log").mockImplementation(() => {});
	const error = vi.spyOn(console, "error").mockImplementation(() => {});
	const text = (spy: typeof log) => stripAnsi(spy.mock.calls.map((call) => String(call[0])).join("\n"));
	return { stdout: () => text(log), stderr: () => text(error) };
};

afterEach(() => vi.restoreAllMocks());

describe("--list-models", () => {
	it("names an unknown provider and the connected ones, on stderr with status 1", async () => {
		const out = output();
		expect(await listModels(runtime, undefined, undefined, { provider: "nope" })).toBe(1);
		expect(out.stderr()).toBe('Unknown provider "nope". Connected: faux. octocode --list-models lists their models.');
	});

	it("says a known provider has no usable credentials and how to add them", async () => {
		const out = output();
		expect(await listModels(runtime, undefined, undefined, { provider: "anthropic" })).toBe(1);
		expect(out.stderr()).toContain("No usable credentials for anthropic.");
		expect(out.stderr()).toContain("octocode auth check --provider anthropic");
	});

	it("names the filters that matched nothing and the wider listing", async () => {
		const out = output();
		expect(await listModels(runtime, "zzz", undefined, { provider: "faux", size: "large" })).toBe(0);
		expect(out.stdout()).toBe(
			'No models match provider faux, size large, search "zzz". octocode --list-models --provider faux lists every one you can use.',
		);
	});

	it("shows where each provider is defined", async () => {
		const out = output();
		expect(await listModels(runtime)).toBe(0);
		const lines = out.stdout().split("\n");
		expect(lines[0]).toMatch(/images {2}source$/);
		expect(lines[1]).toMatch(/\(global, Octocode\)$/);
	});

	it("explains an access cell it could not check", async () => {
		const out = output();
		expect(await listModels(runtime, undefined, undefined, { checkAccess: true })).toBe(0);
		const lines = out.stdout().split("\n");
		expect(lines[1]).toMatch(/faux-1 .* not Bedrock$/s);
		expect(lines.at(-1)).toBe("not Bedrock: only Amazon Bedrock access can be checked without a request.");
	});
});
