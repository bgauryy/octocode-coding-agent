import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fauxAssistantMessage } from "@octocodeai/octocode-ai";
import { expect, it } from "vitest";
import { registerHooks } from "../src/octocode/hooks/register.ts";
import { createHarness } from "./suite/harness.ts";
import { HOOK_SETTINGS } from "./octocode/helpers.ts";

it("delivers the persisted provider error once at the real session settlement boundary", async () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "stop-failure-session-"));
	const capture = path.join(home, "events.jsonl");
	const script = path.join(home, "hook.cjs");
	fs.writeFileSync(
		script,
		`let s='';process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>{require('fs').appendFileSync(${JSON.stringify(capture)},s+'\\n');console.log('{"decision":"block","reason":"must be ignored"}');});`,
	);
	fs.mkdirSync(path.join(home, ".claude"));
	fs.writeFileSync(
		path.join(home, ".claude/settings.json"),
		JSON.stringify({
			hooks: {
				StopFailure: [{ hooks: [{ type: "command", command: process.execPath, args: [script] }] }],
			},
		}),
	);
	const harness = await createHarness({
		settings: { retry: { enabled: false }, ...HOOK_SETTINGS },
		extensionFactories: [
			(api) => {
				registerHooks(api, { env: {}, home });
			},
		],
	});
	try {
		await harness.session.bindExtensions({});
		harness.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "Provider unavailable" })]);
		await harness.session.prompt("Fail the provider request.");
		const payload = JSON.parse(fs.readFileSync(capture, "utf8").trim());
		expect(payload).toMatchObject({
			hook_event_name: "StopFailure",
			error: "unknown",
			error_details: "Provider unavailable",
		});
		expect(harness.session.messages.some((message) => message.role === "custom")).toBe(false);
		harness.setResponses([fauxAssistantMessage("recovered")]);
		await harness.session.prompt("Try again.");
		expect(fs.readFileSync(capture, "utf8").trim().split("\n")).toHaveLength(1);
	} finally {
		harness.cleanup();
		fs.rmSync(home, { recursive: true, force: true });
	}
});
