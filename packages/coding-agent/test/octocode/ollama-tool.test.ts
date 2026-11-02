import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ToolCallEvent } from "../../src/core/features/index.ts";
import { freellamaCommand, FREELLAMA_PACKAGE } from "../../src/octocode/ollama/freellama.ts";
import { registerOllamaTool } from "../../src/octocode/ollama/tool.ts";
import { classify } from "../../src/octocode/permission/gate/classify.ts";
import { withNativePermissionOwners } from "../../src/octocode/permission/native-tools.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";

const TASK_RECEIPT = {
	route: { selected_model: "gpt-oss:20b", confidence: "low" },
	response: { model: "gpt-oss:20b", done_reason: "stop", message: { role: "assistant", content: " OK " } },
	metrics: { prompt_tokens: 15, output_tokens: 2, output_tokens_per_second: 41.7 },
};

function setup(receipt: unknown = TASK_RECEIPT) {
	const fake = fakeHost();
	const run = vi.fn(async (_args: string[], _options: { signal?: AbortSignal; timeoutMs: number }) => receipt);
	registerOllamaTool(withNativePermissionOwners(fake.api), run);
	const tool = fake.tools.get("ollama");
	const call = (params: Record<string, unknown>) =>
		tool.execute(
			"t1",
			{ reason: "offload", ...params },
			undefined,
			undefined,
			fakeCtx({ cwd: process.cwd() }),
		) as Promise<{
			content: Array<{ text: string }>;
			details: Record<string, unknown>;
		}>;
	return { tool, run, call };
}

describe("ollama tool", () => {
	it("runs a task through the CLI and returns the reply with its receipt", async () => {
		const { run, call } = setup();
		const result = await call({
			action: "task",
			prompt: "-Reply OK",
			task: "coding",
			model: "gpt-oss:20b",
			timeoutSeconds: 60,
		});
		expect(run.mock.calls[0][0]).toEqual([
			"task",
			"--task",
			"coding",
			"--model",
			"gpt-oss:20b",
			"--timeout-seconds",
			"60",
			"--",
			"-Reply OK",
		]);
		expect(run.mock.calls[0][1].timeoutMs).toBeGreaterThan(60_000);
		expect(result.content[0].text).toBe("[gpt-oss:20b · low confidence route · 15 in / 2 out tokens · 42 tok/s]\nOK");
		expect(result.details).toMatchObject({
			action: "task",
			model: "gpt-oss:20b",
			confidence: "low",
			outputTokens: 2,
			doneReason: "stop",
		});
	});

	it("says when a reply stopped at the output limit", async () => {
		const { call } = setup({ ...TASK_RECEIPT, response: { ...TASK_RECEIPT.response, done_reason: "length" } });
		const result = await call({ action: "task", prompt: "long" });
		expect(result.content[0].text).toContain("Stopped at the output token limit");
	});

	it("refuses a task without a prompt before running the CLI", async () => {
		const { run, call } = setup();
		await expect(call({ action: "task", prompt: "  " })).rejects.toThrow("needs a prompt");
		expect(run).not.toHaveBeenCalled();
	});

	it("summarizes installed models and a route preview", async () => {
		const models = setup({
			models: [
				{
					name: "glm-ocr:latest",
					capabilities: ["completion", "vision"],
					size: 2.2e9,
					advertised_context: 131072,
					resident: true,
				},
			],
		});
		const listed = await models.call({ action: "models" });
		expect(models.run.mock.calls[0][0]).toEqual(["models"]);
		expect(listed.content[0].text).toBe(
			"glm-ocr:latest · capabilities: completion, vision · 2.2 GB · context 131072 · loaded",
		);

		const route = setup({ selected_model: "gpt-oss:20b", confidence: "low", reasons: ["installed", "resident"] });
		const preview = await route.call({ action: "route", objective: "fastest" });
		expect(route.run.mock.calls[0][0]).toEqual(["route", "--task", "completion", "--objective", "fastest"]);
		expect(preview.content[0].text).toBe("Model: gpt-oss:20b\nConfidence: low\nReasons: installed, resident");
	});

	it("asks before a task and lets listing and routing run", () => {
		const event = (action: string): ToolCallEvent => ({
			type: "tool_call",
			toolCallId: "ollama-check",
			toolName: "ollama",
			input: { action, prompt: "hi" },
		});
		expect(classify(event("task"), { cwd: "/repo" })).toMatchObject({ action: "shell", grant: { key: "ollama task" } });
		expect(classify(event("models"), { cwd: "/repo" })).toBeUndefined();
		expect(classify(event("route"), { cwd: "/repo" })).toBeUndefined();
	});

	it("runs the package launcher with this Node and falls back to PATH", () => {
		const resolved = freellamaCommand(() => "/deps/@octocodeai/freellama/package.json");
		expect(resolved).toEqual({
			file: process.execPath,
			args: [path.join("/deps/@octocodeai/freellama", "bin", "freellama.js")],
		});
		const missing = freellamaCommand(() => {
			throw new Error(`Cannot find ${FREELLAMA_PACKAGE}`);
		});
		expect(missing).toEqual({ file: "freellama", args: [] });
	});
});
