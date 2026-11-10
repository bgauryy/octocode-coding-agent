import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
	type Endpoint,
	killEverything,
	outputOfRuns,
	sandbox,
	script,
	type Step,
	startEndpoint,
} from "./e2e-real-process-harness.ts";
import { enableHarnesses } from "./e2e-helpers/harness-toggles.ts";

/**
 * SubagentStart/SubagentStop hooks from `~/.claude/settings.json` through real processes: a real parent starts a real
 * child through `agent`, with the Claude harness switched on in the global settings file.
 */
let endpoint: Endpoint;

vi.setConfig({ testTimeout: 180_000 });

beforeAll(async () => {
	endpoint = await startEndpoint();
});
afterAll(async () => {
	await endpoint.close();
});
afterEach(async (context) => {
	if (context.task.result?.state === "fail") console.error(outputOfRuns());
	await killEverything();
	endpoint.requests.length = 0;
});

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

const fired = (file: string) => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : undefined);

/** A parent whose Claude hook file has SubagentStart/Stop hooks writes markers; its child is `profile` (the bundled task child by default). */
async function runChild(profile?: string) {
	const box = sandbox(endpoint);
	const starts = path.join(box.root, "start.json");
	const stops = path.join(box.root, "stop.json");
	enableHarnesses(box, "claude", "codex");
	const hook = (marker: string) => [{ hooks: [{ type: "command", command: `cat > ${quote(marker)}`, timeout: 30 }] }];
	fs.mkdirSync(path.join(box.home, ".claude"), { recursive: true });
	fs.writeFileSync(
		path.join(box.home, ".claude", "settings.json"),
		JSON.stringify({ hooks: { SubagentStart: hook(starts), SubagentStop: hook(stops) } }),
	);
	fs.mkdirSync(path.join(box.project, ".octocode", "agents"), { recursive: true });
	fs.writeFileSync(
		path.join(box.project, ".octocode", "agents", "hooked.md"),
		"---\ndescription: A worker that runs the user's hooks.\nhooks: true\n---\nDo the task.\n",
	);
	const child: Step[] = [{ text: "done: the child's work" }];
	const parent: Step[] = [
		{
			tool: "agent",
			args: {
				type: "task",
				...(profile ? { profile } : {}),
				background: false,
				goal: "do the work",
				task: script(child),
			},
		},
		{ text: "read its report" },
	];
	const run = box.start(["-p", script(parent)]);
	expect((await run.exited).code).toBe(0);
	return { start: fired(starts), stop: fired(stops), output: `${run.stdout()}\n${run.stderr()}` };
}

describe("subagent hooks in a real child process", () => {
	it("runs the Claude SubagentStart and SubagentStop hooks of ~/.claude/settings.json for a child whose profile sets hooks: true", async () => {
		const { start, stop } = await runChild("hooked");
		expect(start?.hook_event_name).toBe("SubagentStart");
		expect(stop?.hook_event_name).toBe("SubagentStop");
		expect(start?.session_id).toBeTruthy();
		expect(stop?.agent_transcript_path).toBeTruthy();
	});

	it("does not run them for a child whose profile leaves hooks off, and the parent's startup output stays quiet about it", async () => {
		const { start, stop, output } = await runChild();
		expect(start).toBeUndefined();
		expect(stop).toBeUndefined();
		expect(output).not.toMatch(/hooks run only in subagents whose profile sets hooks: true/);
	});
});
