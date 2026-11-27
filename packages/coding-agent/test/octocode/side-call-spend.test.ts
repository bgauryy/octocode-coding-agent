import type { AssistantMessage, Usage } from "@octocodeai/octocode-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installSpendCapture, type SpendCapture } from "../../src/core/spend-capture.ts";
import { createPromptEvaluator } from "../../src/octocode/hooks/prompt.ts";
import { checkProviders, ProviderHealth } from "../../src/octocode/subagents/provider-health.ts";

type Spent = Parameters<SpendCapture["spent"]>[0];

const usage = (output: number, cost: number): Usage => ({
	input: 40,
	output,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 40 + output,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
});

const reply = (fields: Partial<AssistantMessage>): AssistantMessage => ({
	role: "assistant",
	content: [{ type: "text", text: '{"ok":true}' }],
	api: "openai-completions",
	provider: "judge-co",
	model: "judge",
	usage: usage(5, 0.01),
	stopReason: "stop",
	timestamp: 0,
	...fields,
});

const model = { provider: "judge-co", id: "judge" };
let spent: Spent[] = [];
let remove: (() => void) | undefined;
afterEach(() => {
	remove?.();
	spent = [];
	vi.useRealTimers();
});
const capture = () => {
	remove = installSpendCapture({ billing: () => undefined, appended: () => undefined, spent: (r) => spent.push(r) });
};

describe("side model calls record their spend for /usage", () => {
	it("a prompt hook's evaluation records each request it sent, retries included", async () => {
		capture();
		vi.useFakeTimers();
		const limited = reply({
			stopReason: "error",
			errorMessage: "429 Too Many Requests",
			usage: usage(0, 0),
			content: [],
		});
		const answered = reply({ usage: usage(7, 0.02) });
		const replies = [limited, answered];
		const evaluate = createPromptEvaluator({
			cwd: "/work/repo",
			model,
			modelRegistry: { getAll: () => [model], streamSimple: () => ({ result: async () => replies.shift()! }) },
		} as never);

		const verdict = evaluate({ prompt: "check", signal: new AbortController().signal });
		await vi.runAllTimersAsync();
		expect(await verdict).toBe('{"ok":true}');

		expect(spent).toEqual([
			{ cwd: "/work/repo", kind: "prompt_hook", provider: "judge-co", model: "judge", usage: limited.usage },
			{ cwd: "/work/repo", kind: "prompt_hook", provider: "judge-co", model: "judge", usage: answered.usage },
		]);
	});

	it("a provider check's tiny request records what it spent, answered or refused", async () => {
		capture();
		const ok = reply({ usage: usage(3, 0.001) });
		const refused = reply({ stopReason: "error", errorMessage: "insufficient_quota", usage: usage(1, 0.0001) });
		const answers = [ok, refused];
		const registry = { streamSimple: () => ({ result: async () => answers.shift()! }) };
		const health = new ProviderHealth();
		const target = (provider: string) => ({ ...model, provider, id: "judge", name: "judge" }) as never;

		await checkProviders(registry as never, [target("a-co"), target("b-co")], health, undefined, "/work/repo");

		expect(spent.map((request) => [request.kind, request.cwd, request.model, request.usage])).toEqual([
			["provider_check", "/work/repo", "judge", ok.usage],
			["provider_check", "/work/repo", "judge", refused.usage],
		]);
		expect(spent.map((request) => request.provider).sort()).toEqual(["a-co", "b-co"]);
	});
});
