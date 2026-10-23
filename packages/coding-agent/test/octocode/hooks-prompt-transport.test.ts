import { expect, it, vi } from "vitest";
import { commandsFor, parseHooks } from "../../src/octocode/hooks/config.ts";
import {
	runPromptHook,
	interpretPromptHook,
	createPromptEvaluator,
	type PromptEvaluator,
} from "../../src/octocode/hooks/prompt.ts";

const handler = {
	type: "prompt" as const,
	protocol: "claude" as const,
	prompt: "Check $ARGUMENTS",
	source: "fixture",
	timeoutMs: 1000,
};
it("accepts supported Claude prompt events with a 30-second default and rejects other profiles/events", () => {
	for (const event of [
		"PreToolUse",
		"PostToolUse",
		"PostToolUseFailure",
		"PostToolBatch",
		"Stop",
		"UserPromptSubmit",
	]) {
		const errors: string[] = [];
		const config = parseHooks(
			{
				hooks: {
					[event]: [
						{
							hooks: [{ type: "prompt", prompt: "check", continueOnBlock: true }],
						},
					],
				},
			},
			"fixture",
			undefined,
			errors,
			undefined,
			"claude",
		);
		expect(errors).toEqual([]);
		expect(config[event as keyof typeof config][0]?.hooks[0]).toMatchObject({
			type: "prompt",
			timeoutMs: 30000,
			continueOnBlock: true,
		});
	}
	for (const protocol of ["codex", "octocode"] as const) {
		const errors: string[] = [];
		expect(
			commandsFor(
				parseHooks(
					{
						hooks: {
							PreToolUse: [{ hooks: [{ type: "prompt", prompt: "check" }] }],
						},
					},
					"fixture",
					undefined,
					errors,
					undefined,
					protocol,
				),
				"PreToolUse",
				["Bash"],
			),
		).toEqual([]);
		expect(errors.length).toBeGreaterThan(0);
	}
	const errors: string[] = [];
	parseHooks(
		{
			hooks: {
				SessionStart: [{ hooks: [{ type: "prompt", prompt: "check" }] }],
			},
		},
		"fixture",
		undefined,
		errors,
		undefined,
		"claude",
	);
	expect(errors.join()).toContain("SessionStart");
});
it("substitutes input once, appends unused input, and preserves escaped placeholders", async () => {
	const evaluate = vi.fn(async (_request: Parameters<PromptEvaluator>[0]) => '{"ok":true}');
	await runPromptHook(handler, { text: "$ARGUMENTS" }, undefined, evaluate);
	expect(evaluate.mock.calls[0]?.[0]).toMatchObject({
		prompt: 'Check {"text":"$ARGUMENTS"}',
	});
	await runPromptHook({ ...handler, prompt: "Literal \\$ARGUMENTS" }, { value: 1 }, undefined, evaluate);
	expect(evaluate.mock.calls[1]?.[0]).toMatchObject({
		prompt: 'Literal $ARGUMENTS\n\n{"value":1}',
	});
});
it("cancels evaluations and enforces deadlines even if the provider ignores cancellation", async () => {
	const evaluate = vi.fn((_request: Parameters<PromptEvaluator>[0]) => new Promise<string>(() => {}));
	const abort = new AbortController();
	abort.abort();
	expect((await runPromptHook(handler, {}, abort.signal, evaluate)).code).toBeNull();
	expect(evaluate).not.toHaveBeenCalled();
	const result = await runPromptHook({ ...handler, timeoutMs: 10 }, {}, undefined, evaluate);
	expect(result.timedOut).toBe(true);
	expect(evaluate.mock.calls[0]?.[0].signal.aborted).toBe(true);
});
it("applies the event-specific block and continuation contracts", () => {
	const result = (value: unknown) => ({
		code: 0,
		stdout: JSON.stringify(value),
		stderr: "",
		timedOut: false,
	});
	const blocked = result({ ok: false, reason: "needs work" });
	expect(interpretPromptHook("PreToolUse", blocked, false)).toEqual({
		block: "needs work",
		haltTurn: true,
	});
	expect(interpretPromptHook("PreToolUse", blocked, true)).toEqual({
		block: "needs work",
	});
	expect(interpretPromptHook("PostToolUse", blocked, false)).toEqual({
		context: "needs work",
		haltTurn: true,
	});
	expect(interpretPromptHook("PostToolUseFailure", blocked, false)).toEqual({
		context: "needs work",
	});
	expect(interpretPromptHook("Stop", blocked, false)).toEqual({
		block: "needs work",
	});
	expect(interpretPromptHook("Stop", result({ ok: false, reason: "impossible", impossible: true }), true)).toEqual({});
	expect(interpretPromptHook("PostToolBatch", blocked, true)).toEqual({
		block: "needs work",
	});
	expect(interpretPromptHook("UserPromptSubmit", blocked, true)).toEqual({
		block: "needs work",
	});
	expect(interpretPromptHook("Stop", result({ ok: false }), true)).toHaveProperty("error");
});
it("routes evaluation through the configured model owner without tools or recursive agent execution", async () => {
	const model = { provider: "test", id: "judge" };
	const stream = vi.fn((_model: unknown, _context: unknown, _options: unknown) => ({
		result: async () => ({
			stopReason: "stop",
			content: [{ type: "text", text: '{"ok":true}' }],
		}),
	}));
	const evaluate = createPromptEvaluator({
		model,
		modelRegistry: { getAll: () => [model], streamSimple: stream },
	} as never);
	const signal = new AbortController().signal;
	expect(await evaluate({ prompt: "check data", signal, model: "test/judge" })).toBe('{"ok":true}');
	expect(stream).toHaveBeenCalledWith(
		model,
		expect.objectContaining({
			messages: [expect.objectContaining({ role: "user", content: "check data" })],
		}),
		expect.objectContaining({ signal }),
	);
	expect(stream.mock.calls[0]?.[1]).not.toHaveProperty("tools");
	await expect(evaluate({ prompt: "check", signal, model: "missing" })).rejects.toThrow("model");
});
