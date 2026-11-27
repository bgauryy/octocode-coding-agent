import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApplicationStream } from "@octocodeai/octocode-projections";
import {
	ApplicationProjection,
	activityCard,
	type FeedEvent,
	terminalEntries,
} from "@octocodeai/octocode-webview/app/live/model";
import { afterEach, expect, it } from "vitest";
import { getApplicationPort } from "../src/core/application/index.ts";
import { createBashTool } from "../src/core/tools/index.ts";
import { createReadTool } from "./fixtures/read-tool.ts";
import { createWriteTool } from "./fixtures/write-tool.ts";
import { createHarness, type Harness } from "./test-harness.ts";

/**
 * Each built-in tool, end to end: a real session runs the call, the application service streams frames, and the browser
 * stream and projection turn them into what the activity feed and terminal transcript show.
 */
let harness: Harness | undefined;
let workDir: string | undefined;
afterEach(() => {
	harness?.cleanup();
	if (workDir) rmSync(workDir, { recursive: true, force: true });
});

const SECRET = `ghp_${"a1B2c3D4e5".repeat(4)}`;

it("renders every built-in tool call with its argument label, status and output", async () => {
	workDir = mkdtempSync(join(tmpdir(), "webview-tools-"));
	const cwd = workDir;
	harness = await createHarness({
		// The session's own tools are bash only; `read` and `write` are test fixtures that stand in for other hosts' tools.
		baseToolsOverride: { bash: createBashTool(cwd), read: createReadTool(cwd), write: createWriteTool(cwd) },
		responses: [
			{ toolCalls: [{ id: "write", name: "write", args: { path: "notes.txt", content: "alpha\nbeta\n" } }] },
			{ toolCalls: [{ id: "read", name: "read", args: { path: "notes.txt" } }] },
			{ toolCalls: [{ id: "bash-ok", name: "bash", args: { command: "printf 'one\\ntwo\\n'" } }] },
			{ toolCalls: [{ id: "bash-fail", name: "bash", args: { command: "echo broken >&2; exit 3" } }] },
			{ toolCalls: [{ id: "secret", name: "bash", args: { command: `echo ${SECRET} >/dev/null` } }] },
			{ toolCalls: [{ id: "missing", name: "read", args: { path: "missing.txt" } }] },
			"All tools ran.",
		],
	});
	const connection = getApplicationPort(harness.session).connect();
	const frames: unknown[] = [];
	const reading = (async () => {
		for await (const frame of connection) frames.push(frame);
	})();
	await harness.session.prompt("Exercise each tool");
	await new Promise((resolve) => setTimeout(resolve, 20));
	connection.close();
	await reading;

	const stream = new ApplicationStream();
	const projection = new ApplicationProjection();
	let events: FeedEvent[] = [];
	for (const frame of frames) {
		expect(stream.accept(frame)).not.toBe("invalid");
		events = projection.update(stream.snapshot, (frame as { at: number }).at);
	}
	const entries = terminalEntries(events);
	const byCommand = (prefix: string) => entries.filter((entry) => entry.command.startsWith(prefix));

	expect(entries.map((entry) => [entry.command.split(" ")[0], entry.status])).toEqual([
		["write", "done"],
		["read", "done"],
		["bash", "done"],
		["bash", "failed"],
		["bash", "done"],
		["read", "failed"],
	]);
	expect(byCommand("write notes.txt")).toHaveLength(1);
	expect(byCommand("read notes.txt")[0].output).toContain("alpha");
	expect(byCommand("bash printf")[0].output).toMatch(/^\[exit 0 · [^\]]*\]\none\ntwo$/);
	expect(byCommand("bash echo broken")[0].output).toMatch(/^\[exit 3 · .*\]\nbroken$/);
	expect(byCommand("read missing.txt")[0].output.length).toBeGreaterThan(0);

	// Arguments are labelled through the host's redaction: a token in a command never reaches the browser.
	expect(JSON.stringify(frames)).not.toContain(SECRET);
	expect(entries[4].command).toMatch(/^bash echo /);

	const cards = events.filter((event) => event.type.startsWith("tool.")).map(activityCard);
	expect(cards.map((card) => card.title)).toContain("bash printf 'one\\ntwo\\n'");
	expect(cards.filter((card) => card.failed)).toHaveLength(2);
	expect(events.find((event) => event.type === "message" && event.message?.role === "user")?.text).toBe(
		"Exercise each tool",
	);
	expect(events.findLast((event) => event.type === "message" && event.message?.role === "assistant")?.text).toBe(
		"All tools ran.",
	);
});
