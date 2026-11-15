import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@octocodeai/octocode-ai";
import { expect, it, vi } from "vitest";
import { Type } from "typebox";
import { registerHooks } from "../src/octocode/hooks/register.ts";
import { createHarness } from "./suite/harness.ts";
import { HOOK_SETTINGS } from "./octocode/helpers.ts";
import { approveFixtureHooks } from "./octocode/guard-helpers.ts";
import "../src/octocode/mcp-host/core-install.ts";

function fixture(event: string, continueOnBlock = false) {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "prompt-hook-session-"));
	fs.mkdirSync(path.join(home, ".claude"));
	fs.writeFileSync(
		path.join(home, ".claude/settings.json"),
		JSON.stringify({
			hooks: {
				[event]: [
					{
						hooks: [
							{
								type: "prompt",
								prompt: "Check this operation: $ARGUMENTS",
								continueOnBlock,
							},
						],
					},
				],
			},
		}),
	);
	return home;
}
it.each([false, true])(
	"denies before execution and respects continueOnBlock=%s through the real session",
	async (continueOnBlock) => {
		const home = fixture("PreToolUse", continueOnBlock);
		const outcomes: string[] = [];
		const execute = vi.fn(async () => ({
			content: [{ type: "text" as const, text: "must not execute" }],
			details: {},
		}));
		const harness = await createHarness({
			settings: { retry: { enabled: false }, ...HOOK_SETTINGS },
			tools: [
				{
					name: "work",
					label: "work",
					description: "Fixture tool",
					parameters: Type.Object({}),
					execute,
				},
			],
			extensionFactories: [
				(api) => {
					const hooks = registerHooks(api, { env: {}, home });
					api.on("tool_call", (event, ctx) => hooks.preToolUse(event, ctx));
					api.on("turn_end", async (event) => {
						outcomes.push(event.outcome);
					});
				},
			],
		});
		try {
			approveFixtureHooks(harness.tempDir, home);
			await harness.session.bindExtensions({});
			harness.setResponses([
				fauxAssistantMessage([fauxToolCall("work", {})], {
					stopReason: "toolUse",
				}),
				(context) => {
					expect(context).not.toHaveProperty("tools");
					expect(JSON.stringify(context.messages)).toContain("PreToolUse");
					return fauxAssistantMessage('{"ok":false,"reason":"policy says no"}');
				},
				fauxAssistantMessage("accepted denial"),
			]);
			await harness.session.prompt("Try the fixture tool.");
			expect(execute).not.toHaveBeenCalled();
			expect(outcomes[0]).toBe(continueOnBlock ? "completed" : "aborted");
			expect(harness.faux.state.callCount).toBe(continueOnBlock ? 3 : 2);
		} finally {
			harness.cleanup();
			fs.rmSync(home, { recursive: true, force: true });
		}
	},
);
it("continues a rejected Stop evaluation once and finishes after an allowing evaluation", async () => {
	const home = fixture("Stop");
	const harness = await createHarness({
		settings: { retry: { enabled: false }, ...HOOK_SETTINGS },
		tools: [],
		extensionFactories: [
			(api) => {
				registerHooks(api, { env: {}, home });
			},
		],
	});
	try {
		approveFixtureHooks(harness.tempDir, home);
		await harness.session.bindExtensions({});
		harness.setResponses([
			fauxAssistantMessage("initial completion"),
			fauxAssistantMessage('{"ok":false,"reason":"finish the remaining check"}'),
			(context) => {
				expect(JSON.stringify(context.messages)).toContain("finish the remaining check");
				return fauxAssistantMessage("completed check");
			},
			fauxAssistantMessage('{"ok":true}'),
		]);
		await harness.session.prompt("Complete the task.");
		expect(harness.faux.state.callCount).toBe(4);
	} finally {
		harness.cleanup();
		fs.rmSync(home, { recursive: true, force: true });
	}
});
