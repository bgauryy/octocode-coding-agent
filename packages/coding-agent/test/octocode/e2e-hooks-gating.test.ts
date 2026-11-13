import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { enableHarnesses } from "./e2e-helpers/harness-toggles.ts";
import {
	type Endpoint,
	killEverything,
	outputOfRuns,
	type Sandbox,
	sandbox,
	script,
	type Step,
	startEndpoint,
} from "./e2e-real-process-harness.ts";

/**
 * Command hooks through real processes on a scripted model: gating of project `.claude` and `.codex` hooks by
 * `/harness` toggles, an Octocode-format hook that always runs, Stop feedback and PostToolUse context reaching the model.
 */
let endpoint: Endpoint;

vi.setConfig({ testTimeout: 180_000 });

beforeAll(async () => {
	endpoint = await startEndpoint();
});
afterAll(async () => {
	await endpoint?.close();
});
afterEach(async (context) => {
	if (context.task.result?.state === "fail") console.error(outputOfRuns());
	await killEverything();
	endpoint.requests.length = 0;
});

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const fired = (file: string) => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : undefined);
const hook = (command: string) => [{ hooks: [{ type: "command", command, timeout: 30 }] }];

function writeProject(box: Sandbox, dir: string, file: string, content: unknown): void {
	fs.mkdirSync(path.join(box.project, dir), { recursive: true });
	fs.writeFileSync(path.join(box.project, dir, file), JSON.stringify(content));
}

const bashThenDone: Step[] = [{ tool: "bash", args: { command: "echo hooked" } }, { text: "all done" }];

async function run(box: Sandbox, steps: Step[]): Promise<string> {
	const process = box.start(["-p", script(steps)]);
	const { code } = await process.exited;
	const output = `${process.stdout()}\n${process.stderr()}`;
	expect(code, output).toBe(0);
	return output;
}

const allText = () =>
	endpoint.requests.flatMap((request) => request.messages.map((message) => message.text)).join("\n---\n");

describe("PreToolUse hook gating by harness", () => {
	for (const [name, dir, file] of [
		["claude", ".claude", "settings.json"],
		["codex", ".codex", "hooks.json"],
	] as const) {
		const configure = (box: Sandbox, marker: string) =>
			writeProject(box, dir, file, { hooks: { PreToolUse: hook(`cat > ${quote(marker)}`) } });

		it(`does not run a project ${dir}/${file} hook with the defaults (${name} harness off)`, async () => {
			const box = sandbox(endpoint);
			const marker = path.join(box.root, "marker.json");
			configure(box, marker);
			await run(box, bashThenDone);
			expect(fired(marker), `${name} hook ran although its harness is off`).toBeUndefined();
		});

		it(`runs a project ${dir}/${file} hook once harness:${name} is on`, async () => {
			const box = sandbox(endpoint);
			const marker = path.join(box.root, "marker.json");
			enableHarnesses(box, name);
			configure(box, marker);
			await run(box, bashThenDone);
			const input = fired(marker);
			expect(input?.hook_event_name, `${name} hook did not run with its harness on`).toBe("PreToolUse");
			expect(input.session_id).toBeTruthy();
		});
	}

	it("runs an Octocode-format .octocode/hooks.json hook with the defaults", async () => {
		const box = sandbox(endpoint);
		const marker = path.join(box.root, "marker.json");
		writeProject(box, ".octocode", "hooks.json", { hooks: { PreToolUse: hook(`cat > ${quote(marker)}`) } });
		await run(box, bashThenDone);
		expect(fired(marker)?.hook_event_name, "native hook did not run").toBe("PreToolUse");
	});
});

describe("Stop and PostToolUse hook feedback", () => {
	it("continues the session with Stop hook feedback and sends it to the model", async () => {
		const box = sandbox(endpoint);
		enableHarnesses(box, "claude");
		const once = path.join(box.root, "stop-once");
		const feedback = "STOPFEEDBACK-please-add-tests";
		const body = JSON.stringify({ decision: "block", reason: feedback });
		writeProject(box, ".claude", "settings.json", {
			hooks: {
				Stop: hook(`if [ -e ${quote(once)} ]; then exit 0; fi; touch ${quote(once)}; printf %s ${quote(body)}`),
			},
		});
		await run(box, [{ text: "first answer" }, { text: "second answer after feedback" }]);
		expect(endpoint.requests.length, "Stop block did not trigger another model request").toBeGreaterThanOrEqual(2);
		const second = endpoint.requests[1].messages.map((message) => message.text).join("\n");
		expect(second, "Stop feedback missing from the next request").toContain(feedback);
		expect(endpoint.requests[0].messages.map((m) => m.text).join("\n")).not.toContain(feedback);
	});

	it("continues on Stop hookSpecificOutput.additionalContext", async () => {
		const box = sandbox(endpoint);
		enableHarnesses(box, "claude");
		const once = path.join(box.root, "stop-once");
		const feedback = "STOPCONTEXT-check-the-docs";
		const body = JSON.stringify({ hookSpecificOutput: { hookEventName: "Stop", additionalContext: feedback } });
		writeProject(box, ".claude", "settings.json", {
			hooks: {
				Stop: hook(`if [ -e ${quote(once)} ]; then exit 0; fi; touch ${quote(once)}; printf %s ${quote(body)}`),
			},
		});
		await run(box, [{ text: "first answer" }, { text: "second answer" }]);
		expect(endpoint.requests.length, "Stop additionalContext did not continue the run").toBeGreaterThanOrEqual(2);
		expect(endpoint.requests[1].messages.map((m) => m.text).join("\n"), "context missing from next request").toContain(
			feedback,
		);
	});

	it("delivers PostToolUse additionalContext in the next model request", async () => {
		const box = sandbox(endpoint);
		enableHarnesses(box, "claude");
		const note = "POSTTOOL-annotation-xyz";
		const body = JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: note } });
		writeProject(box, ".claude", "settings.json", { hooks: { PostToolUse: hook(`printf %s ${quote(body)}`) } });
		await run(box, bashThenDone);
		expect(endpoint.requests.length).toBeGreaterThanOrEqual(2);
		expect(endpoint.requests[0].messages.map((m) => m.text).join("\n")).not.toContain(note);
		expect(endpoint.requests[1].messages.map((m) => m.text).join("\n"), "PostToolUse context missing").toContain(note);
		expect(allText()).toContain(note);
	});
});
