import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@octocodeai/octocode-ai";
import type { AgentTool } from "@octocodeai/octocode-agent-core";
import { Type } from "typebox";
import { Compile } from "typebox/compile";
import { expect, it } from "vitest";
import { renderConfigSchemas } from "../../scripts/generate-schemas.ts";
import type { FeatureContext } from "../../src/core/features/index.ts";
import { registerHooks } from "../../src/octocode/hooks/register.ts";
import type { HooksView } from "../../src/octocode/hooks/register/types.ts";
import { createHarness } from "../suite/harness.ts";
import { HOOK_SETTINGS } from "./helpers.ts";
import "../../src/octocode/mcp-host/core-install.ts";
import { testFeatures } from "../helpers/features.ts";

it("sends Claude PostToolUse the structured result, keeps its text, and test-runs a hook on a sample event", async () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "post-tool-response-"));
	const capture = path.join(home, "events.jsonl");
	const script = path.join(home, "hook.cjs");
	fs.writeFileSync(
		script,
		`let s='';process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>{require('fs').appendFileSync(${JSON.stringify(capture)},s+'\\n');});`,
	);
	const settings = {
		hooks: {
			PostToolUse: [{ matcher: "observe", hooks: [{ type: "command", command: process.execPath, args: [script] }] }],
		},
	};
	fs.mkdirSync(path.join(home, ".claude"));
	fs.writeFileSync(path.join(home, ".claude/settings.json"), JSON.stringify(settings));
	const check = Compile(JSON.parse(renderConfigSchemas().get("schemas/hooks.schema.json") ?? ""));
	expect(check.Check(settings)).toBe(true);
	expect(check.Check({ hooks: { NoSuchEvent: [] } })).toBe(false);
	expect(check.Check({ hooks: { Stop: [{ hooks: [{ type: "command" }] }] } })).toBe(false);

	const schema = Type.Object({ value: Type.String() });
	const tool: AgentTool<typeof schema> = {
		name: "observe",
		label: "Observe",
		description: "fixture",
		parameters: schema,
		execute: async (_id, args) => ({ content: [{ type: "text", text: args.value }], details: {} }),
	};
	let view: HooksView | undefined;
	let context: FeatureContext | undefined;
	const harness = await createHarness({
		settings: { retry: { enabled: false }, ...HOOK_SETTINGS },
		tools: [tool],
		features: testFeatures([
			(api) => {
				view = registerHooks(api, { env: {}, home });
				api.bus.on("session_start", async (_event, ctx) => {
					context = ctx;
				});
			},
		]),
	});
	try {
		await harness.session.bindFeatures({});
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("observe", { value: "hello" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("Run it.");
		const payload = JSON.parse(fs.readFileSync(capture, "utf8").trim().split("\n")[0]);
		expect(payload.hook_event_name).toBe("PostToolUse");
		expect(payload.tool_response).toEqual({ content: [{ type: "text", text: "hello" }], text: "hello" });

		fs.rmSync(capture);
		const report = await view!.testRun(context!, ["PostToolUse", "observe", '{"value":"x"}']);
		expect(report).toContain("PostToolUse on observe: 1 hook ran");
		expect(JSON.parse(fs.readFileSync(capture, "utf8").trim()).tool_input).toEqual({ value: "x" });
		expect(await view!.testRun(context!, ["PostToolUse", "other"])).toContain("No PostToolUse hook matches");
		expect(await view!.testRun(context!, ["Nope"])).toContain("Unknown hook event Nope");
	} finally {
		harness.cleanup();
		fs.rmSync(home, { recursive: true, force: true });
	}
});
