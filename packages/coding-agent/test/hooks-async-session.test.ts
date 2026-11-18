import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@octocodeai/octocode-ai";
import { expect, it, vi } from "vitest";
import { Type } from "typebox";
import * as runner from "../src/octocode/hooks/runner.ts";
import { registerHooks } from "../src/octocode/hooks/register.ts";
import { createHarness } from "./suite/harness.ts";
import { HOOK_SETTINGS } from "./octocode/helpers.ts";
import { approveFixtureHooks } from "./octocode/guard-helpers.ts";
import "../src/octocode/mcp-host/core-install.ts";
import { testFeatures } from "./helpers/features.ts";

it("adds completed async context to the next model request without creating an extra turn", async () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "async-hook-session-"));
	fs.mkdirSync(path.join(home, ".claude"));
	fs.writeFileSync(
		path.join(home, ".claude/settings.json"),
		JSON.stringify({
			hooks: {
				UserPromptSubmit: [{ hooks: [{ type: "command", command: "fixture", async: true }] }],
			},
		}),
	);
	let complete!: (result: Awaited<ReturnType<typeof runner.runHook>>) => void;
	const run = vi.spyOn(runner, "runHook").mockImplementation(
		() =>
			new Promise((resolve) => {
				complete = resolve;
			}),
	);
	const harness = await createHarness({
		settings: { retry: { enabled: false }, ...HOOK_SETTINGS },
		tools: [
			{
				name: "finish_background",
				label: "Finish background",
				description: "Fixture completion barrier",
				parameters: Type.Object({}),
				execute: async () => {
					complete({
						code: 0,
						stdout: JSON.stringify({
							systemMessage: "async session evidence",
							continue: false,
						}),
						stderr: "",
						timedOut: false,
					});
					return { content: [{ type: "text", text: "done" }], details: {} };
				},
			},
		],
		features: testFeatures([
			(api) => {
				registerHooks(api, { env: {}, home });
			},
		]),
	});
	try {
		approveFixtureHooks(harness.tempDir, home);
		await harness.session.bindFeatures({});
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("finish_background", {})], {
				stopReason: "toolUse",
			}),
			(context) => {
				expect(JSON.stringify(context.messages).match(/async session evidence/g)).toHaveLength(1);
				return fauxAssistantMessage("finished");
			},
		]);
		await harness.session.prompt("Start the background fixture.");
		expect(run).toHaveBeenCalledTimes(1);
		expect(harness.faux.state.callCount).toBe(2);
	} finally {
		harness.cleanup();
		run.mockRestore();
		fs.rmSync(home, { recursive: true, force: true });
	}
});

it("resumes an idle real session once when an asyncRewake hook exits with code 2", async () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "rewake-hook-session-"));
	fs.mkdirSync(path.join(home, ".claude"));
	fs.writeFileSync(
		path.join(home, ".claude/settings.json"),
		JSON.stringify({
			hooks: {
				UserPromptSubmit: [
					{
						hooks: [{ type: "command", command: "fixture", asyncRewake: true }],
					},
				],
			},
		}),
	);
	let complete!: (result: Awaited<ReturnType<typeof runner.runHook>>) => void;
	const run = vi.spyOn(runner, "runHook").mockImplementation(
		() =>
			new Promise((resolve) => {
				complete = resolve;
			}),
	);
	const harness = await createHarness({
		settings: { retry: { enabled: false }, ...HOOK_SETTINGS },
		tools: [],
		features: testFeatures([
			(api) => {
				registerHooks(api, { env: {}, home });
			},
		]),
	});
	try {
		approveFixtureHooks(harness.tempDir, home);
		await harness.session.bindFeatures({});
		harness.setResponses([
			fauxAssistantMessage("initial work finished"),
			(context) => {
				expect(JSON.stringify(context.messages)).toContain("background verification failed");
				expect(JSON.stringify(context.messages)).not.toContain("ignored stdout");
				return fauxAssistantMessage("responded to background failure");
			},
		]);
		await harness.session.prompt("Start background verification.");
		expect(harness.faux.state.callCount).toBe(1);
		complete({
			code: 2,
			stdout: "ignored stdout",
			stderr: "background verification failed",
			timedOut: false,
		});
		await vi.waitFor(() =>
			expect(JSON.stringify(harness.session.messages)).toContain("responded to background failure"),
		);
		expect(harness.faux.state.callCount).toBe(2);
		expect(run).toHaveBeenCalledTimes(1);
	} finally {
		harness.cleanup();
		run.mockRestore();
		fs.rmSync(home, { recursive: true, force: true });
	}
});
