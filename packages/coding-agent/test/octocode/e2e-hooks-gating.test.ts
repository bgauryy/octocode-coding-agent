import { approveFixtureHooks } from "./guard-helpers.ts";
import { openSandboxDb } from "./e2e-helpers/seed-trust.ts";
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
	const db = openSandboxDb(box);
	try {
		// Approve the exact fixture even when its harness is off: the test must isolate harness gating.
		approveFixtureHooks(box.project, box.home, {
			toggles: { "harness:claude": true, "harness:codex": true },
			guard: { db },
		});
	} finally {
		db.close();
	}
	const process = box.start(["-p", script(steps)]);
	const { code } = await process.exited;
	const output = `${process.stdout()}\n${process.stderr()}`;
	expect(code, output).toBe(0);
	return output;
}

const allText = () =>
	endpoint.requests.flatMap((request) => request.messages.map((message) => message.text)).join("\n---\n");

const HARNESSES = [
	{ name: "claude", dir: ".claude", file: "settings.json" },
	{ name: "codex", dir: ".codex", file: "hooks.json" },
] as const;

/** Configures one PreToolUse hook per format, each recording its input in its own marker; returns the markers. */
function configureAll(box: Sandbox): Record<"claude" | "codex" | "octocode", string> {
	const markers = {
		claude: path.join(box.root, "claude-marker.json"),
		codex: path.join(box.root, "codex-marker.json"),
		octocode: path.join(box.root, "octocode-marker.json"),
	};
	for (const { name, dir, file } of HARNESSES)
		writeProject(box, dir, file, { hooks: { PreToolUse: hook(`cat > ${quote(markers[name])}`) } });
	writeProject(box, ".octocode", "hooks.json", { hooks: { PreToolUse: hook(`cat > ${quote(markers.octocode)}`) } });
	return markers;
}

describe("PreToolUse hook gating by harness", () => {
	it("runs only the Octocode-format hook with the defaults: the claude and codex harnesses are off", async () => {
		const box = sandbox(endpoint);
		const markers = configureAll(box);
		await run(box, bashThenDone);
		expect(fired(markers.claude), "claude hook ran although its harness is off").toBeUndefined();
		expect(fired(markers.codex), "codex hook ran although its harness is off").toBeUndefined();
		expect(fired(markers.octocode)?.hook_event_name, "native hook did not run").toBe("PreToolUse");
	});

	for (const { name } of HARNESSES) {
		it(`runs the project hook of harness:${name} once it is on, and not the other harness's`, async () => {
			const box = sandbox(endpoint);
			enableHarnesses(box, name);
			const markers = configureAll(box);
			await run(box, bashThenDone);
			const input = fired(markers[name]);
			expect(input?.hook_event_name, `${name} hook did not run with its harness on`).toBe("PreToolUse");
			expect(input.session_id).toBeTruthy();
			const other = name === "claude" ? "codex" : "claude";
			expect(fired(markers[other]), `${other} hook ran although only ${name} is on`).toBeUndefined();
		});
	}
});

describe("Stop and PostToolUse hook feedback", () => {
	it("continues the session with Stop hook feedback, in both output formats, and sends it to the model", async () => {
		const box = sandbox(endpoint);
		enableHarnesses(box, "claude");
		const count = path.join(box.root, "stop-count");
		const feedback = "STOPFEEDBACK-please-add-tests";
		const context = "STOPCONTEXT-check-the-docs";
		const block = JSON.stringify({ decision: "block", reason: feedback });
		const additional = JSON.stringify({ hookSpecificOutput: { hookEventName: "Stop", additionalContext: context } });
		// First Stop blocks, the second adds context, the third lets the run end.
		const stop = `n=$(cat ${quote(count)} 2>/dev/null || echo 0); echo $((n+1)) > ${quote(count)}; case $n in 0) printf %s ${quote(block)};; 1) printf %s ${quote(additional)};; esac`;
		const note = "POSTTOOL-annotation-xyz";
		const post = JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: note } });
		writeProject(box, ".claude", "settings.json", {
			hooks: { Stop: hook(stop), PostToolUse: hook(`printf %s ${quote(post)}`) },
		});
		await run(box, [
			{ tool: "bash", args: { command: "echo hooked" } },
			{ text: "first answer" },
			{ text: "second answer after feedback" },
			{ text: "third answer" },
		]);
		const texts = endpoint.requests.map((request) => request.messages.map((message) => message.text).join("\n"));
		expect(texts.length, "the Stop hooks did not trigger further model requests").toBeGreaterThanOrEqual(4);
		// PostToolUse context reaches the request after the tool, not the one before it.
		expect(texts[0]).not.toContain(note);
		expect(texts[1], "PostToolUse context missing").toContain(note);
		// Stop feedback reaches the next request only.
		expect(texts[1]).not.toContain(feedback);
		expect(texts[2], "Stop feedback missing from the next request").toContain(feedback);
		expect(texts[2]).not.toContain(context);
		expect(texts[3], "Stop additionalContext missing from the next request").toContain(context);
		expect(allText()).toContain(note);
	});
});
