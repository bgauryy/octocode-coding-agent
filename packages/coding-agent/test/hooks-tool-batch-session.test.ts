import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@octocodeai/octocode-ai";
import type { AgentTool } from "@octocodeai/octocode-agent-core";
import { Type } from "typebox";
import { expect, it } from "vitest";
import { registerHooks } from "../src/octocode/hooks/register.ts";
import { createHarness } from "./suite/harness.ts";
import { HOOK_SETTINGS } from "./octocode/helpers.ts";
import { approveFixtureHooks } from "./octocode/guard-helpers.ts";
import "../src/octocode/mcp-host/core-install.ts";

it.each([false, true])("observes one full tool batch and applies block=%s before another model call", async (block) => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "tool-batch-session-"));
	const capture = path.join(home, "events.jsonl");
	const script = path.join(home, "hook.cjs");
	const output = block
		? { decision: "block", reason: "Review the batch" }
		: { hookSpecificOutput: { hookEventName: "PostToolBatch", additionalContext: "Batch complete" } };
	fs.writeFileSync(
		script,
		`let s='';process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>{require('fs').appendFileSync(${JSON.stringify(capture)},s+'\\n');console.log(${JSON.stringify(JSON.stringify(output))});});`,
	);
	fs.mkdirSync(path.join(home, ".claude"));
	fs.writeFileSync(
		path.join(home, ".claude/settings.json"),
		JSON.stringify({
			hooks: {
				PostToolBatch: [{ matcher: "(", hooks: [{ type: "command", command: process.execPath, args: [script] }] }],
			},
		}),
	);
	const schema = Type.Object({ value: Type.String() });
	const tool: AgentTool<typeof schema> = {
		name: "observe",
		label: "Observe",
		description: "fixture",
		parameters: schema,
		execute: async (_id, args) => {
			if (args.value === "fail") throw new Error("fixture error");
			return { content: [{ type: "text", text: args.value }], details: {} };
		},
	};
	const harness = await createHarness({
		settings: { retry: { enabled: false }, ...HOOK_SETTINGS },
		tools: [tool],
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
			fauxAssistantMessage([fauxToolCall("observe", { value: "first" }), fauxToolCall("observe", { value: "fail" })], {
				stopReason: "toolUse",
			}),
			(context) => {
				expect(JSON.stringify(context.messages)).toContain("Batch complete");
				return fauxAssistantMessage("done");
			},
		]);
		await harness.session.prompt("Run the batch.");
		const lines = fs.readFileSync(capture, "utf8").trim().split("\n");
		expect(lines).toHaveLength(1);
		const payload = JSON.parse(lines[0]);
		expect(payload.hook_event_name).toBe("PostToolBatch");
		expect(payload.tool_calls).toHaveLength(2);
		expect(payload.tool_calls[0]).toMatchObject({
			tool_name: "observe",
			tool_input: { value: "first" },
			tool_response: [{ type: "text", text: "first" }],
		});
		expect(JSON.stringify(payload.tool_calls[1].tool_response)).toContain("fixture error");
		expect(harness.faux.state.callCount).toBe(block ? 1 : 2);
		if (block) expect(JSON.stringify(harness.session.messages)).toContain("Review the batch");
	} finally {
		harness.cleanup();
		fs.rmSync(home, { recursive: true, force: true });
	}
});
